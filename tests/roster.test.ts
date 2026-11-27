import test from "node:test";
import assert from "node:assert/strict";
import { planRosterImport, commitRosterImport, normalizeAttendeeName } from "../worker/roster.ts";

test("roster import reports new, matched, and blank rows", () => {
  const plan = planRosterImport(
    [["Alice Smith", "alice@example.com"], ["Bob Jones", ""], ["  ", ""]],
    { name: 0, email: 1 },
    [{ attendeeId: "att_1", fullName: "Alice Smith", normalized: "alice smith", email: "alice@example.com", phone: "", group: "", source: "import" as const, needsReview: false, createdAt: "2026-01-01T00:00:00.000Z", mergedInto: "" }],
  );
  assert.deepEqual(plan.counts, { new: 1, matched: 1, blank: 1, invalid: 0 });
  assert.equal(plan.attendees[0].attendeeId, "att_1");
});

test("re-import preserves attendee ID and existing attendance references", () => {
  const current = [{ attendeeId: "att_existing", fullName: "Alex Lee", normalized: "alex lee", email: "", phone: "", group: "", source: "import" as const, needsReview: false, createdAt: "old", mergedInto: "" }];
  const plan = planRosterImport([["Alex Lee", "Group A"]], { name: 0, group: 1 }, current);
  const committed = commitRosterImport(current, plan, { mode: "merge", confirmReplace: false });
  assert.equal(committed.attendees[0].attendeeId, "att_existing");
  assert.equal(committed.rosterVersion, 1);
  assert.equal(committed.attendees[0].group, "Group A");
  assert.deepEqual(committed.activeIds, ["att_existing"]);
});

test("replace requires explicit confirmation", () => {
  const plan = planRosterImport([["New Person"]], { name: 0 }, []);
  assert.throws(() => commitRosterImport([], plan, { mode: "replace", confirmReplace: false }), /confirmation/);
});

test("replace keeps existing IDs for names retained in imported roster", () => {
  const current = [{ attendeeId: "att_keep", fullName: "Alex Lee", normalized: "alex lee", email: "", phone: "", group: "", source: "import" as const, needsReview: false, createdAt: "old", mergedInto: "" }];
  const plan = planRosterImport([["Alex Lee"]], { name: 0 }, current);
  const committed = commitRosterImport(current, plan, { mode: "replace", confirmReplace: true });
  assert.deepEqual(committed.activeIds, ["att_keep"]);
  assert.equal(committed.rosterVersion, 1);
});

test("normalization folds case, accents, punctuation, and spacing", () => {
  assert.equal(normalizeAttendeeName("  Élodie  O’Neil! "), "elodie o neil");
});
