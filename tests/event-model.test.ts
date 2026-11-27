import test from "node:test";
import assert from "node:assert/strict";
import { attendeesCsv, csvCell } from "../worker/event-model.ts";

test("csvCell quotes commas, quotes, and newlines", () => {
  assert.equal(csvCell('Ada, "A"'), '"Ada, ""A"""');
  assert.equal(csvCell("line\nnext"), '"line\nnext"');
});

test("attendance export includes source and review flags", () => {
  const csv = attendeesCsv({ eventId: "evt", name: "Demo", eventDate: "2026-12-01", rosterMode: "hybrid", registrationsOpen: true, status: "planned", createdAt: "", updatedAt: "" }, [{ attendeeId: "a", fullName: "Ada", normalized: "ada", email: "", phone: "", group: "", source: "self", needsReview: true, createdAt: "", mergedInto: "" }], [{ eventId: "evt", sessionId: "s", label: "AM", startAt: "2026-12-01T00:00:00Z", endAt: "2026-12-01T01:00:00Z", graceMin: 0, status: "open" }], [{ tsUtc: "now", eventId: "evt", sessionId: "s", attendeeId: "a", result: "present", detail: "accepted", clientReqId: "r" }]);
  assert.match(csv, /source,needs_review/);
  assert.match(csv, /self,true,present/);
});
