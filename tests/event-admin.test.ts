import test from "node:test";
import assert from "node:assert/strict";
import { EventDurableObject } from "../worker/event-do.ts";
import { generateCheckInToken } from "../worker/tokens.ts";
import type { RosterAttendee } from "../worker/roster.ts";

type Store = Map<string, unknown>;
function makeDo(seed: Record<string, unknown> = {}) {
  const values: Store = new Map(Object.entries(seed));
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async setAlarm() {},
    async transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>) { return callback(storage as unknown as DurableObjectTransaction); },
  };
  return new EventDurableObject({ storage } as unknown as DurableObjectState);
}

const attendee: RosterAttendee = { attendeeId: "att-1", fullName: "Ada Lovelace", normalized: "ada lovelace", email: "", phone: "", group: "", source: "import", needsReview: false, createdAt: "2026-01-01T00:00:00.000Z", mergedInto: "" };

test("admin event and session state becomes authoritative for check-in", async () => {
  const durableObject = makeDo({ attendees: [attendee], activeAttendeeIds: [attendee.attendeeId] });
  const eventResponse = await durableObject.fetch(new Request("https://event.internal/event", { method: "PUT", body: JSON.stringify({ eventId: "evt-1", name: "Demo", eventDate: "2026-12-01", rosterMode: "hybrid", registrationsOpen: true, status: "planned" }) }));
  assert.equal(eventResponse.status, 200);
  const sessionResponse = await durableObject.fetch(new Request("https://event.internal/sessions", { method: "POST", body: JSON.stringify({ label: "Morning", startAt: "2026-12-01T00:00:00Z", endAt: "2026-12-01T23:00:00Z", graceMin: 10 }) }));
  const session = (await sessionResponse.json() as { session: { sessionId: string } }).session;
  const nowMs = Date.now();
  const token = generateCheckInToken("evt-1", session.sessionId, nowMs, { toleranceMin: 2, lifetimeMin: 10 }, "secret").token;
  const checkin = await durableObject.fetch(new Request("https://event.internal/checkin", { method: "POST", headers: { "X-QR-Secret": "secret" }, body: JSON.stringify({ eventId: "evt-1", sessionId: session.sessionId, attendeeId: attendee.attendeeId, token, clientReqId: "req-1", nowMs, session: { status: "open", startAt: 0, endAt: 0, graceMin: 0 } }) }));
  assert.equal(checkin.status, 200);
  assert.equal((await checkin.json() as { result: string }).result, "rejected_window");
});

test("check-in uses server time instead of caller-supplied time", async () => {
  const durableObject = makeDo({ attendees: [attendee], activeAttendeeIds: [attendee.attendeeId] });
  await durableObject.fetch(new Request("https://event.internal/event", { method: "PUT", body: JSON.stringify({ eventId: "evt-time", name: "Current", eventDate: new Date().toISOString().slice(0, 10), rosterMode: "closed", registrationsOpen: false, status: "live" }) }));
  const startAt = new Date(Date.now() - 60_000).toISOString();
  const endAt = new Date(Date.now() + 60_000).toISOString();
  const sessionResponse = await durableObject.fetch(new Request("https://event.internal/sessions", { method: "POST", body: JSON.stringify({ label: "Current", startAt: startAt.replace(/\.\d{3}Z$/, "Z"), endAt: endAt.replace(/\.\d{3}Z$/, "Z"), graceMin: 0, status: "open" }) }));
  const currentSession = (await sessionResponse.json() as { session: { sessionId: string } }).session;
  const currentToken = generateCheckInToken("evt-time", currentSession.sessionId, Date.now(), { toleranceMin: 2, lifetimeMin: 10 }, "secret").token;
  const response = await durableObject.fetch(new Request("https://event.internal/checkin", { method: "POST", headers: { "X-QR-Secret": "secret" }, body: JSON.stringify({ eventId: "evt-time", sessionId: currentSession.sessionId, attendeeId: attendee.attendeeId, token: currentToken, clientReqId: "req-server-time", nowMs: 0 }) }));
  assert.equal((await response.json() as { result: string }).result, "present");
});

test("collision merge preserves source attendee and audit record", async () => {
  const source = { ...attendee, attendeeId: "source", needsReview: true };
  const target = { ...attendee, attendeeId: "target", fullName: "Ada Byron", normalized: "ada byron" };
  const durableObject = makeDo({ attendees: [source, target], activeAttendeeIds: [source.attendeeId, target.attendeeId] });
  const collisions = await durableObject.fetch(new Request("https://event.internal/collisions"));
  assert.equal((await collisions.json() as { attendees: RosterAttendee[] }).attendees.length, 1);
  const merged = await durableObject.fetch(new Request("https://event.internal/attendees/source/merge", { method: "POST", body: JSON.stringify({ targetId: "target" }) }));
  assert.equal(merged.status, 200);
  const exportResponse = await durableObject.fetch(new Request("https://event.internal/export"));
  assert.match(await exportResponse.text(), /ts_utc,event_id,event_name/);
});
