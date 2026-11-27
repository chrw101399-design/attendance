export const SHEET_SCHEMA = {
  README: ["Attendance System Template"],
  Events: ["event_id", "name", "event_date", "roster_mode", "registrations_open", "status", "mirror_id"],
  Attendees: ["attendee_id", "event_id", "full_name", "name_hint", "normalized", "source", "needs_review", "created_at", "merged_into", "mirror_id"],
  Sessions: ["event_id", "session_id", "label", "start_at", "end_at", "grace_min", "status", "mirror_id"],
  AttendanceLog: ["ts_utc", "event_id", "session_id", "attendee_id", "input_text", "result", "detail", "token_window", "client_req_id", "ip_hash", "mirror_id"],
  MirrorIndex: ["mirror_id", "written_at", "tab"],
  Report: ["Metric", "Value"],
} as const;

export const ROSTER_MODES = ["closed", "hybrid", "open"] as const;
export const EVENT_STATUSES = ["planned", "live", "closed"] as const;
export const SESSION_STATUSES = ["planned", "open", "closed"] as const;
export const ATTENDEE_SOURCES = ["import", "self"] as const;
export const ATTENDANCE_RESULTS = [
  "present",
  "present_late",
  "duplicate",
  "rejected_closed",
  "rejected_window",
  "rejected_token",
] as const;
