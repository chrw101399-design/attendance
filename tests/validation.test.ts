import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_STATUSES, ROSTER_MODES, SESSION_STATUSES } from "../worker/types.ts";
import {
  validateEvent,
  validateSession,
  normalizeEventDate,
} from "../worker/validation.ts";

test("validateEvent accepts a valid event", () => {
  const result = validateEvent({
    name: "Annual Conference",
    eventDate: "2026-12-12",
    rosterMode: "hybrid",
    registrationsOpen: true,
    status: "planned",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEvent rejects a blank event name", () => {
  const result = validateEvent({ name: "", eventDate: "2026-12-12", rosterMode: "hybrid" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("name")));
});

test("validateEvent rejects an invalid roster mode", () => {
  const result = validateEvent({ name: "Event", eventDate: "2026-12-12", rosterMode: "unknown" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("rosterMode")));
});

test("validateEvent rejects a status before planned", () => {
  const result = validateEvent({ name: "Event", eventDate: "2026-12-12", status: "future" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("status")));
});

test("validateSession accepts a valid session", () => {
  const result = validateSession({
    eventId: "evt_2026_12_12",
    label: "AM session",
    startAt: "2026-12-12T09:00:00Z",
    endAt: "2026-12-12T17:00:00Z",
    graceMin: 30,
    status: "planned",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateSession rejects end before start", () => {
  const result = validateSession({
    eventId: "evt_2026_12_12",
    label: "AM session",
    startAt: "2026-12-12T17:00:00Z",
    endAt: "2026-12-12T09:00:00Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("endAt")));
});

test("validateSession rejects negative grace", () => {
  const result = validateSession({
    eventId: "evt_2026_12_12",
    label: "AM session",
    startAt: "2026-12-12T09:00:00Z",
    endAt: "2026-12-12T17:00:00Z",
    graceMin: -1,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("graceMin")));
});

test("validateSession rejects invalid datetimes", () => {
  const result = validateSession({
    eventId: "evt_2026_12_12",
    label: "AM session",
    startAt: "not-a-date",
    endAt: "2026-12-12T17:00:00Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("startAt")));
});

test("normalizeEventDate converts to UTC millis", () => {
  const ms = normalizeEventDate("2026-12-12");
  assert.equal(ms, Date.UTC(2026, 11, 12));
});

test("normalizeEventDate rejects invalid date", () => {
  assert.equal(normalizeEventDate("2026-13-45"), null);
});

test("enumerations match shared schema", () => {
  assert.deepEqual([...EVENT_STATUSES], ["planned", "live", "closed"]);
  assert.deepEqual([...ROSTER_MODES], ["closed", "hybrid", "open"]);
  assert.deepEqual([...SESSION_STATUSES], ["planned", "open", "closed"]);
});
