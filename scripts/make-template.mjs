import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const schema = {
  Events: ["event_id", "name", "event_date", "roster_mode", "registrations_open", "status", "mirror_id"],
  Attendees: ["attendee_id", "event_id", "full_name", "name_hint", "normalized", "source", "needs_review", "created_at", "merged_into", "mirror_id"],
  Sessions: ["event_id", "session_id", "label", "start_at", "end_at", "grace_min", "status", "mirror_id"],
  AttendanceLog: ["ts_utc", "event_id", "session_id", "attendee_id", "input_text", "result", "detail", "token_window", "client_req_id", "ip_hash", "mirror_id"],
  MirrorIndex: ["mirror_id", "written_at", "tab"],
};

const tabs = [
  ["README", [
    ["Attendance System Template"],
    ["1. Upload this file to Google Drive."],
    ["2. Open it with Google Sheets, then choose File > Save as Google Sheets."],
    ["3. Share the converted sheet with your Google service account as Editor."],
    ["4. Copy sheet ID from URL and set SHEET_ID in wrangler.jsonc."],
    ["5. Keep MIRROR_EVENT_IDS in wrangler.jsonc updated with the event IDs to mirror."],
    ["Do not manually edit Attendees, AttendanceLog, or MirrorIndex while an event is live."],
  ]],
  ["Events", [schema.Events]],
  ["Attendees", [schema.Attendees]],
  ["Sessions", [schema.Sessions]],
  ["AttendanceLog", [schema.AttendanceLog]],
  ["MirrorIndex", [schema.MirrorIndex]],
  ["Report", [["Metric", "Value"], ["Present", '=COUNTIF(AttendanceLog!F:F,"present")'], ["Late", '=COUNTIF(AttendanceLog!F:F,"present_late")'], ["Duplicates", '=COUNTIF(AttendanceLog!F:F,"duplicate")']]],
];

function cell(value) {
  const escaped = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (String(value).startsWith("=")) return `<c t="str"><f>${escaped.slice(1)}</f><v></v></c>`;
  return `<c t="inlineStr"><is><t>${escaped}</t></is></c>`;
}

function sheetXml(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, index) => `<row r="${index + 1}">${row.map(cell).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

const files = {
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
};
for (let index = 0; index < tabs.length; index++) files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(tabs[index][1]);

const staging = resolve(".template-staging");
await rm(staging, { recursive: true, force: true });
for (const [name, content] of Object.entries(files)) {
  const path = resolve(staging, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
await mkdir("template", { recursive: true });
await mkdir("public", { recursive: true });
await BunNotAvailable();

async function BunNotAvailable() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const zip = resolve("template/attendance-template.zip");
  const output = resolve("template/attendance-template.xlsx");
  await exec("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}' -Force; Move-Item '${zip}' '${output}' -Force`]);
  await exec("powershell", ["-NoProfile", "-Command", `Copy-Item '${output}' '${resolve("public/attendance-template.xlsx")}' -Force`]);
  await rm(staging, { recursive: true, force: true });
  console.log(`Created ${output}`);
}
