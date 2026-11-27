import test from "node:test";
import assert from "node:assert/strict";
import { decideCheckIn } from "../worker/checkin.ts";
import { generateCheckInToken } from "../worker/tokens.ts";

const secret = "secret";
const now = 1_700_000_000_000;
const session = { status: "open" as const, startAt: now - 60_000, endAt: now + 60_000, graceMin: 10 };
function input(overrides: Partial<Parameters<typeof decideCheckIn>[0]> = {}) {
  const token = generateCheckInToken("evt", "sess", now, { toleranceMin: 2, lifetimeMin: 10 }, secret).token;
  return { eventId: "evt", sessionId: "sess", attendeeId: "att", token, clientReqId: "req", nowMs: now, session, knownAttendee: true, tokenSecret: secret, ...overrides };
}

test("valid attendee creates one present record", () => assert.equal(decideCheckIn(input()).result, "present"));
test("same attendee becomes duplicate", () => assert.equal(decideCheckIn(input({ existing: { ...decideCheckIn(input()), result: "present" } })).result, "duplicate"));
test("same client request returns prior result", () => {
  const prior = decideCheckIn(input());
  assert.equal(decideCheckIn(input({ requestResult: prior })).result, "present");
});
test("bad token is rejected", () => assert.equal(decideCheckIn(input({ token: "bad" })).result, "rejected_token"));
test("closed session is rejected", () => assert.equal(decideCheckIn(input({ session: { ...session, status: "closed" } })).result, "rejected_window"));
test("late submission inside grace is present_late", () => assert.equal(decideCheckIn(input({ nowMs: session.endAt + 1_000, token: generateCheckInToken("evt", "sess", session.endAt + 1_000, { toleranceMin: 2, lifetimeMin: 10 }, secret).token })).result, "present_late"));
