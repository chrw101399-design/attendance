import { createHmac } from "node:crypto";

export type TokenConfig = {
  toleranceMin?: number;
  lifetimeMin?: number;
  fallbackMin?: number;
};

export const DEFAULT_TOKEN_CONFIG: Required<Pick<TokenConfig, "toleranceMin" | "lifetimeMin" | "fallbackMin">> = {
  toleranceMin: 120,
  lifetimeMin: 600,
  fallbackMin: 30,
};

export type TokenState = { token: string; expiresAt: number; static: boolean };
export type TokenVerdict = { ok: boolean; reason?: "invalid_signature" | "expired" | "tolerance" | "wrong_session" | "not_static" | "fallback_expired" | "invalid" };

export function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd((input.length + 3) % 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hmac(input: string, secret: string): Uint8Array {
  return createHmac("sha256", secret).update(input).digest();
}

function tokenConfig(config?: TokenConfig): Required<Pick<TokenConfig, "toleranceMin" | "lifetimeMin" | "fallbackMin">> {
  return {
    toleranceMin: config?.toleranceMin ?? DEFAULT_TOKEN_CONFIG.toleranceMin,
    lifetimeMin: config?.lifetimeMin ?? DEFAULT_TOKEN_CONFIG.lifetimeMin,
    fallbackMin: config?.fallbackMin ?? DEFAULT_TOKEN_CONFIG.fallbackMin,
  };
}

export function generateCheckInToken(
  eventId: string,
  sessionId: string,
  nowMs: number,
  config?: TokenConfig,
  secret?: string,
): TokenState {
  const cfg = tokenConfig(config);
  const payload = `evt:${eventId}|sess:${sessionId}|ts:${nowMs}`;
  const sig = base64UrlEncode(hmac(payload, secret ?? "missing-secret"));
  return { token: `${base64UrlEncode(new TextEncoder().encode(payload))}.${sig}`, expiresAt: nowMs + cfg.lifetimeMin * 60_000, static: false };
}

export function generateStaticFallbackToken(
  eventId: string,
  sessionId: string,
  nowMs: number,
  config?: TokenConfig,
  secret?: string,
): TokenState {
  const cfg = tokenConfig(config);
  const payload = `evt:${eventId}|sess:${sessionId}|ts:${nowMs}|static:1`;
  const sig = base64UrlEncode(hmac(payload, secret ?? "missing-secret"));
  return { token: `${base64UrlEncode(new TextEncoder().encode(payload))}.${sig}`, expiresAt: nowMs + cfg.fallbackMin * 60_000, static: true };
}

export function verifyCheckInToken(token: string, eventId: string, sessionId: string, nowMs: number, config?: TokenConfig, secret?: string): TokenVerdict {
  if (!token || typeof token !== "string" || token.includes("..")) return { ok: false, reason: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadB64, sigB64] = parts;
  const payload = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const expectedSig = base64UrlEncode(hmac(payload, secret ?? "missing-secret"));
  if (expectedSig !== sigB64) return { ok: false, reason: "invalid_signature" };

  const [evtPart, rest] = payload.split("|");
  const match = /^evt:([^|]+)\|sess:([^|]+)\|ts:([^|]+)(?:\|static:1)?$/.exec(payload);
  if (!match) return { ok: false, reason: "invalid" };
  const evt = match[1];
  const sess = match[2];
  const ts = Number(match[3]);
  if (!evt || evt !== eventId) return { ok: false, reason: "wrong_session" };
  if (!sess || sess !== sessionId) return { ok: false, reason: "wrong_session" };
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid" };

  const cfg = tokenConfig(config);
  const lifetimeMs = cfg.lifetimeMin * 60_000;
  const fallbackMs = cfg.fallbackMin * 60_000;
  const toleranceMs = cfg.toleranceMin * 60_000;
  const isStatic = payload.includes("static:1");

  if (ts > nowMs + lifetimeMs) return { ok: false, reason: "expired" };
  if (isStatic) {
    if (nowMs - ts > fallbackMs) return { ok: false, reason: "fallback_expired" };
    if (ts < nowMs - toleranceMs) return { ok: false, reason: "tolerance" };
    return { ok: true };
  }
  if (ts < nowMs - lifetimeMs) return { ok: false, reason: "expired" };
  if (ts < nowMs - toleranceMs) return { ok: false, reason: "tolerance" };
  return { ok: true };
}
