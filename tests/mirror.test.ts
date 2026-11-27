import test from "node:test";
import assert from "node:assert/strict";
import { buildMirrorBatchRequests } from "../worker/sheets.ts";
import { changedAttendeeMirrorRows, MIRROR_CLAIM_LEASE_MS, mirrorLag, nextMirrorAttempt, partitionMirrorRows, type MirrorRow } from "../worker/mirror.ts";
import { flushMirrorEvent } from "../worker/mirror-flush.ts";
import { EventDurableObject } from "../worker/event-do.ts";
import type { Env } from "../worker/index.ts";
import type { RosterAttendee } from "../worker/roster.ts";

const rosterAttendee: RosterAttendee = {
  attendeeId: "attendee-1",
  fullName: "Ada Lovelace",
  normalized: "ada lovelace",
  email: "",
  phone: "",
  group: "",
  source: "import",
  needsReview: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  mergedInto: "",
};

test("mirror retry uses bounded exponential backoff", () => {
  const row = { id: "x", tab: "AttendanceLog", values: [], attempts: 1, nextAttemptAt: 0, createdAt: new Date(1_000).toISOString() };
  const next = nextMirrorAttempt(row, 2_000);
  assert.equal(next.attempts, 2);
  assert.equal(next.nextAttemptAt, 6_000);
});

test("mirror lag reports pending rows and oldest timestamp", () => {
  const rows = [
    { id: "a", tab: "Attendees", values: [], attempts: 0, nextAttemptAt: 0, createdAt: new Date(4_000).toISOString() },
    { id: "b", tab: "AttendanceLog", values: [], attempts: 1, nextAttemptAt: 99_999, createdAt: new Date(1_000).toISOString() },
  ];
  assert.deepEqual(mirrorLag(rows, 5_000), { pending: 2, oldestAt: new Date(1_000).toISOString(), lagMs: 4_000 });
});

test("mirror retries skip IDs already committed to the index", () => {
  const rows = [{ id: "committed" }, { id: "pending" }];
  assert.deepEqual(partitionMirrorRows(rows, new Set(["committed"])), {
    pending: [{ id: "pending" }],
    alreadyWrittenIds: ["committed"],
  });
});

test("roster mirror changes omit unchanged attendees and include updated values", () => {
  const updated = [
    { ...rosterAttendee },
    { ...rosterAttendee, fullName: "Ada Byron", normalized: "ada byron" },
  ];
  assert.deepEqual(changedAttendeeMirrorRows(
    [rosterAttendee],
    updated,
    new Set(["attendee-1"]),
    "event-a",
  ), [{
    attendee: updated[1],
    values: [
      "attendee-1",
      "event-a",
      "Ada Byron",
      "ada byron",
      "ada byron",
      "import",
      false,
      "2026-01-01T00:00:00.000Z",
      "",
    ],
  }]);
});

test("mirror batch appends source rows and index rows in one atomic request set", () => {
  const requests = buildMirrorBatchRequests([
    { id: "attendee:1:v2", tab: "Attendees", values: ["1", "event-a", "Ada", true] },
    { id: "attendance:2", tab: "AttendanceLog", values: ["2026-01-01T00:00:00.000Z", "event-a"] },
  ], new Map([["Attendees", 10], ["AttendanceLog", 20], ["MirrorIndex", 30]]), "2026-01-01T00:01:00.000Z");

  assert.deepEqual(requests, [
    {
      appendCells: {
        sheetId: 10,
        rows: [{ values: [
          { userEnteredValue: { stringValue: "1" } },
          { userEnteredValue: { stringValue: "event-a" } },
          { userEnteredValue: { stringValue: "Ada" } },
          { userEnteredValue: { boolValue: true } },
          { userEnteredValue: { stringValue: "attendee:1:v2" } },
        ] }],
        fields: "userEnteredValue",
      },
    },
    {
      appendCells: {
        sheetId: 20,
        rows: [{ values: [
          { userEnteredValue: { stringValue: "2026-01-01T00:00:00.000Z" } },
          { userEnteredValue: { stringValue: "event-a" } },
          { userEnteredValue: { stringValue: "attendance:2" } },
        ] }],
        fields: "userEnteredValue",
      },
    },
    {
      appendCells: {
        sheetId: 30,
        rows: [
          { values: [
            { userEnteredValue: { stringValue: "attendee:1:v2" } },
            { userEnteredValue: { stringValue: "2026-01-01T00:01:00.000Z" } },
            { userEnteredValue: { stringValue: "Attendees" } },
          ] },
          { values: [
            { userEnteredValue: { stringValue: "attendance:2" } },
            { userEnteredValue: { stringValue: "2026-01-01T00:01:00.000Z" } },
            { userEnteredValue: { stringValue: "AttendanceLog" } },
          ] },
        ],
        fields: "userEnteredValue",
      },
    },
  ]);
});

test("mirror batch rejects rows targeting MirrorIndex", () => {
  assert.throws(() => buildMirrorBatchRequests(
    [{ id: "index", tab: "MirrorIndex", values: [] }],
    new Map([["MirrorIndex", 30]]),
    "2026-01-01T00:01:00.000Z",
  ), /cannot be used as a source tab/);
});

test("uncertain Sheets response retries skip an already committed row", async () => {
  const row = {
    id: "attendance:request-1",
    tab: "AttendanceLog",
    values: ["2026-01-01T00:00:00.000Z"],
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const committedIds = new Set<string>();
  const acknowledgements: Array<{ ids: string[]; failedIds: string[] }> = [];
  let appendAttempts = 0;
  const eventStub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const path = new URL(String(input)).pathname;
      if (path === "/mirror/claim") return Response.json({ rows: [row] });
      if (path === "/mirror/ack") {
        acknowledgements.push(JSON.parse(String(init?.body)) as { ids: string[]; failedIds: string[] });
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  };
  const env = {
    MIRROR_INTERNAL_SECRET: "test-secret",
    EVENTS: {
      idFromName: (eventId: string) => eventId,
      get: () => eventStub,
    },
  } as unknown as Env;
  const sheets = {
    async readMirrorIds() { return committedIds; },
    async appendMirrorRows(_env: Env, rows: Array<{ id: string }>) {
      if (!rows.length) return;
      appendAttempts += 1;
      for (const pending of rows) committedIds.add(pending.id);
      throw new Error("response lost after commit");
    },
  };

  await assert.rejects(flushMirrorEvent("event-a", env, sheets), /response lost after commit/);
  assert.deepEqual(acknowledgements[0], { ids: [], failedIds: [row.id] });

  const retried = await flushMirrorEvent("event-a", env, sheets);
  assert.deepEqual(retried, { ok: true, claimed: 1, written: 0, skipped: 1, failed: 0 });
  assert.equal(appendAttempts, 1);
  assert.deepEqual(acknowledgements[1], { ids: [row.id], failedIds: [] });
});

test("Durable Object claim leases rows and ack retains failures for backoff", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async setAlarm() {},
    async transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>) {
      return callback(storage as unknown as DurableObjectTransaction);
    },
  };
  const durableObject = new EventDurableObject({ storage } as unknown as DurableObjectState);
  const row: MirrorRow = {
    id: "mirror-row",
    tab: "AttendanceLog",
    values: [],
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: new Date().toISOString(),
  };
  values.set("mirrorOutbox", [row]);

  const beforeClaim = Date.now();
  const claimResponse = await durableObject.fetch(new Request("https://event.internal/mirror/claim", { method: "POST" }));
  const claimed = await claimResponse.json() as { rows: MirrorRow[] };
  const afterClaim = Date.now();
  assert.equal(claimed.rows.length, 1);
  assert.ok(claimed.rows[0].nextAttemptAt >= beforeClaim + MIRROR_CLAIM_LEASE_MS);
  assert.ok(claimed.rows[0].nextAttemptAt <= afterClaim + MIRROR_CLAIM_LEASE_MS);

  const secondClaim = await durableObject.fetch(new Request("https://event.internal/mirror/claim", { method: "POST" }));
  assert.deepEqual((await secondClaim.json() as { rows: MirrorRow[] }).rows, []);

  const failedAckAt = Date.now();
  await durableObject.fetch(new Request("https://event.internal/mirror/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [], failedIds: [row.id] }),
  }));
  const afterFailure = (values.get("mirrorOutbox") as MirrorRow[])[0];
  assert.equal(afterFailure.attempts, 1);
  assert.ok(afterFailure.nextAttemptAt >= failedAckAt + 2_000);

  values.set("mirrorOutbox", [{ ...afterFailure, nextAttemptAt: 0 }]);
  await durableObject.fetch(new Request("https://event.internal/mirror/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [row.id], failedIds: [] }),
  }));
  assert.deepEqual(values.get("mirrorOutbox"), []);
});
