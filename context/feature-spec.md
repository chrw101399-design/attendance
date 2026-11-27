# Feature Specification

**Project:** QR attendance system  
**Updated:** 2026-11-26 — F-010 mirror reliability implementation in progress
**Specification method:** FDD feature list + user-valued behavior; acceptance criteria use Given/When/Then. Implementation follows TDD Red-Green-Refactor.

## 1. Product model

### Users

- **Administrator:** one technical operator; manages events, sessions, rosters, QR display, review, and export.
- **Attendee:** scans event/session QR, selects a roster suggestion or self-registers when allowed, and submits attendance without an account.

### Core concepts

- **Event:** named dated conference/seminar/meeting with roster policy and lifecycle state.
- **Session:** an event segment (e.g. AM, PM, whole day) with opening/closing time and late grace period.
- **Attendee:** stable ID, display name, normalized search name, source (`import` or `self`), review state.
- **Attendance attempt:** append-only timestamped outcome for attendee/session, including duplicates and rejected requests.
- **Durable Object:** authoritative runtime state and atomic duplicate prevention.
- **Google Sheet:** human-readable mirror and export/review surface, not event-time source of truth.

### System invariants

1. At most one successful attendance per `(event_id, session_id, attendee_id)`.
2. Check-in/duplicate decision is serialized by the event Durable Object.
3. Every accepted, duplicate, and rejected attempt is auditable in the append-only log.
4. All stored timestamps are UTC; admin displays configured timezone (initial target: Asia/Manila).
5. A delayed/unavailable Sheets API cannot invalidate a successful Durable Object check-in; mirror lag is visible.
6. Admin writes require Cloudflare Access; attendee check-in does not require login.
7. Service-account keys, local secrets, and attendee PII never enter Git or context documents.
8. A feature is complete only when acceptance criteria pass and a regression check is recorded.

## 2. Feature list and acceptance criteria

### F-001 — Build local project foundation

**User value:** Administrator can build and run the application locally.

- Given dependencies are installed, when `npm run build` runs, then Next.js static assets and attendee bundles are generated successfully.
- Given type errors exist, when `npm run check` runs, then the command exits nonzero and identifies them.
- Given Worker runs locally, when `/api/health` is requested, then it returns a healthy JSON response.

**Status:** DONE for initial shell/build/typecheck. API runtime test pending on a runnable Worker command.

### F-002 — Generate starter Google Sheets workbook

**User value:** Administrator gets a ready-to-upload workbook without manually creating tabs or headers.

- Given `npm run template`, when generation completes, then `template/attendance-template.xlsx` exists and opens as an XLSX workbook.
- Workbook contains `README`, `Events`, `Attendees`, `Sessions`, `AttendanceLog`, and `Report` tabs with documented headers/formulas.
- A generated copy is available under `public/` for application download.
- Re-running generation produces a valid workbook from the checked-in schema.

**Status:** DONE for generation command/build. Workbook conversion and formula/data-validation behavior in Google Sheets need integration verification. Current generator is minimal; data validations are not yet implemented.

### F-003 — Connect Google Sheets using service account

**User value:** Administrator can verify the configured Sheet is accessible to the Worker.

- Given valid service-account credentials and spreadsheet ID, when `GET /api/health/sheets` runs, then Google returns the configured spreadsheet metadata and endpoint responds `200 {"ok":true,"service":"google-sheets"}`.
- Given the sheet is not shared to service-account email, then check fails clearly with permission error; no key or credential is returned to client.
- Given missing/invalid local secret, then endpoint fails safely with diagnostic error and does not expose secret contents.
- Given Google API is unavailable, health endpoint returns non-2xx and does not claim success.

**Current result:** DONE. After the sheet was shared with the service-account email as Editor, `GET /api/health/sheets` returned `200 {"ok":true,"service":"google-sheets"}`. Google Sheets connectivity is verified. Missing integration test: confirmed no secret/key contents leak to client in error responses. No key contents were recorded or committed.

### F-004 — Create and manage events and sessions

**User value:** Admin can create an event and configure one or more attendance sessions.

- Given valid event name/date and roster mode, when saved, then event has stable ID and starts in `planned` state.
- Given session label, start/end time, and grace period, when saved, then invalid ranges (end ≤ start, negative grace) are rejected.
- Given an event/session is changed, then Durable Object storage persists values across restart/eviction.
- Given unauthorized admin request, then it is rejected before state mutation.

**TDD cases before production implementation:** valid event persists; blank event name rejected; session end-before-start rejected; timezone inputs normalized to UTC; closed event cannot be opened for check-in.

### F-005 — Import attendee list from CSV/XLSX — DONE

**User value:** Admin can load roster from varied spreadsheet layouts without a fixed source CSV format.

- Given a CSV/XLSX file, when parsed, then admin previews rows and maps required `Name` plus optional email/phone/group columns.
- Given blank/invalid names, then rows are reported and skipped/rejected with counts before commit.
- Given an imported attendee matches existing normalized name plus optional stable identifier, then re-import keeps stable attendee ID rather than orphaning attendance.
- Given import is committed, then roster version increments and import source is recorded.
- Given replacement mode is selected, then destructive impact is explicitly confirmed before replacing roster.

**Implementation:** Browser parses CSV/XLSX; Worker commits validated rows atomically to event DO. Tests: `npm test` (16 pass), `npm run check`, `npm run build` (all pass).

### F-006 — Find roster attendee by type-ahead — DONE

**User value:** Attendee can quickly select own name from suggestions without typing a full name.

- Given the roster is available, when attendee types a prefix, then matching suggestions render accessibly and quickly.
- Given names collide, then suggestions show available disambiguating hint; no guess is silently selected.
- Given a roster update occurs, then client cache version can detect stale roster and refresh.
- Public roster endpoint exposes only fields needed for name selection (ID, display name, safe hint), not private source data.

**Implementation:** `GET /roster/selectable` on DO returns `{version, attendees:[{id,display,hint}]}` with ETag `roster-v{version}`. Worker route `GET /api/roster/selectable/:eventId` serves public endpoint with version/ETag. Admin wrapper `GET /api/admin/roster/:eventId/selectable` enforced by Access JWT. Client type-ahead wire up pending in attendee page next. Tests: `npm test` (17 pass), `npm run check`, `npm run build` all pass.

**Next (frontend):** wire selectable roster endpoint into attendee type-ahead UI with version/ETag cache refresh.

### F-007 — Generate QR and validate check-in token — DONE

**User value:** Admin displays or prints event/session QR without a third-party QR service.

**Implementation:** `worker/tokens.ts` signs rotating and static fallback tokens. `GET /api/token/:eventId/:sessionId` returns token and expiry; `QR_HMAC_SECRET` stays server-side. Tests cover tampering, event/session binding, expiry, tolerance, and fallback expiry. `npm test` 21 pass, `npm run check` pass, `npm run build` pass.

- Given an open session, when kiosk requests a token, then it receives signed token bound to event/session and expiry window.
- Given valid rotating token within configured clock tolerance, then token verifies.
- Given modified, expired, wrong-session, or invalid-signature token, then check-in is rejected and attempt is logged.
- Given static fallback token, then it is distinguishable in audit log and expires after configured fallback period.
- QR encodes short URL and renders on kiosk without exposing HMAC secret.

### F-008 — Check in attendee once per session — DONE

**User value:** Attendee receives immediate confirmation and cannot create duplicate present records for same session.

**Implementation:** `worker/checkin.ts` decides token/window/duplicate outcomes. DO transaction persists `attendanceByKey`, `checkInRequests`, and `attendanceLog`; Worker exposes `POST /api/checkin`. Tests: 27 pass; type check and build pass.

- Given valid token, open session, and known attendee not yet present, when submitted, then exactly one `present` or `present_late` attendance is recorded.
- Given same attendee/session submits again (including concurrent submissions), then result is `duplicate`; there remains exactly one successful attendance.
- Given closed/out-of-window/invalid token, then no successful present row is created and rejection is auditable.
- Given request retries with same client request ID, then request is idempotent.
- Given late submission inside accepted grace window, then it is accepted and marked late per policy.

### F-009 — Self-register walk-in and resolve name collisions — DONE

**User value:** Attendee without an imported roster entry can register when event policy permits.

**Implementation:** `resolveSelfRegistration` handles policy gates, exact identity confirmation, and review collisions. DO `POST /self-register` persists new attendees atomically; Worker exposes `POST /api/self-register`. Tests: 31 pass; type check and build pass.

- Given roster mode is `closed`, then self-registration is unavailable.
- Given mode is `hybrid` or `open` and registration switch enabled, when a unique name is submitted, then attendee is created and checked in with source `self`.
- Given exact or near duplicate name exists, then attendee must confirm existing identity or explicitly choose different-person path.
- Given different-person path creates collision, then record is marked for admin review.
- Given rate limit/cap is exceeded or registration switch closed, then registration is rejected without creating attendee.

### F-010 — Mirror Durable Object log to Sheets

**User value:** Admin can review current roster and attendance in Sheets without risking event-time check-ins.

- Given pending events in Durable Object outbox, when mirror flush succeeds, then rows are appended once and outbox cursor advances.
- Given Sheets API fails, then source records remain durable, retries use backoff, check-ins continue, and lag is observable.
- Given a flush retries after uncertain response, then idempotency prevents duplicated mirror rows.
- Given lag exceeds threshold, then admin receives visible warning; after recovery, lag clears when caught up.
- Never delete outbox rows until mirror write has been verified/idempotently committed.

**Implementation decisions (2026-11-26):** The visible lag warning threshold is five minutes. Scheduled flushing continues to use the comma-separated `MIRROR_EVENT_IDS` Wrangler variable; each event ID to be mirrored must be listed there. Source rows and their `MirrorIndex` IDs are written in one atomic Sheets batch. F-010 remains in progress until a safe end-to-end flush and retry are verified against the deployed Worker and spreadsheet.

### F-011 — Admin workflow and export

**User value:** Single admin can operate an event and retrieve reviewable records.

- Admin can view/create events, manage sessions, open/close check-in, and toggle self-registration.
- Admin can see live counts and mirror health.
- Admin can review collisions and merge records while preserving audit history.
- Admin can export event/session attendance as CSV with source/review flags.
- Admin pages and admin APIs are protected by Cloudflare Access.

### F-012 — Deploy to Cloudflare from GitHub

**User value:** Admin can publish updates by pushing tested changes to GitHub.

- Given `main` branch build succeeds, Cloudflare Workers Builds deploys Worker and static assets.
- Secrets are configured through Cloudflare, not committed to GitHub.
- Admin URL is protected by Access allowlist; public attendee routes remain accessible.
- Deployment verifies health endpoints and correct static routing.

### F-013 — Prepare release and event operations

**User value:** System is rehearsed and recoverable before a real event.

- 500 simulated/concurrent submissions produce no duplicate successful attendance.
- Sheet outage during load does not lose Durable Object records; mirror catches up after recovery.
- Durable Object restart/eviction test confirms persisted state recovery.
- Event-day runbook covers T-30, live monitoring, fallback desk process, close-out/export/archive.
- Final rehearsal checks actual mobile devices and venue/mobile-data access.

## 3. TDD feature template

Copy per behavior before coding:

```md
### Test case: <observable behavior>
- Requirement: F-XXX / acceptance criterion
- Given: <starting state>
- When: <user/system action>
- Then: <observable result>
- Test command: `<exact command>`
- Red observed: <expected failing result before implementation>
- Green observed: <passing result after minimum implementation>
- Refactor/regression: <checks rerun and result>
```

For each production behavior, start with one failing test. Use Arrange–Act–Assert (or Given–When–Then), assert public outcomes rather than internals, implement minimum change, then refactor with suite green. Infrastructure integration tests may use explicit live credentials only in local ignored env and must never print credentials.

## 4. FDD feature record template

```md
### F-XXX — <verb + result + business object>
- Subject area: <area>
- Feature set: <activity>
- User value: <outcome>
- Priority: P0/P1/P2
- Dependencies: <feature IDs>
- Status: TODO / IN PROGRESS / BLOCKED / DONE
- Design: <small design decision(s), routes/data/permissions>
- Acceptance criteria: Given / When / Then bullets
- Tests: <test cases and command/results>
- Implementation log: <files changed, decision, date>
- Risks/open questions: <items>
```

## 5. Sources and method basis (checked 2026-11-18)

- GitHub Docs, **Ignoring files**: repository `.gitignore` distributes ignore rules; already tracked secrets require untracking and rotation. https://docs.github.com/en/get-started/getting-started-with-git/ignoring-files
- Git documentation, **gitignore**: pattern behavior and rule precedence. https://git-scm.com/docs/gitignore
- UK Government Digital Service, **Test-driven development**: Red–Green–Refactor cycle and behavior-first tests. https://gds-way.digital.cabinet-office.gov.uk/standards/test-driven-development.html
- Martin Fowler, **Test Driven Development**: test list, test first, production code until pass, refactor. https://martinfowler.com/bliki/TestDrivenDevelopment.html
- The Agile Handbook, **The FDD Process (10 Nov 2026)**: five FDD processes; feature decomposition as action/result/object and planning by dependencies. https://theagilehandbook.com/blog/feature-driven-development-process/

**Application:** combine FDD for feature inventory/planning/progress visibility with TDD for behavior changes. FDD examples are mainly team-scale; adapt lightly for one developer and keep documentation focused on observable features, acceptance criteria, test evidence, and decisions.

## 6. Implementation log (feature-by-feature)

### 2026-11-17 — F-001 project foundation

- Added Next.js static export admin shell, Cloudflare Worker, Durable Object stub, Wrangler config, vanilla attendee/kiosk entry points, package scripts, README starter.
- `npm run build` PASS. `npm run check` PASS. Dependency install reported four audit vulnerabilities; not yet remediated for production.

### 2026-11-17 — F-002 template workbook generation

- Added shared sheet header/enumeration constants in `worker/types.ts`.
- Added `npm run template` generating `template/attendance-template.xlsx` and public downloadable copy.
- Workbook contains README, Events, Attendees, Sessions, AttendanceLog, Report tabs.
- `npm run template` PASS. `npm run build` PASS. `npm run check` PASS.

### 2026-11-18 — F-003 Google Sheets service-account scaffold

- Configured user-provided spreadsheet ID as `vars.SHEET_ID` in `wrangler.jsonc`.
- Added service-account JWT token flow in `worker/sheets.ts` and `GET /api/health/sheets`.
- Added `.dev.vars.example` and setup instructions in README.
- User created Google service account/key. Local key file currently `secrets/service-account.json.json`; encoded into ignored `.dev.vars` without response display.
- `npx wrangler dev --local` started at `http://127.0.0.1:8788`.
- `GET /api/health/sheets` returned Google `403 PERMISSION_DENIED`. F-003 is BLOCKED until sheet is shared with service-account email as Editor.
- Security remediation recommended but not completed: revoke exposed key, create replacement in `secrets/`, regenerate `.dev.vars` without displaying key. No key contents recorded here.

### 2026-11-26 — F-010 mirror reliability in progress

- Added atomic Sheets batch writes for source rows and `MirrorIndex`, including automatic creation of a missing index tab and migration of legacy `mirror_id` headers.
- Added change-aware roster mirroring, aggregate Access-protected status, a five-minute warning in the admin page, and the five-minute DO claim lease.
- Updated the generated workbook schema and operations instructions for the configured event list.
- `npm test` — PASS: 39 tests. `npm run check` — PASS. `npm run build` — PASS. `npm run template` — PASS; verified generated mirror tabs/headers. `npx wrangler deploy --dry-run` — PASS.
- Deployed production version `673c713b-faf9-4b17-853e-7ef5eec727a7` on 2026-11-27. Live Sheets health returned OK; aggregate status and admin page showed `event-test` caught up with zero pending.
- No production test row was created. User chose to defer data-writing verification until an isolated test sheet/event is available; live mirror write, uncertain-response retry, and lag recovery remain unverified.

F-004 through F-009 implementation history and current backlog are maintained in `context/progress-tracker.md`. F-011 through F-013 remain to be implemented.
