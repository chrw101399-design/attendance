import type { RosterAttendee } from "./roster";

export type MirrorRow = { id: string; tab: string; values: unknown[]; attempts: number; nextAttemptAt: number; createdAt: string };
export type AttendeeMirrorChange = { attendee: RosterAttendee; values: unknown[] };

export const MIRROR_CLAIM_LEASE_MS = 5 * 60_000;
export const MIRROR_LAG_WARNING_MS = 5 * 60_000;

function attendeeMirrorValues(attendee: RosterAttendee, eventId: string): unknown[] {
  return [
    attendee.attendeeId,
    eventId,
    attendee.fullName,
    attendee.normalized,
    attendee.normalized,
    attendee.source,
    attendee.needsReview,
    attendee.createdAt,
    attendee.mergedInto,
  ];
}

export function changedAttendeeMirrorRows(
  current: RosterAttendee[],
  updated: RosterAttendee[],
  activeIds: ReadonlySet<string>,
  eventId: string,
): AttendeeMirrorChange[] {
  const currentById = new Map(current.map((attendee) => [attendee.attendeeId, attendee]));
  return updated.flatMap((attendee) => {
    if (!activeIds.has(attendee.attendeeId)) return [];
    const values = attendeeMirrorValues(attendee, eventId);
    const existing = currentById.get(attendee.attendeeId);
    if (existing && JSON.stringify(attendeeMirrorValues(existing, eventId)) === JSON.stringify(values)) return [];
    return [{ attendee, values }];
  });
}

export function nextMirrorAttempt(row: MirrorRow, now = Date.now()): MirrorRow {
  const attempts = row.attempts + 1;
  return { ...row, attempts, nextAttemptAt: now + Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 10)) };
}

export function partitionMirrorRows<T extends Pick<MirrorRow, "id">>(
  rows: T[],
  alreadyWritten: ReadonlySet<string>,
): { pending: T[]; alreadyWrittenIds: string[] } {
  const pending: T[] = [];
  const alreadyWrittenIds: string[] = [];
  for (const row of rows) {
    if (alreadyWritten.has(row.id)) alreadyWrittenIds.push(row.id);
    else pending.push(row);
  }
  return { pending, alreadyWrittenIds };
}

export function mirrorLag(rows: MirrorRow[], now = Date.now()): { pending: number; oldestAt: string | null; lagMs: number } {
  const oldest = rows.map((row) => Date.parse(row.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { pending: rows.length, oldestAt: oldest === undefined ? null : new Date(oldest).toISOString(), lagMs: oldest === undefined ? 0 : Math.max(0, now - oldest) };
}
