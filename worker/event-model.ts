import type { RosterAttendee } from "./roster.ts";

export type EventRecord = {
  eventId: string;
  name: string;
  eventDate: string;
  rosterMode: "closed" | "hybrid" | "open";
  registrationsOpen: boolean;
  status: "planned" | "live" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  eventId: string;
  sessionId: string;
  label: string;
  startAt: string;
  endAt: string;
  graceMin: number;
  status: "planned" | "open" | "closed";
};

export type EventCounts = {
  attendees: number;
  present: number;
  late: number;
  duplicates: number;
  collisions: number;
  pendingMirror: number;
};

export type CatalogEvent = Pick<EventRecord, "eventId" | "name" | "eventDate" | "status">;

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function attendeesCsv(event: EventRecord | undefined, attendees: RosterAttendee[], sessions: SessionRecord[], attendance: Array<{ tsUtc: string; eventId: string; sessionId: string; attendeeId: string; result: string; detail: string; clientReqId: string }>): string {
  const header = ["ts_utc", "event_id", "event_name", "event_date", "session_id", "session_label", "attendee_id", "attendee_name", "source", "needs_review", "result", "detail", "client_req_id"];
  const attendeeMap = new Map(attendees.map((attendee) => [attendee.attendeeId, attendee]));
  const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
  const rows = attendance.map((record) => {
    const attendee = attendeeMap.get(record.attendeeId);
    const session = sessionMap.get(record.sessionId);
    return [record.tsUtc, record.eventId, event?.name ?? "", event?.eventDate ?? "", record.sessionId, session?.label ?? "", record.attendeeId, attendee?.fullName ?? "", attendee?.source ?? "", attendee?.needsReview ?? false, record.result, record.detail, record.clientReqId];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
