import test from "node:test";
import assert from "node:assert/strict";
import { resolveSelfRegistration } from "../worker/roster.ts";

test("closed mode rejects self-registration", () => {
  assert.equal(resolveSelfRegistration("closed", false, "Alex Lee", []).result, "rejected_closed");
});

test("hybrid registration creates new attendee", () => {
  const result = resolveSelfRegistration("hybrid", true, "Alex Lee", []);
  assert.equal(result.result, "created");
  assert.equal(result.attendee?.source, "self");
});

test("exact match requires identity confirmation", () => {
  const current = [{ attendeeId: "att_1", fullName: "Alex Lee", normalized: "alex lee", email: "", phone: "", group: "", source: "import" as const, needsReview: false, createdAt: "now", mergedInto: "" }];
  const result = resolveSelfRegistration("open", true, "Alex Lee", current);
  assert.equal(result.result, "existing_match");
  assert.equal(result.matches?.[0].attendeeId, "att_1");
});

test("different-person path creates review collision", () => {
  const current = [{ attendeeId: "att_1", fullName: "Alex Lee", normalized: "alex lee", email: "", phone: "", group: "", source: "import" as const, needsReview: false, createdAt: "now", mergedInto: "" }];
  const result = resolveSelfRegistration("open", true, "Alex Lee", current, true);
  assert.equal(result.result, "created");
  assert.equal(result.attendee?.needsReview, true);
});
