import test from "node:test";
import assert from "node:assert/strict";
import {
  generateCheckInToken,
  generateStaticFallbackToken,
  verifyCheckInToken,
} from "../worker/tokens.ts";

const secret = "test-secret";
const baseNow = 1_700_000_000_000;

test("valid check-in token verifies and rejects tampered signature", () => {
  const token = generateCheckInToken("evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  const verdict = verifyCheckInToken(token.token, "evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  assert.equal(verdict.ok, true);

  const tampered = token.token.replace(token.token.split(".")[1], "AAAA");
  const verdict2 = verifyCheckInToken(tampered, "evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  assert.equal(verdict2.ok, false);
  assert.equal(verdict2.reason, "invalid_signature");
});

test("token uses event/session bound and expiry window", () => {
  const token = generateCheckInToken("evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  assert.equal(verifyCheckInToken(token.token, "evt_y", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret).reason, "wrong_session");
  assert.equal(verifyCheckInToken(token.token, "evt_x", "sess_b", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret).reason, "wrong_session");

  const expired = generateCheckInToken("evt_x", "sess_a", baseNow - 40_000_000, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  assert.equal(verifyCheckInToken(expired.token, "evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret).reason, "expired");
});

test("tolerance window accepts slightly older valid tokens", () => {
  const token = generateCheckInToken("evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600 }, secret);
  assert.equal(verifyCheckInToken(token.token, "evt_x", "sess_a", baseNow + 20_000, { toleranceMin: 30, lifetimeMin: 600 }, secret).ok, true);
});

test("static fallback token is distinguishable and expires after fallback period", () => {
  const staticToken = generateStaticFallbackToken("evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600, fallbackMin: 30 }, secret);
  assert.equal(staticToken.static, true);
  assert.equal(verifyCheckInToken(staticToken.token, "evt_x", "sess_a", baseNow, { toleranceMin: 30, lifetimeMin: 600, fallbackMin: 30 }, secret).ok, true);
  assert.equal(verifyCheckInToken(staticToken.token, "evt_x", "sess_a", baseNow + 4_000_000, { toleranceMin: 30, lifetimeMin: 600, fallbackMin: 30 }, secret).reason, "fallback_expired");
});
