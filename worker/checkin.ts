import { verifyCheckInToken, type TokenConfig } from "./tokens.ts";

export type SessionState = { status: "planned" | "open" | "closed"; startAt: number; endAt: number; graceMin: number };
export type AttendanceRecord = { eventId: string; sessionId: string; attendeeId: string; result: "present" | "present_late" | "duplicate" | "rejected_window" | "rejected_token"; detail: string; tsUtc: string; clientReqId: string };

export function decideCheckIn(input: {
  eventId: string; sessionId: string; attendeeId: string; token: string; clientReqId: string;
  nowMs: number; session: SessionState; knownAttendee: boolean; tokenSecret: string; tokenConfig?: TokenConfig;
  existing?: AttendanceRecord; requestResult?: AttendanceRecord;
}): AttendanceRecord {
  if (input.requestResult) return input.requestResult;
  const base = { eventId: input.eventId, sessionId: input.sessionId, attendeeId: input.attendeeId, tsUtc: new Date(input.nowMs).toISOString(), clientReqId: input.clientReqId };
  if (!input.knownAttendee) return { ...base, result: "rejected_token", detail: "unknown_attendee" };
  const token = verifyCheckInToken(input.token, input.eventId, input.sessionId, input.nowMs, input.tokenConfig, input.tokenSecret);
  if (!token.ok) return { ...base, result: "rejected_token", detail: token.reason ?? "invalid" };
  if (input.existing) return { ...base, result: "duplicate", detail: "already_present" };
  if (input.session.status !== "open") return { ...base, result: "rejected_window", detail: "session_not_open" };
  if (input.nowMs < input.session.startAt || input.nowMs > input.session.endAt + input.session.graceMin * 60_000) {
    return { ...base, result: "rejected_window", detail: "outside_session_window" };
  }
  return { ...base, result: input.nowMs > input.session.endAt ? "present_late" : "present", detail: "accepted" };
}
