# Progress Tracker

**Project:** QR attendance system  
**Updated:** 2026-11-27
**Method:** Feature-driven development (FDD) with test-driven development (TDD) per feature.  
**Status legend:** `TODO` · `IN PROGRESS` · `BLOCKED` · `DONE`

## Working agreement

1. Keep this tracker current after each implementation step in this chat.
2. Add features to `feature-spec.md` before implementation; do not silently change acceptance criteria.
3. For behavior changes, use TDD: write a failing test (Red), minimum passing code (Green), refactor while tests pass.
4. Mark `DONE` only after acceptance criteria pass and record exact test command/result.
5. Record decisions, deviations, blockers, and relevant user confirmations below.
6. Do not copy secrets, personal attendee data, or service-account key contents into context files.

## Overall FDD progress

| FDD process | Status | Output |
|---|---|---|
| Develop overall model | DONE | Attendance domain and architecture captured in approved plan and `feature-spec.md` |
| Build feature list | DONE | Feature IDs and acceptance criteria in `feature-spec.md` |
| Plan by feature | IN PROGRESS | Ordered backlog below; update estimates/dependencies as work proceeds |
| Design by feature | IN PROGRESS | Record feature-specific design decisions before implementation |
| Build by feature | IN PROGRESS | Next feature: F-012 Deploy to Cloudflare from GitHub |

## Feature backlog

| ID | Feature | Priority | Status | Depends on |
|---|---|---:|---|---|
| F-001 | Build local Next.js/Worker project foundation | P0 | DONE | — |
| F-002 | Generate Google Sheets template workbook | P0 | DONE | F-001 |
| F-003 | Connect service account to Google Sheets and verify access | P0 | DONE | F-002; resolved after sheet shared as Editor |
| F-004 | Create/manage events and sessions in Durable Object | P0 | DONE | F-003 |
| F-005 | Import attendee CSV/XLSX with column mapping | P0 | DONE | F-004 |
| F-006 | Publish attendee roster and type-ahead selection | P0 | DONE | F-005 |
| F-007 | Generate and validate rotating/static QR tokens | P0 | DONE | F-004 |
| F-008 | Check in attendee once per session; log duplicates | P0 | DONE | F-006, F-007 |
| F-009 | Self-register walk-ins and resolve name collisions | P1 | DONE | F-008 |
| F-010 | Mirror Durable Object events to Sheets with retry/lag status | P0 | DONE | F-003, F-008 |
| F-011 | Admin event/session/import/review/export UI | P1 | IN PROGRESS | F-004–F-010 |
| F-012 | Secure admin with Cloudflare Access and deploy from GitHub | P0 | IN PROGRESS | F-011 |
| F-013 | Event runbook, load/failure rehearsal, release readiness | P0 | TODO | F-012 |

## Implementation log

### 2026-11-17 — project foundation (F-001)

- Added Next.js static export admin shell, Cloudflare Worker, Durable Object stub, Wrangler config, and vanilla attendee/kiosk entry points.
- Added package scripts and README starter.
- `npm run build` — PASS.
- `npm run check` — PASS.
- Dependency install reported four audit vulnerabilities; review before production deploy.

### 2026-11-17 — Google Sheets template (F-002)

- Added shared sheet header/enumeration constants in `worker/types.ts`.
- Added `npm run template`, generating `template/attendance-template.xlsx` and public downloadable copy.
- Workbook includes README, Events, Attendees, Sessions, AttendanceLog, Report tabs.
- `npm run template` — PASS.
- `npm run build` — PASS.
- `npm run check` — PASS.

### 2026-11-18 — Sheets API auth scaffold (F-003; resolved)

- User supplied a spreadsheet ID; configured as `vars.SHEET_ID` in `wrangler.jsonc`.
- Added service-account JWT token flow in `worker/sheets.ts` and `GET /api/health/sheets`.
- Added `.dev.vars.example` and setup instructions in README.
- User created a Google service account and key. Local key file currently has name `secrets/service-account.json.json`; local secret was encoded into ignored `.dev.vars` without printing it in response.
- `npx wrangler dev --remote` could not start: no Cloudflare login/API token. `npx wrangler dev --local` started at `http://127.0.0.1:8788`.
- Sheet was shared as Editor with the service-account email; spreadsheet access permission resolved.
- `GET /api/health/sheets` returned `200 {"ok":true,"service":"google-sheets"}`.
- Security note: key material appeared in local tool output during troubleshooting. Recommended action: revoke that key, create replacement, place it in `secrets/`, regenerate `.dev.vars` without displaying key. Do not copy key contents here or commit them.
- Completed without additional changes: no key rotation required if key remains access-compatible. If rotating the key later, update `secrets/service-account.json`, regenerate `.dev.vars` via PowerShell, and re-test health endpoint.

### 2026-11-18 — credential ignore rules

- Updated root `.gitignore` to ignore `/secrets/`, service-account/credential JSON patterns, `.dev.vars*`, `.env*`, and private key files.
- Git repository is not initialized yet, so ignore rules are in place locally for future commits; verify with `git check-ignore` after repository creation.
- No previously committed files were tracked by Git, so no untrack action was required.

### 2026-11-18 — F-004 implementation

- Added shared event/session validation logic in `worker/validation.ts`: `validateEvent`, `validateSession`, `normalizeEventDate`.
- Validation covers: blank event name rejected, invalid rosterMode/status rejected, date format checks, event end-before-start rejected, negative grace rejected, invalid datetimes rejected, ISO 8601 UTC parsing.
- Added `npm test` using Node built-in test runner; added failing-before-passing TDD cases to `tests/validation.test.ts`.
- Fixed test import path; fixed session status validation so optional status field accepts valid values when omitted.
- `npm test` — PASS: 11 tests, 0 fail.
- Added `npm run build` integration step; allowed TypeScript extension imports in worker module for local Node test runner compatibility.
- Fixed Next build type-check errors from strict worker typing: validate eventDate as string before use, guard optional status field.
- `npm run build` — PASS. Static admin pages generated successfully.
- Status: DONE. Local Worker binds and health endpoint verified; full DO and Sheets runtime endpoints pending later features.

### 2026-11-18 — F-005 implementation

- Added `worker/roster.ts`: `normalizeAttendeeName`, `planRosterImport`, `commitRosterImport`.
- Import matching: stable identifier (email, else phone) first, then normalized name; duplicate names inside one file counted `invalid`; blank name rows counted `blank`; >200 chars or control characters counted `invalid`.
- Re-import keeps existing `attendeeId` so attendance rows do not orphan; `rosterVersion` increments on every commit.
- `replace` mode throws without `confirmReplace: true`; replaced attendees stay in storage with `activeAttendeeIds` narrowed, so history is preserved.
- Added `POST /roster/import` on `EventDurableObject` using `storage.transaction`; validates JSON, ≤10,000 rows, ≤100 columns, ≤10,000 chars/cell; 409 when replace confirmation missing.
- Added `POST /api/admin/events/:eventId/roster/import` in `worker/index.ts`, gated by `verifyAccessJwt` (`Cf-Access-Jwt-Assertion`, RS256 via `/cdn-cgi/access/certs`, `aud`/`iss`/`exp` checks, 5-minute key cache) in `worker/access.ts`.
- Admin UI `app/admin/page.tsx` is now a client importer: client-side PapaParse CSV + SheetJS XLSX parsing, header auto-detect with fallback to `Column N`, 5-row preview, column mapping (Name required), merge/replace mode, replace confirmation checkbox, result counts.
- Added `papaparse`, `xlsx`, `@types/papaparse`.
- `npm test` — PASS: 16 tests, 0 fail (5 new roster tests).
- `npm run check` — PASS.
- `npm run build` — PASS; `/admin` static page 119 kB (SheetJS is the bulk).
- Not executed live: import route needs `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` vars; unset means 401 by design. Live end-to-end test waits on F-012 Access setup.

### 2026-11-18 — F-006 implementation

- `GET /roster/selectable` on `EventDurableObject` returns `{version, attendees:[{id,display,hint}]}` via `selectableRosterFields` in `worker/roster.ts`, exposing only name-selection fields (ID, display, hint) plus `version`/`ETag`.
- `worker/index.ts`: public `GET /api/roster/selectable/:eventId` and admin-wrapped `GET /api/admin/roster/:eventId/selectable` (Access JWT enforced) both proxy to DO selectable endpoint with version/ETag headers.
- Added `selectableRosterFields` test in `tests/roster-f006.test.ts`.
- `npm test` — PASS: 17 tests, 0 fail.
- `npm run check` — PASS.
- `npm run build` — PASS.

### 2026-11-18 — F-007 implementation

- Added `worker/tokens.ts`: signed rotating token generation, static fallback generation, expiry, clock tolerance, event/session binding, tamper rejection.
- Added DO `GET /token` and public Worker `GET /api/token/:eventId/:sessionId`; token secret stays in Worker environment and is never sent from client input.
- Added `tests/tokens.test.ts`: valid signature, tamper, wrong event/session, expiry, tolerance, static fallback expiry.
- `npm test` — PASS: 21 tests, 0 fail.
- `npm run check` — PASS.
- `npm run build` — PASS.
- Note: QR image rendering and kiosk UI remain part of later admin/check-in work. Token endpoint currently needs `QR_HMAC_SECRET` configured.

### 2026-11-18 — F-008 implementation

- Added `worker/checkin.ts`: server-side check-in decision logic for known attendees, token validation, session window, grace-period late status, duplicates, and request idempotency.
- Added DO `POST /checkin`: Durable Object transaction atomically checks `(sessionId, attendeeId)`, stores one successful attendance, stores request results, and appends audit log records.
- Added public Worker `POST /api/checkin`; HMAC secret injected server-side from `QR_HMAC_SECRET`, never accepted from caller.
- Added `tests/checkin.test.ts`: present, duplicate, client request retry, invalid token, closed session, late grace acceptance.
- `npm test` — PASS: 27 tests, 0 fail.
- `npm run check` — PASS.
- `npm run build` — PASS.

### 2026-11-18 — F-009 implementation

- Added `resolveSelfRegistration` in `worker/roster.ts`: closed mode and disabled registration reject; hybrid/open create source `self`; exact normalized matches require explicit confirmation; different-person path creates `needsReview` collision.
- Added DO `POST /self-register` with transactional attendee and active roster persistence plus rosterVersion increment.
- Added public Worker `POST /api/self-register`.
- Added `tests/self-register.test.ts`: closed rejection, create, exact match confirmation, collision review.
- `npm test` — PASS: 31 tests, 0 fail.
- `npm run check` — PASS.
- `npm run build` — PASS.

### 2026-11-18 — initial F-010 implementation

- Added durable DO `mirrorOutbox` rows for self-registration and every check-in audit record, written in the same transaction as source state.
- Added DO `/mirror/claim`, `/mirror/ack`, `/mirror/status` routes, Worker internal mirror routes, Access-protected status, internal-secret protection, and one-minute scheduled flushing.
- Initial retry/index behavior was not safe against an uncertain data append, and roster imports were not mirrored. Reliability work is recorded below.

### 2026-11-26 — F-010 reliability and status work

- Decision confirmed: warn at five minutes of oldest pending lag; keep `MIRROR_EVENT_IDS` as the explicit comma-separated cron registry.
- Replaced separate data/index appends with one atomic Sheets `batchUpdate`; retries skip IDs already in `MirrorIndex`. The Worker creates a missing index tab and repairs the missing `mirror_id` headers in existing generated sheets.
- Increased claim lease to five minutes, retained exponential retry backoff, and changed lag reporting to include rows waiting for retry.
- Wired roster imports into the outbox with event IDs and only enqueues changed attendee data; changed attendee versions get distinct mirror IDs so an update is not suppressed by an earlier index entry.
- Added Access-protected aggregate mirror status and a 30-second admin status panel with warning/error/caught-up states. The importer selects from the configured event list.
- Updated the workbook generator and shared schema with `MirrorIndex` and both `mirror_id` columns.
- `npm test` — PASS: 39 tests. `npm run check` — PASS. `npm run build` — PASS. `npm run template` — PASS; verified `MirrorIndex` and `mirror_id` headers in the generated workbook. `npx wrangler deploy --dry-run` — PASS.
- Deployed to production on 2026-11-27 as version `673c713b-faf9-4b17-853e-7ef5eec727a7`. Live `GET /api/health/sheets` returned OK; `/api/admin/mirror-status` returned `event-test` with zero pending, and `/admin` displayed “Mirror is caught up.”
- No production row was created or flushed. User chose to keep production data untouched and defer the end-to-end write/retry test until an isolated test sheet/event is available; F-010 remains IN PROGRESS.
- Scope note: the current Durable Object has no event/session mutation endpoints, so those records cannot yet be mirrored; this implementation covers current attendee and attendance writes.

### 2026-11-27 — F-010 isolated staging verification (DONE)

- Deployed `attendance-staging` using `wrangler.staging.jsonc` and the isolated test spreadsheet/event only; deployment version `230eae3c-dabe-4973-8295-acfb800a7623`.
- Configured staging-only Google Sheets, QR, mirror-internal, and Access secrets. Added staging admin destinations to the existing Attendance Admin Access app while preserving its production destinations and Allow policy.
- `npm run build` — PASS. `npx wrangler deploy --config wrangler.staging.jsonc` — PASS.
- Live `/api/health`, `/api/health/do`, and `/api/health/sheets` checks passed. Unauthenticated staging admin routes redirect to Cloudflare Access; authenticated `/admin` showed zero pending rows.
- Created two clearly synthetic attendees for `f010-test-20261127`. Verified exactly two attendee rows and two corresponding `MirrorIndex` entries in the test workbook.
- Retry rehearsal: temporarily configured an invalid Google credential in staging only; flush returned 503 and re-queued the row. Restored the valid credential; retry returned `claimed=1, written=1, skipped=0, failed=0`. Confirmed the source and index rows were written once, with zero pending afterward.
- This live failure rehearsal failed before the Google write; the uncertain-response-after-commit case remains covered by the existing `tests/mirror.test.ts` pipeline test.
- Production Worker and production sheet were not modified or written to. F-010 acceptance is complete.
- Scope note: the current Durable Object has no event/session mutation endpoints, so those records cannot yet be mirrored; this implementation covers current attendee and attendance writes.

### 2026-11-27 — F-011 admin workflow and export (DONE)

- Added event and session management, live counts, mirror-health review, collision review and merge, roster import, attendance review, and CSV export to the Access-protected `/admin` console.
- Added Access-protected event/session/summary/attendance/collision/merge/export and roster-import routes in `worker/index.ts`.
- Added Durable Object event, session, collision, merge, summary, attendance, and CSV export behavior in `worker/event-do.ts`.
- Added `tests/event-admin.test.ts` and `tests/event-model.test.ts` coverage for authoritative event/session state, collision merge/audit preservation, and export source/review flags.
- `npm test` — PASS: 43 tests, 0 fail.
- `npm run check` — PASS.
- `npm run build` — PASS; `/admin` generated successfully.
- Live staging health endpoints `/api/health`, `/api/health/do`, and `/api/health/sheets` returned `200`.
- Live staging `/admin` returned `302` to Cloudflare Access, confirming unauthenticated access is gated.
- F-011 acceptance implementation is complete; authenticated end-to-end admin mutations remain available for live sign-in verification.

### 2026-11-27 — F-012 implementation started

- Added `.github/workflows/deploy.yml` for pull-request verification and successful `main` deployment.
- CI runs `npm ci`, `npm test`, `npm run build`, `npm run check`, and `npx wrangler deploy --dry-run`.
- Deployment runs only after verification passes and uses GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Added `scripts/verify-deployment.mjs`; checks `/api/health`, `/api/health/do`, `/`, and Cloudflare Access redirects for `/admin` and `/api/admin/events`.
- Added `npm run verify:deployment` and README setup for GitHub Actions, Wrangler secrets, and Access route policy.
- Added explicit Worker `/admin`, `/admin/`, and `/admin/*` Access checks; API checks remain in route handlers.
- No credentials added to repository.
- Local checks: `npm test` — PASS: 43 tests; `npm run build` — PASS; `npm run check` — PASS; `npx wrangler deploy --dry-run` — PASS.
- F-012 remains IN PROGRESS until repository push, GitHub secrets/environment setup, Access allowlist validation, and deployed checks pass.

### F-013

F-013 starts after F-012 deployment verification.

## Current next actions

1. Begin F-012 using the acceptance criteria in `feature-spec.md`.
2. Keep Access secrets and Google credentials out of source/context.

## Decisions and deviations

- Runtime: Cloudflare Worker + Durable Object; Sheets is mirror, not authoritative runtime storage.
- Frontend: Next.js App Router static export, built with `npm run build`; attendee/kiosk use vanilla bundle.
- Repository target: GitHub; current workspace is not initialized as a Git repository yet.
- Local Windows developer environment. Use PowerShell-compatible commands and paths.
- Development rule clarified by current request: log each feature implementation and important verification result in this file and keep feature acceptance criteria in `feature-spec.md`.
