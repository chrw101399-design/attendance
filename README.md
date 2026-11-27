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

**Show QR token** retrieves a session token and shows its expiry time. It does
not currently create a scannable QR image; see the live-use limitation below.

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

### Important: attendee check-in is not ready for live use

The public attendee check-in page is still a placeholder, and **Show QR token**
displays token text rather than a scannable QR code. Attendees therefore
cannot yet complete check-in through the public UI. Do not use the token as a
live check-in process until the attendee-facing check-in flow and scannable QR
display are implemented and rehearsed.

## Remaining release work

- Implement and verify the attendee-facing check-in flow and scannable QR
  display.
- Rehearse event-day failure scenarios before relying on the system live.
