import { EVENT_STATUSES, ROSTER_MODES, SESSION_STATUSES } from "./types.ts";

export type EventValidation = {
  ok: boolean;
  errors: string[];
  eventId?: string;
};

export type SessionValidation = {
  ok: boolean;
  errors: string[];
  sessionId?: string;
};

export type NormalizedDate = number | null;

export function normalizeEventDate(value: string): NormalizedDate {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const check = new Date(time);
  if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)) return null;
  return time;
}

export function validateEvent(input: Record<string, unknown>): EventValidation {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required and must not be blank");

  const rosterMode = input.rosterMode;
  if (!ROSTER_MODES.includes(rosterMode as (typeof ROSTER_MODES)[number])) {
    errors.push(`rosterMode must be one of ${ROSTER_MODES.join(", ")}`);
  }

  const eventDate = input.eventDate;
  const eventDateString = typeof eventDate === "string" ? eventDate : "";
  if (!eventDateString || !/^\d{4}-\d{2}-\d{2}$/.test(eventDateString)) {
    errors.push("eventDate must be YYYY-MM-DD");
  }

  const status = input.status;
  if (!EVENT_STATUSES.includes(status as (typeof EVENT_STATUSES)[number])) {
    errors.push(`status must be one of ${EVENT_STATUSES.join(", ")}`);
  }

  if (!errors.length) {
    const eventId = `evt_${eventDateString.replace(/-/g, "")}`;
    return { ok: true, errors: [], eventId };
  }
  return { ok: false, errors };
}

export function validateSession(input: Record<string, unknown>): SessionValidation {
  const errors: string[] = [];
  const eventId = typeof input.eventId === "string" ? input.eventId : "";
  if (!eventId) errors.push("eventId is required");

  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) errors.push("label is required and must not be blank");

  const startAt = input.startAt;
  const endAt = input.endAt;
  const startDate = typeof startAt === "string" ? startAt : "";
  const endDate = typeof endAt === "string" ? endAt : "";

  if (!startDate || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startDate)) {
    errors.push("startAt must be ISO 8601 UTC string");
  }
  if (!endDate || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(endDate)) {
    errors.push("endAt must be ISO 8601 UTC string");
  }

  let startMs: number | null = null;
  let endMs: number | null = null;
  if (startDate) {
    const parsedStart = Date.parse(startDate);
    if (!Number.isFinite(parsedStart)) errors.push("startAt must be a valid datetime");
    else startMs = parsedStart;
  }
  if (endDate) {
    const parsedEnd = Date.parse(endDate);
    if (!Number.isFinite(parsedEnd)) errors.push("endAt must be a valid datetime");
    else endMs = parsedEnd;
  }

  if (startMs && endMs && endMs <= startMs) {
    errors.push("endAt must be after startAt");
  }

  const graceMin = typeof input.graceMin === "number" ? input.graceMin : 0;
  if (!Number.isInteger(graceMin) || graceMin < 0) {
    errors.push("graceMin must be a non-negative integer");
  }

  const sessionStatus = input.status;
  const statusValid =
    sessionStatus === undefined || sessionStatus === null ||
    SESSION_STATUSES.includes(sessionStatus as (typeof SESSION_STATUSES)[number]);
  if (!statusValid) {
    if (sessionStatus !== undefined && sessionStatus !== null) {
      errors.push(`session.status must be one of ${SESSION_STATUSES.join(", ")}`);
    }
  }

  if (!errors.length) {
    const sessionId = `sess_${eventId}_${Date.now()}`;
    return { ok: true, errors: [], sessionId };
  }
  return { ok: false, errors };
}
