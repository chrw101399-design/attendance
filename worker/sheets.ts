import type { Env } from "./index";
import { SHEET_SCHEMA } from "./types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

type CachedToken = { value: string; expiresAt: number };
let token: CachedToken | undefined;

export type MirrorAppendRow = { id: string; tab: string; values: unknown[] };

function base64Url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function parseServiceAccount(encoded: string | undefined): ServiceAccount {
  if (!encoded) throw new Error("GOOGLE_SA_JSON_B64 secret is missing");
  try {
    return JSON.parse(atob(encoded)) as ServiceAccount;
  } catch {
    throw new Error("GOOGLE_SA_JSON_B64 is not valid base64 JSON");
  }
}

async function googleToken(encoded: string | undefined): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;

  const account = parseServiceAccount(encoded);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (char) => char.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${base64Url(signature)}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status} ${await response.text()}`);
  const result = await response.json<{ access_token: string; expires_in: number }>();
  token = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return token.value;
}

async function sheetValues(env: Env, tab: string): Promise<unknown[][]> {
  const accessToken = await googleToken(env.GOOGLE_SA_JSON_B64);
  const response = await fetch(`${SHEETS_API}/${env.SHEET_ID}/values/${encodeURIComponent(tab)}!A:Z`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google Sheets read failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { values?: unknown[][] }).values ?? [];
}

type SheetMetadata = { properties: { title: string; sheetId: number } };

async function spreadsheetSheets(env: Env): Promise<Map<string, number>> {
  const accessToken = await googleToken(env.GOOGLE_SA_JSON_B64);
  const response = await fetch(`${SHEETS_API}/${env.SHEET_ID}?fields=sheets(properties(sheetId,title))`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Sheets metadata read failed: ${response.status} ${await response.text()}`);
  const result = await response.json<{ sheets?: SheetMetadata[] }>();
  return new Map((result.sheets ?? []).map(({ properties }) => [properties.title, properties.sheetId]));
}

async function batchUpdate(env: Env, requests: unknown[]): Promise<{ replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> }> {
  const accessToken = await googleToken(env.GOOGLE_SA_JSON_B64);
  const response = await fetch(`${SHEETS_API}/${env.SHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) throw new Error(`Google Sheets batch update failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function cellData(value: unknown): { userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean } } {
  if (value === null || value === undefined) return {};
  if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Mirror row contains a non-finite number");
    return { userEnteredValue: { numberValue: value } };
  }
  return { userEnteredValue: { stringValue: String(value) } };
}

export function buildMirrorBatchRequests(
  rows: MirrorAppendRow[],
  sheetIds: ReadonlyMap<string, number>,
  writtenAt: string,
): unknown[] {
  const grouped = new Map<string, MirrorAppendRow[]>();
  for (const row of rows) {
    if (row.tab === "MirrorIndex") throw new Error("MirrorIndex cannot be used as a source tab");
    if (!sheetIds.has(row.tab)) throw new Error(`Google Sheet tab is missing: ${row.tab}`);
    const group = grouped.get(row.tab) ?? [];
    group.push(row);
    grouped.set(row.tab, group);
  }
  const indexSheetId = sheetIds.get("MirrorIndex");
  if (rows.length && indexSheetId === undefined) throw new Error("Google Sheet tab is missing: MirrorIndex");

  const requests = Array.from(grouped, ([tab, tabRows]) => ({
    appendCells: {
      sheetId: sheetIds.get(tab)!,
      rows: tabRows.map((row) => ({ values: [...row.values, row.id].map(cellData) })),
      fields: "userEnteredValue",
    },
  }));
  if (rows.length) {
    requests.push({
      appendCells: {
        sheetId: indexSheetId!,
        rows: rows.map((row) => ({ values: [row.id, writtenAt, row.tab].map(cellData) })),
        fields: "userEnteredValue",
      },
    });
  }
  return requests;
}

async function ensureMirrorIndex(env: Env): Promise<Map<string, number>> {
  let sheetIds = await spreadsheetSheets(env);
  let indexSheetId = sheetIds.get("MirrorIndex");
  if (indexSheetId === undefined) {
    try {
      await batchUpdate(env, [{ addSheet: { properties: { title: "MirrorIndex" } } }]);
    } catch (error) {
      sheetIds = await spreadsheetSheets(env);
      if (!sheetIds.has("MirrorIndex")) throw error;
    }
    sheetIds = await spreadsheetSheets(env);
    indexSheetId = sheetIds.get("MirrorIndex");
    if (indexSheetId === undefined) throw new Error("Google Sheets did not create the MirrorIndex tab");
  }

  const values = await sheetValues(env, "MirrorIndex");
  const header = ["mirror_id", "written_at", "tab"];
  if (!values.length) {
    await batchUpdate(env, [{
      updateCells: {
        start: { sheetId: indexSheetId, rowIndex: 0, columnIndex: 0 },
        rows: [{ values: header.map(cellData) }],
        fields: "userEnteredValue",
      },
    }]);
  } else if (header.some((value, index) => String(values[0][index] ?? "") !== value)) {
    throw new Error("MirrorIndex has an unexpected header; expected mirror_id, written_at, tab");
  }

  for (const tab of ["Events", "Attendees", "Sessions", "AttendanceLog"] as const) {
    const expected = SHEET_SCHEMA[tab];
    const sourceValues = await sheetValues(env, tab);
    const sourceHeader = sourceValues[0] ?? [];
    const mirrorColumn = expected.indexOf("mirror_id");
    const hasExpectedPrefix = expected.slice(0, mirrorColumn).every((value, index) => String(sourceHeader[index] ?? "") === value);
    if (hasExpectedPrefix && String(sourceHeader[mirrorColumn] ?? "") === "mirror_id") continue;
    if (hasExpectedPrefix && sourceHeader.length === mirrorColumn) {
      await batchUpdate(env, [{
        updateCells: {
          start: { sheetId: sheetIds.get(tab)!, rowIndex: 0, columnIndex: mirrorColumn },
          rows: [{ values: [cellData("mirror_id")] }],
          fields: "userEnteredValue",
        },
      }]);
      continue;
    }
    throw new Error(`${tab} has an unexpected header; expected the generated template schema`);
  }
  return sheetIds;
}

export async function readMirrorIds(env: Env): Promise<Set<string>> {
  await ensureMirrorIndex(env);
  const values = await sheetValues(env, "MirrorIndex");
  return new Set(values.slice(1).map((row) => String(row[0] ?? "")).filter(Boolean));
}

export async function appendMirrorRows(env: Env, rows: MirrorAppendRow[]): Promise<void> {
  if (!rows.length) return;
  const sheetIds = await ensureMirrorIndex(env);
  const requests = buildMirrorBatchRequests(rows, sheetIds, new Date().toISOString());
  // Keep data rows and their dedupe IDs in the same atomic Sheets batch.
  await batchUpdate(env, requests);
}

export async function checkSheetConnection(env: Env): Promise<void> {
  const accessToken = await googleToken(env.GOOGLE_SA_JSON_B64);
  const response = await fetch(`${SHEETS_API}/${env.SHEET_ID}?fields=spreadsheetId,properties.title`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Sheets request failed: ${response.status} ${await response.text()}`);
}
