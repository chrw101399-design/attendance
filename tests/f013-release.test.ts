import test from "node:test";
import assert from "node:assert/strict";
import { EventDurableObject } from "../worker/event-do.ts";
import { generateCheckInToken } from "../worker/tokens.ts";
import { flushMirrorEvent } from "../worker/mirror-flush.ts";
import type { Env } from "../worker/index.ts";
import type { RosterAttendee } from "../worker/roster.ts";
import type { MirrorRow } from "../worker/mirror.ts";

type Store = Map<string, unknown>;

type TestStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  setAlarm(): Promise<void>;
  transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
};

function makeStorage(seed: Record<string, unknown> = {}): { values: Store; storage: TestStorage } {
  const values: Store = new Map(Object.entries(seed));
  let queue = Promise.resolve();
  const storage: TestStorage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async setAlarm() {},
    transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>) {
      const run = queue.then(() => callback(storage as unknown as DurableObjectTransaction));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return { values, storage };
}

const attendee: RosterAttendee = {
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

async function makeScenario() {
  const { values, storage } = makeStorage({ attendees: [attendee], activeAttendeeIds: [attendee.attendeeId] });
  const durableObject = new EventDurableObject({ storage } as unknown as DurableObjectState);
  const eventResponse = await durableObject.fetch(new Request("https://event.internal/event", {
    method: "PUT",
    body: JSON.stringify({ eventId: "f013-event", name: "F-013 rehearsal", eventDate: "2026-12-01", rosterMode: "closed", registrationsOpen: false, status: "live" }),
  }));
  assert.equal(eventResponse.status, 200);
  const sessionResponse = await durableObject.fetch(new Request("https://event.internal/sessions", {
    method: "POST",
    body: JSON.stringify({ label: "Main", startAt: "2026-12-01T00:00:00Z", endAt: "2026-12-01T23:00:00Z", graceMin: 10, status: "open" }),
  }));
  assert.equal(sessionResponse.status, 201);
  const session = (await sessionResponse.json() as { session: { sessionId: string } }).session;
  values.set("mirrorOutbox", []);
  return { durableObject, values, sessionId: session.sessionId, nowMs: Date.parse("2026-12-01T12:00:00Z") };
}

function checkInRequest(sessionId: string, nowMs: number, requestId: number) {
  return new Request("https://event.internal/checkin", {
    method: "POST",
    headers: { "X-QR-Secret": "f013-secret" },
    body: JSON.stringify({
      eventId: "f013-event",
      sessionId,
      attendeeId: attendee.attendeeId,
      token: generateCheckInToken("f013-event", sessionId, nowMs, undefined, "f013-secret").token,
      clientReqId: `f013-request-${requestId}`,
      nowMs,
    }),
  });
}

async function runConcurrentLoad(durableObject: EventDurableObject, sessionId: string, nowMs: number) {
  return Promise.all(Array.from({ length: 500 }, (_, index) =>
    durableObject.fetch(checkInRequest(sessionId, nowMs, index)).then(async (response) => ({
      status: response.status,
      body: await response.json() as { ok: boolean; result: string },
    })),
  ));
}

test("F-013 load rehearsal keeps one successful attendance under 500 concurrent submissions", async () => {
  const scenario = await makeScenario();
  const results = await runConcurrentLoad(scenario.durableObject, scenario.sessionId, scenario.nowMs);
  const successful = results.filter(({ body }) => body.result === "present" || body.result === "present_late");
  const duplicates = results.filter(({ body }) => body.result === "duplicate");
  assert.equal(results.every(({ status }) => status === 200), true);
  assert.equal(successful.length, 1);
  assert.equal(duplicates.length, 499);

  const attendance = await scenario.durableObject.fetch(new Request("https://event.internal/attendance"));
  const records = (await attendance.json() as { attendance: Array<{ result: string }> }).attendance;
  assert.equal(records.length, 500);
  assert.equal(records.filter((record) => record.result === "present").length, 1);
});

test("F-013 Sheets outage preserves load records and mirror catches up after recovery", async () => {
  const scenario = await makeScenario();
  const results = await runConcurrentLoad(scenario.durableObject, scenario.sessionId, scenario.nowMs);
  assert.equal(results.filter(({ body }) => body.result === "present").length, 1);

  let outage = true;
  const committedIds = new Set<string>();
  const env = {
    MIRROR_INTERNAL_SECRET: "f013-mirror-secret",
    EVENTS: {
      idFromName: (eventId: string) => eventId,
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => scenario.durableObject.fetch(input instanceof Request ? input : new Request(String(input), init)) }),
    },
  } as unknown as Env;
  const sheets = {
    async readMirrorIds() { return committedIds; },
    async appendMirrorRows(_env: Env, rows: Array<{ id: string }>) {
      if (outage) throw new Error("simulated Sheets outage");
      for (const row of rows) committedIds.add(row.id);
    },
  };

  await assert.rejects(flushMirrorEvent("f013-event", env, sheets), /Atomic Google Sheets mirror write failed/);
  assert.equal((scenario.values.get("mirrorOutbox") as MirrorRow[]).length, 500);

  const afterOutage = await scenario.durableObject.fetch(new Request("https://event.internal/summary"));
  assert.equal((await afterOutage.json() as { counts: { present: number; pendingMirror: number } }).counts.present, 1);
  outage = false;
  scenario.values.set("mirrorOutbox", (scenario.values.get("mirrorOutbox") as MirrorRow[]).map((row) => ({ ...row, nextAttemptAt: 0 })));

  let recovered = { ok: true, claimed: 0, written: 0, skipped: 0, failed: 0 };
  while (recovered.claimed < 500) {
    const batch = await flushMirrorEvent("f013-event", env, sheets);
    recovered = {
      ok: recovered.ok && batch.ok,
      claimed: recovered.claimed + batch.claimed,
      written: recovered.written + batch.written,
      skipped: recovered.skipped + batch.skipped,
      failed: recovered.failed + batch.failed,
    };
  }
  assert.deepEqual(recovered, { ok: true, claimed: 500, written: 500, skipped: 0, failed: 0 });
  assert.equal(committedIds.size, 500);
  assert.deepEqual(scenario.values.get("mirrorOutbox"), []);
});

test("F-013 Durable Object recovery reloads persisted event and attendance state", async () => {
  const scenario = await makeScenario();
  const result = await scenario.durableObject.fetch(checkInRequest(scenario.sessionId, scenario.nowMs, 1));
  assert.equal((await result.json() as { result: string }).result, "present");

  const restarted = new EventDurableObject({ storage: makeStorageFromValues(scenario.values) } as unknown as DurableObjectState);
  const event = await restarted.fetch(new Request("https://event.internal/event"));
  const sessions = await restarted.fetch(new Request("https://event.internal/sessions"));
  const summary = await restarted.fetch(new Request("https://event.internal/summary"));
  assert.equal((await event.json() as { event: { eventId: string } }).event.eventId, "f013-event");
  assert.equal((await sessions.json() as { sessions: unknown[] }).sessions.length, 1);
  assert.equal((await summary.json() as { counts: { present: number } }).counts.present, 1);
});

function makeStorageFromValues(values: Store): TestStorage {
  let queue = Promise.resolve();
  const storage: TestStorage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async setAlarm() {},
    transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>) {
      const run = queue.then(() => callback(storage as unknown as DurableObjectTransaction));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return storage;
}
