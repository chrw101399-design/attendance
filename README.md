# Attendance system

Cloudflare Worker + Durable Object backend, Next.js static admin panel, and a durable Google Sheets mirror.

## Step 1: local foundation

```powershell
npm install
npm run build
npm run check
npx wrangler dev --remote
```

Open `http://localhost:8787/admin`.

Health checks:

- `GET /api/health`
- `GET /api/health/do`

## Step 2: template spreadsheet

Template created at `template/attendance-template.xlsx` and copied to `public/attendance-template.xlsx`.

Regenerate after schema changes:

```powershell
npm run template
```

Use it:

1. Upload `template/attendance-template.xlsx` to Google Drive.
2. Right-click file. Select **Open with → Google Sheets**.
3. Select **File → Save as Google Sheets**.
4. Copy spreadsheet ID from URL: value between `/d/` and `/edit`.
5. Replace `SHEET_ID` in `wrangler.jsonc`.

Do not manually edit `Attendees`, `AttendanceLog`, or `MirrorIndex` while an event is live. Durable Objects are runtime truth; Sheets are mirrors.

## Step 3: connect Google Sheets

### 1. Create Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select project menu. Click **New Project**.
3. Name it `attendance-system`. Click **Create**.
4. Open **APIs & Services → Library**.
5. Search `Google Sheets API`. Open it. Click **Enable**.

### 2. Create service account key

1. Open **APIs & Services → Credentials**.
2. Click **Create Credentials → Service account**.
3. Name it `attendance-sheet-writer`. Click **Create and Continue**.
4. Skip role assignment. Click **Done**.
5. Open newly created service account.
6. Open **Keys → Add Key → Create new key → JSON → Create**.
7. Save downloaded file as `secrets/service-account.json`. Never commit it.
8. Copy its `client_email` value.

### 3. Share spreadsheet

Open converted Google Sheet. Click **Share**. Paste service account `client_email`. Select **Editor**. Disable notification. Click **Share**.

### 4. Local secret

Create `.dev.vars` from example:

```powershell
Copy-Item .dev.vars.example .dev.vars
$bytes = [IO.File]::ReadAllBytes("secrets/service-account.json")
[Convert]::ToBase64String($bytes)
```

Paste output after `GOOGLE_SA_JSON_B64=` in `.dev.vars`.

Start Worker, then test connection:

```powershell
npm run build
npx wrangler dev --remote --env development
```

Open `http://localhost:8787/api/health/sheets`.

Expected:

```json
{"ok":true,"service":"google-sheets"}
```

Common errors:

- `403 PERMISSION_DENIED`: Sheet not shared with service account email.
- `403 SERVICE_DISABLED`: Google Sheets API not enabled in same Google Cloud project.
- `GOOGLE_SA_JSON_B64 secret is missing`: `.dev.vars` absent or value empty.

## Step 4: operate the Durable Object mirror

- `MIRROR_EVENT_IDS` in `wrangler.jsonc` is the comma-separated list of event IDs the one-minute cron flushes. Add each event ID that should be mirrored; the admin roster-import event selector uses this same list.
- Attendance attempts and attendee changes are queued in the event Durable Object transaction, so Sheets outages do not block check-ins.
- Each source-row append and its `MirrorIndex` entry are written in one atomic Sheets batch. Retries check the index before writing, and failed attempts use exponential backoff.
- The admin page shows pending counts and lag, and raises a visible warning when the oldest queued row is at least five minutes old.
- The Worker creates `MirrorIndex` if it is absent and adds the `mirror_id` header to older generated `Attendees` / `AttendanceLog` sheets. The service account needs Editor access for this setup.

Run local checks with `npm test` and `npm run check`. A production mirror flush should only be tested with a safe test event and a verified spreadsheet row.

## Live and deployed links

Production Worker:

- [Production home](https://attendance.chr-w-10-13-99.workers.dev/)
- [Admin console](https://attendance.chr-w-10-13-99.workers.dev/admin) — Cloudflare Access required
- [Attendee check-in](https://attendance.chr-w-10-13-99.workers.dev/checkin.html)
- [Kiosk](https://attendance.chr-w-10-13-99.workers.dev/kiosk.html)
- [Health](https://attendance.chr-w-10-13-99.workers.dev/api/health)
- [Durable Object health](https://attendance.chr-w-10-13-99.workers.dev/api/health/do)
- [Sheets health](https://attendance.chr-w-10-13-99.workers.dev/api/health/sheets) — admin/diagnostic use
- [Attendance template](https://attendance.chr-w-10-13-99.workers.dev/attendance-template.xlsx)

Public API routes:

- `GET /api/roster/selectable/:eventId`
- `GET /api/token/:eventId/:sessionId`
- `POST /api/checkin`
- `POST /api/self-register`

Admin API routes — Cloudflare Access required:

- `GET /api/admin/events`
- `GET|PUT /api/admin/events/:eventId`
- `GET|POST /api/admin/events/:eventId/sessions`
- `PATCH /api/admin/events/:eventId/sessions/:sessionId`
- `GET /api/admin/events/:eventId/summary`
- `GET /api/admin/events/:eventId/attendance`
- `GET /api/admin/events/:eventId/collisions`
- `POST /api/admin/events/:eventId/attendees/:attendeeId/merge`
- `GET /api/admin/events/:eventId/export`
- `POST /api/admin/events/:eventId/roster/import`
- `GET /api/admin/events/:eventId/mirror-status`
- `GET /api/admin/mirror-status`

Staging deployment:

- Worker name: `attendance-staging`
- URL: configure after staging deploy; do not infer URL from production
- Config: `wrangler.staging.jsonc`
- Staging event: `f010-test-20261127`

Internal Durable Object URLs such as `https://event.internal/...` are Worker-to-DO addresses, not browser links.

## Step 5: GitHub and Cloudflare deployment

Repository setup:

1. Create GitHub repository.
2. Keep `/secrets/`, `.dev.vars`, and `.env*` local. Never commit credentials.
3. Push `main`.

Cloudflare setup:

1. Create API token with Workers Scripts edit, Workers KV/Durable Objects edit, and account read permissions for target account.
2. Add GitHub repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Add GitHub `production` environment variable:
   - `DEPLOY_URL=https://your-domain.example`
4. Add Cloudflare Worker secrets outside GitHub Actions:

```powershell
npx wrangler secret put GOOGLE_SA_JSON_B64
npx wrangler secret put QR_HMAC_SECRET
npx wrangler secret put MIRROR_INTERNAL_SECRET
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are runtime variables used to verify Cloudflare Access JWTs. Configure Access before exposing `/admin`.

GitHub Actions in `.github/workflows/deploy.yml` runs tests, build, type check, Wrangler dry run, then deploys only successful `main` pushes. Deployment verification checks:

- `/api/health`
- `/api/health/do`
- `/`
- unauthenticated `/admin` redirect to Access
- unauthenticated `/api/admin/events` redirect to Access

Run verification locally:

```powershell
$env:DEPLOY_URL = "https://your-domain.example"
$env:ADMIN_EXPECT_ACCESS = "true"
npm run verify:deployment
```

Access policy:

- Protect `/admin*` and `/api/admin/*` with an Access application.
- Allow only admin email or approved group.
- Keep `/`, `/api/checkin`, `/api/self-register`, `/api/roster/*`, and `/api/token/*` public.
- Do not put Google service-account credentials or Access secrets in GitHub variables that are exposed to browser code.

## F-013 event-day runbook

Use staging event `f010-test-20261127` and staging Sheet for rehearsal. Never use production attendee data for rehearsal. Durable Object state is authoritative; Google Sheets is mirror only.

### T-30

1. Confirm deployment commit, `/api/health`, `/api/health/do`, and Access-protected `/admin` respond as expected.
2. Confirm event date, roster import, session times, timezone, registration policy, and QR fallback token.
3. Open staging admin. Check attendee count, session status, and mirror status: pending `0`, warning `false`.
4. Test one synthetic check-in on two phones over venue Wi-Fi and mobile data. Verify attendee selection, success screen, duplicate retry, and admin live count.
5. Keep fallback desk materials ready: printed roster, session QR URL/token, operator phone, and event/session IDs. Do not record secrets on paper.

### Live monitoring

- Admin watches live counts, duplicate/rejected results, and mirror pending/lag status.
- Durable Object remains source of truth during Sheets outage. Do not edit `Attendees` or `AttendanceLog` Sheets during event.
- If mirror warning reaches five minutes, record time and continue check-in; retry mirror after connectivity or credential recovery.
- Stop opening new sessions if health or Durable Object checks fail. Preserve current session and contact operator.

### Fallback desk process

1. Verify attendee identity against printed roster or admin roster.
2. Record event ID, session ID, attendee ID/name, UTC/local time, and reason on controlled desk sheet.
3. Do not claim manual entries are authoritative. After service recovery, submit each attendance once through public flow or reconcile through admin review.
4. Escalate repeated failures, duplicate conflicts, or unknown attendees to admin. Preserve desk records for close-out.

### Close-out, export, archive

1. Close session and stop new check-ins. Confirm final live counts and unresolved collisions.
2. Wait for mirror pending count to reach `0`; if Sheets remains down, retain Durable Object as authority and document lag.
3. Download admin attendance CSV. Check row count, duplicate/rejected audit rows, source, and review flags.
4. Archive CSV, incident notes, fallback desk records, deployment commit, and mirror status snapshot in restricted event storage.
5. Export or archive the Google Sheet after mirror catch-up. Keep raw records read-only; never delete Durable Object data as part of archive.

### F-013 rehearsal checklist

Run local regression:

```powershell
npm test
npm run check
npm run build
```

Run staging rehearsal with synthetic event data:

```powershell
npx wrangler deploy --config wrangler.staging.jsonc
```

Manual acceptance requires two or more real phones, venue Wi-Fi, mobile data, QR scan, roster selection, duplicate retry, late check-in, admin counts, Sheets outage/recovery, CSV export, and archive review. Record result and timestamp in release notes. Do not mark F-013 complete until attendee-facing check-in UI and scannable QR display work on those devices.

## User manual: Admin console

The admin console is a single page at `/admin`, protected by Cloudflare Access.
Sign in with an email allowed by the Access policy. The page is arranged into
sections for **Event**, **Sessions**, **Live counts**, **Attendance review**,
**Collision review**, and **Roster import**. Select an event at the top to
review and operate on it; the sections below refresh for that event.

### 1. Create or select an event

In **Event**, use the dropdown to select an existing event or choose **New
event**. For a new event, enter its name and date, choose the roster mode, and
leave **Status** as `planned` while setting it up. Select **Save event**.

New event IDs are generated as `evt_YYYYMMDD` from the event date. Use only one
new event per date; creating another for the same date can reuse that ID.
Selecting an existing event loads its settings into the form; save after
changing those settings.

Choose the roster mode based on how attendees will be added:

- `closed`: use an imported roster; do not enable self-registration.
- `hybrid`: use an imported roster and optionally allow walk-ins by enabling
  **Self-registration open**.
- `open`: allow self-registration only when **Self-registration open** is
  enabled.

Only enable self-registration if you intend to accept registrations through
the public registration flow.

### 2. Import an attendee roster

Select the event first, then open **Roster import**:

1. Choose a CSV, XLS, or XLSX file. For a workbook, the first worksheet is
   used. Files can contain up to 10,001 rows total and 100 columns.
2. Map **Name** to the column containing each attendee's name. Name is
   required. Map **Email**, **Phone**, and **Group** if those columns are
   present; common header names may be detected automatically.
3. Use **Merge** for routine additions or updates. It matches existing
   attendees where possible and adds new records.
4. Use **Replace** only when the file is the complete, authoritative roster.
   It requires **Confirm replacement** and can deactivate attendees not in the
   uploaded file.
5. Select **Import roster** and review the result message, counts, and mirror
   status.

Imported attendee data is also sent to the configured Google Sheets mirror.
Do not manually edit the mirror sheets while an event is live. If the pending
count or lag remains elevated, check the mirror/health configuration before
relying on the spreadsheet as up to date.

### 3. Create and manage sessions

In **Sessions**, enter a label, start time, end time, and grace period in
minutes, then select **Create session**. The date/time fields use the browser's
local timezone; the application stores the values in UTC.

Each created session has an **Open** or **Close** control. Keep sessions
planned/closed during setup, and open or close them deliberately when managing
the event. The event's status and a session's open/closed status are separate
controls.

**Open QR kiosk** opens a scannable QR image. QR encodes a short HTTPS check-in URL containing event and session IDs. Check-in page requests a fresh signed token from Worker, so scanners open link directly without copying token text.

### 4. Monitor attendance and export records

For the selected event:

- **Live counts** shows active attendees, present and late counts, duplicates,
  collisions, and pending mirror writes.
- **Attendance review** lists recorded attendance attempts, including time,
  session, attendee, result, and detail.
- **Download attendance CSV** downloads the selected event's attendance
  records.
- **Collision review** lets an admin merge one attendee record into another.
  Check that the records belong to the same person before merging; the source
  record is retained in audit history.

Production changes affect real event data. Avoid creating test records or
importing attendee data in production unless you intend to retain it.

### Live-use note

QR check-in flow now opens directly from scanner. Verify on actual phones over venue Wi-Fi and mobile data before event day.

## Remaining release work

- Rehearse event-day failure scenarios before relying on the system live.
