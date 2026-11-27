import test from "node:test";
import assert from "node:assert/strict";
import { selectableRosterFields } from "../worker/roster.ts";

test("selectable roster exposes only ID, display, and safe hint", () => {
  const fields = selectableRosterFields({
    attendeeId: "att_1",
    fullName: "Alice Smith",
    normalized: "alice smith",
    email: "alice@example.com",
    phone: "0915-0001",
    group: "Group A",
    source: "import",
    needsReview: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    mergedInto: "",
  });
  assert.deepEqual(Object.keys(fields).sort(), ["display", "hint", "id"]);
  assert.equal(fields.display, "Alice Smith");
  assert.equal(fields.hint, "alice smith");
  assert.equal(fields.id, "att_1");
});
