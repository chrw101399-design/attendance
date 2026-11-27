import {
  commitRosterImport,
  planRosterImport,
  selectableRosterFields,
  resolveSelfRegistration,
  type RosterAttendee,
} from "./roster.ts";
import { generateCheckInToken, generateStaticFallbackToken, type TokenConfig } from "./tokens.ts";
import { decideCheckIn, type AttendanceRecord, type SessionState } from "./checkin.ts";
import { changedAttendeeMirrorRows, MIRROR_CLAIM_LEASE_MS, MIRROR_LAG_WARNING_MS, mirrorLag, nextMirrorAttempt, type MirrorRow } from "./mirror.ts";
import { attendeesCsv, type CatalogEvent, type EventCounts, type EventRecord, type SessionRecord } from "./event-model.ts";
import { validateEvent, validateSession } from "./validation.ts";

export type RosterVersion = number;

export class EventDurableObject implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async alarm(): Promise<void> {
    // Drain legacy one-shot alarms; scheduled cron now owns mirror flushing.
    await this.state.storage.delete("mirrorAlarmReadyAt");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "event-durable-object" });
    if (url.pathname === "/roster" && request.method === "GET") return this.getRoster();
    if (url.pathname === "/roster/selectable" && request.method === "GET") return this.getSelectableRoster();
    if (url.pathname === "/token" && request.method === "GET") return this.getToken(url, request);
    if (url.pathname === "/checkin" && request.method === "POST") return this.checkIn(request);
    if (url.pathname === "/self-register" && request.method === "POST") return this.selfRegister(request);
    if (url.pathname === "/mirror/claim" && request.method === "POST") return this.claimMirror(request);
    if (url.pathname === "/mirror/ack" && request.method === "POST") return this.ackMirror(request);
    if (url.pathname === "/mirror/status" && request.method === "GET") return this.mirrorStatus();
    if (url.pathname === "/event" && request.method === "GET") return this.getEvent();
    if (url.pathname === "/event" && request.method === "PUT") return this.saveEvent(request);
    if (url.pathname === "/sessions" && request.method === "GET") return this.getSessions();
    if (url.pathname === "/sessions" && request.method === "POST") return this.createSession(request);
    if (url.pathname.startsWith("/sessions/") && request.method === "PATCH") return this.updateSession(url.pathname.slice("/sessions/".length), request);
    if (url.pathname === "/attendance" && request.method === "GET") return this.getAttendance(url);
    if (url.pathname === "/collisions" && request.method === "GET") return this.getCollisions();
    if (url.pathname.startsWith("/attendees/") && url.pathname.endsWith("/merge") && request.method === "POST") return this.mergeAttendee(url.pathname.split("/")[2], request);
    if (url.pathname === "/summary" && request.method === "GET") return this.getSummary();
    if (url.pathname === "/export" && request.method === "GET") return this.exportAttendance(url);
    if (url.pathname === "/catalog/events" && request.method === "GET") return this.getCatalog();
    if (url.pathname === "/catalog/events" && request.method === "POST") return this.addCatalogEvent(request);
    if (url.pathname === "/roster/import" && request.method === "POST") return this.importRoster(request);
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async getRoster(): Promise<Response> {
    const version = (await this.state.storage.get<RosterVersion>("rosterVersion")) ?? 0;
    return Response.json({ ok: true, version, attendees: await this.listActiveRoster() }, { headers: { ETag: `roster-v${version}` } });
  }

  async getSelectableRoster(): Promise<Response> {
    const version = (await this.state.storage.get<RosterVersion>("rosterVersion")) ?? 0;
    const attendees = (await this.listActiveRoster()).map(selectableRosterFields);
    return Response.json({ ok: true, version, attendees }, { headers: { ETag: `roster-v${version}` } });
  }

  private async listActiveRoster(): Promise<RosterAttendee[]> {
    const all = (await this.state.storage.get<RosterAttendee[]>("attendees")) ?? [];
    const activeIds = (await this.state.storage.get<string[]>("activeAttendeeIds")) ?? all.map((attendee) => attendee.attendeeId);
    return all.filter((attendee) => activeIds.includes(attendee.attendeeId));
  }

  private async getToken(url: URL, request: Request): Promise<Response> {
    const eventId = url.searchParams.get("eventId") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const staticToken = url.searchParams.get("static") === "1";
    const secret = request.headers.get("X-QR-Secret") ?? "";
    if (!eventId || !sessionId || !secret) return Response.json({ error: "eventId, sessionId, and secret required" }, { status: 400 });
    const session = (await this.state.storage.get<SessionRecord[]>("sessions") ?? []).find((item) => item.sessionId === sessionId);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    const now = Date.now();
    const config: TokenConfig = { toleranceMin: 2, lifetimeMin: 10, fallbackMin: 30 };
    const state = staticToken
      ? generateStaticFallbackToken(eventId, sessionId, now, config, secret)
      : generateCheckInToken(eventId, sessionId, now, config, secret);
    return Response.json({ ok: true, token: state.token, expiresAt: state.expiresAt, static: state.static });
  }

  private async enqueueMirror(txn: DurableObjectTransaction, row: MirrorRow): Promise<void> {
    const outbox = (await txn.get<MirrorRow[]>("mirrorOutbox")) ?? [];
    outbox.push(row);
    await txn.put("mirrorOutbox", outbox);
  }

  private async claimMirror(request: Request): Promise<Response> {
    const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 50)));
    const now = Date.now();
    const rows = await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      const outbox = (await txn.get<MirrorRow[]>("mirrorOutbox")) ?? [];
      const claimed: MirrorRow[] = [];
      const next = outbox.map((row) => {
        if (claimed.length >= limit || row.nextAttemptAt > now) return row;
        claimed.push({ ...row, nextAttemptAt: now + MIRROR_CLAIM_LEASE_MS });
        return { ...row, nextAttemptAt: now + MIRROR_CLAIM_LEASE_MS };
      });
      await txn.put("mirrorOutbox", next);
      return claimed;
    });
    return Response.json({ ok: true, rows });
  }

  private async ackMirror(request: Request): Promise<Response> {
    let body: { ids?: string[]; failedIds?: string[] };
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const ids = new Set(body.ids ?? []);
    const failed = new Set(body.failedIds ?? []);
    await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      const outbox = (await txn.get<MirrorRow[]>("mirrorOutbox")) ?? [];
      const now = Date.now();
      const next = outbox.filter((row) => !ids.has(row.id)).map((row) => failed.has(row.id) ? nextMirrorAttempt(row, now) : row);
      await txn.put("mirrorOutbox", next);
      await txn.put("mirrorLastAttemptAt", new Date(now).toISOString());
      if (ids.size) await txn.put("mirrorLastSuccessAt", new Date(now).toISOString());
    });
    return Response.json({ ok: true });
  }

  private async mirrorStatus(): Promise<Response> {
    const rows = (await this.state.storage.get<MirrorRow[]>("mirrorOutbox")) ?? [];
    const lag = mirrorLag(rows);
    return Response.json({
      ok: true,
      ...lag,
      warning: lag.lagMs >= MIRROR_LAG_WARNING_MS,
      warningThresholdMs: MIRROR_LAG_WARNING_MS,
      lastAttemptAt: await this.state.storage.get<string>("mirrorLastAttemptAt") ?? null,
      lastSuccessAt: await this.state.storage.get<string>("mirrorLastSuccessAt") ?? null,
    });
  }

  private async getEvent(): Promise<Response> {
    return Response.json({ ok: true, event: await this.state.storage.get<EventRecord>("event") ?? null });
  }

  private async saveEvent(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const existing = await this.state.storage.get<EventRecord>("event");
    const input = { ...body, status: body.status ?? existing?.status ?? "planned" };
    const validation = validateEvent(input);
    if (!validation.ok) return Response.json({ error: "Invalid event", details: validation.errors }, { status: 400 });
    const now = new Date().toISOString();
    const event: EventRecord = {
      eventId: typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : existing?.eventId ?? validation.eventId!,
      name: String(body.name).trim(),
      eventDate: String(body.eventDate),
      rosterMode: body.rosterMode as EventRecord["rosterMode"],
      registrationsOpen: typeof body.registrationsOpen === "boolean" ? body.registrationsOpen : existing?.registrationsOpen ?? false,
      status: input.status as EventRecord["status"],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      await txn.put("event", event);
      await this.enqueueMirror(txn, { id: `event:${event.eventId}:${event.updatedAt}`, tab: "Events", values: [event.eventId, event.name, event.eventDate, event.rosterMode, event.registrationsOpen, event.status], attempts: 0, nextAttemptAt: Date.now(), createdAt: event.createdAt });
    });
    return Response.json({ ok: true, event });
  }

  private async getSessions(): Promise<Response> {
    return Response.json({ ok: true, sessions: await this.state.storage.get<SessionRecord[]>("sessions") ?? [] });
  }

  private async createSession(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const event = await this.state.storage.get<EventRecord>("event");
    const validation = validateSession({ ...body, eventId: event?.eventId ?? body.eventId });
    if (!validation.ok) return Response.json({ error: "Invalid session", details: validation.errors }, { status: 400 });
    const session: SessionRecord = {
      eventId: event?.eventId ?? String(body.eventId),
      sessionId: validation.sessionId!,
      label: String(body.label).trim(),
      startAt: String(body.startAt),
      endAt: String(body.endAt),
      graceMin: Number(body.graceMin ?? 0),
      status: (body.status as SessionRecord["status"] | undefined) ?? "planned",
    };
    const sessions = await this.state.storage.get<SessionRecord[]>("sessions") ?? [];
    await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      await txn.put("sessions", [...sessions, session]);
      await this.enqueueMirror(txn, { id: `session:${session.sessionId}`, tab: "Sessions", values: [session.eventId, session.sessionId, session.label, session.startAt, session.endAt, session.graceMin, session.status], attempts: 0, nextAttemptAt: Date.now(), createdAt: session.startAt });
    });
    return Response.json({ ok: true, session }, { status: 201 });
  }

  private async updateSession(sessionId: string, request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const sessions = await this.state.storage.get<SessionRecord[]>("sessions") ?? [];
    const current = sessions.find((session) => session.sessionId === sessionId);
    if (!current) return Response.json({ error: "Session not found" }, { status: 404 });
    const merged = { ...current, ...body, sessionId, eventId: current.eventId };
    const validation = validateSession(merged);
    if (!validation.ok) return Response.json({ error: "Invalid session", details: validation.errors }, { status: 400 });
    const updated = { ...current, label: String(merged.label).trim(), startAt: String(merged.startAt), endAt: String(merged.endAt), graceMin: Number(merged.graceMin), status: merged.status as SessionRecord["status"] };
    await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      await txn.put("sessions", sessions.map((session) => session.sessionId === sessionId ? updated : session));
      await this.enqueueMirror(txn, { id: `session:${updated.sessionId}:${updated.status}:${updated.startAt}:${updated.endAt}`, tab: "Sessions", values: [updated.eventId, updated.sessionId, updated.label, updated.startAt, updated.endAt, updated.graceMin, updated.status], attempts: 0, nextAttemptAt: Date.now(), createdAt: updated.startAt });
    });
    return Response.json({ ok: true, session: updated });
  }

  private async getAttendance(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId");
    const attendance = (await this.state.storage.get<AttendanceRecord[]>("attendanceLog") ?? []).filter((record) => !sessionId || record.sessionId === sessionId);
    return Response.json({ ok: true, attendance });
  }

  private async getCollisions(): Promise<Response> {
    const attendees = (await this.state.storage.get<RosterAttendee[]>("attendees") ?? []).filter((attendee) => attendee.needsReview);
    return Response.json({ ok: true, attendees });
  }

  private async mergeAttendee(sourceId: string, request: Request): Promise<Response> {
    let body: { targetId?: string };
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (!body.targetId || body.targetId === sourceId) return Response.json({ error: "Different targetId required" }, { status: 400 });
    return this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      const attendees = (await txn.get<RosterAttendee[]>("attendees")) ?? [];
      const source = attendees.find((attendee) => attendee.attendeeId === sourceId);
      const target = attendees.find((attendee) => attendee.attendeeId === body.targetId);
      if (!source || !target) return Response.json({ error: "Attendee not found" }, { status: 404 });
      const updatedSource = { ...source, mergedInto: target.attendeeId, needsReview: false };
      await txn.put("attendees", attendees.map((attendee) => attendee.attendeeId === sourceId ? updatedSource : attendee));
      const activeIds = (await txn.get<string[]>("activeAttendeeIds")) ?? [];
      await txn.put("activeAttendeeIds", activeIds.filter((id) => id !== sourceId));
      const audit = await txn.get<Array<Record<string, unknown>>>("adminAuditLog") ?? [];
      audit.push({ action: "merge_attendee", sourceId, targetId: target.attendeeId, at: new Date().toISOString() });
      await txn.put("adminAuditLog", audit);
      await this.enqueueMirror(txn, { id: `attendee:${sourceId}:merged:${Date.now()}`, tab: "Attendees", values: [updatedSource.attendeeId, "", updatedSource.fullName, updatedSource.normalized, updatedSource.normalized, updatedSource.source, updatedSource.needsReview, updatedSource.createdAt, updatedSource.mergedInto], attempts: 0, nextAttemptAt: Date.now(), createdAt: updatedSource.createdAt });
      return Response.json({ ok: true, source: updatedSource, target });
    });
  }

  private async getSummary(): Promise<Response> {
    const activeIds = new Set(await this.state.storage.get<string[]>("activeAttendeeIds") ?? []);
    const attendees = (await this.state.storage.get<RosterAttendee[]>("attendees") ?? []).filter((attendee) => activeIds.has(attendee.attendeeId));
    const attendance = await this.state.storage.get<AttendanceRecord[]>("attendanceLog") ?? [];
    const outbox = await this.state.storage.get<MirrorRow[]>("mirrorOutbox") ?? [];
    const counts: EventCounts = { attendees: attendees.length, present: attendance.filter((record) => record.result === "present").length, late: attendance.filter((record) => record.result === "present_late").length, duplicates: attendance.filter((record) => record.result === "duplicate").length, collisions: attendees.filter((attendee) => attendee.needsReview).length, pendingMirror: outbox.length };
    return Response.json({ ok: true, counts });
  }

  private async exportAttendance(url: URL): Promise<Response> {
    const event = await this.state.storage.get<EventRecord>("event");
    const sessions = await this.state.storage.get<SessionRecord[]>("sessions") ?? [];
    const sessionId = url.searchParams.get("sessionId");
    const attendance = (await this.state.storage.get<AttendanceRecord[]>("attendanceLog") ?? []).filter((record) => !sessionId || record.sessionId === sessionId);
    const attendees = await this.state.storage.get<RosterAttendee[]>("attendees") ?? [];
    return new Response(attendeesCsv(event, attendees, sessions, attendance), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${event?.eventId ?? "attendance"}.csv"` } });
  }

  private async getCatalog(): Promise<Response> {
    return Response.json({ ok: true, events: await this.state.storage.get<CatalogEvent[]>("eventCatalog") ?? [] });
  }

  private async addCatalogEvent(request: Request): Promise<Response> {
    let event: CatalogEvent;
    try { event = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (!event.eventId || !event.name || !event.eventDate || !event.status) return Response.json({ error: "eventId, name, eventDate, status required" }, { status: 400 });
    const events = await this.state.storage.get<CatalogEvent[]>("eventCatalog") ?? [];
    const next = [...events.filter((item) => item.eventId !== event.eventId), event];
    await this.state.storage.put("eventCatalog", next);
    return Response.json({ ok: true, event });
  }

  private async selfRegister(request: Request): Promise<Response> {
    let body: { mode?: "closed" | "hybrid" | "open"; registrationsOpen?: boolean; fullName?: string; collisionAck?: boolean; eventId?: string; sessionId?: string; token?: string; clientReqId?: string; session?: SessionState; tokenSecret?: string };
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const event = await this.state.storage.get<EventRecord>("event");
    const mode = event?.rosterMode;
    const registrationsOpen = event?.registrationsOpen;
    if (!mode || typeof registrationsOpen !== "boolean" || !body.fullName?.trim()) return Response.json({ error: "Event configuration and fullName required" }, { status: 400 });
    return this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      const attendees = (await txn.get<RosterAttendee[]>("attendees")) ?? [];
      const activeIds = (await txn.get<string[]>("activeAttendeeIds")) ?? attendees.map((attendee) => attendee.attendeeId);
      const current = attendees.filter((attendee) => activeIds.includes(attendee.attendeeId));
      const resolved = resolveSelfRegistration(mode!, registrationsOpen!, body.fullName!, current, body.collisionAck === true);
      if (resolved.result !== "created") return Response.json(resolved);
      const attendee = resolved.attendee!;
      await txn.put("attendees", [...attendees, attendee]);
      await txn.put("activeAttendeeIds", [...activeIds, attendee.attendeeId]);
      await txn.put("rosterVersion", ((await txn.get<number>("rosterVersion")) ?? 0) + 1);
      await this.enqueueMirror(txn, { id: `attendee:${attendee.attendeeId}`, tab: "Attendees", values: [attendee.attendeeId, body.eventId ?? "", attendee.fullName, attendee.normalized, attendee.normalized, attendee.source, attendee.needsReview, attendee.createdAt, attendee.mergedInto], attempts: 0, nextAttemptAt: Date.now(), createdAt: attendee.createdAt });
      return Response.json(resolved);
    });
  }

  private async checkIn(request: Request): Promise<Response> {
    let body: { eventId?: string; sessionId?: string; attendeeId?: string; token?: string; clientReqId?: string; nowMs?: number; session?: SessionState };
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (!body.eventId || !body.sessionId || !body.attendeeId || !body.token || !body.clientReqId) {
      return Response.json({ error: "eventId, sessionId, attendeeId, token, clientReqId required" }, { status: 400 });
    }
    const storedSessions = (await this.state.storage.get<SessionRecord[]>("sessions")) ?? [];
    const storedSession = storedSessions.find((session) => session.sessionId === body.sessionId);
    const session = storedSession
      ? { status: storedSession.status, startAt: Date.parse(storedSession.startAt), endAt: Date.parse(storedSession.endAt), graceMin: storedSession.graceMin }
      : undefined;
    if (!session || !Number.isFinite(session.startAt) || !Number.isFinite(session.endAt)) return Response.json({ error: "Session not found" }, { status: 404 });
    const nowMs = Date.now();
    const result = await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
      const requestResults = (await txn.get<Record<string, AttendanceRecord>>("checkInRequests")) ?? {};
      const existing = (await txn.get<Record<string, AttendanceRecord>>("attendanceByKey")) ?? {};
      const prior = requestResults[body.clientReqId!];
      const key = `${body.sessionId}:${body.attendeeId}`;
      const attendees = (await txn.get<RosterAttendee[]>("attendees")) ?? [];
      const activeIds = (await txn.get<string[]>("activeAttendeeIds")) ?? attendees.map((attendee) => attendee.attendeeId);
      const decision = decideCheckIn({ eventId: body.eventId!, sessionId: body.sessionId!, attendeeId: body.attendeeId!, token: body.token!, clientReqId: body.clientReqId!, nowMs, session: session!, knownAttendee: activeIds.includes(body.attendeeId!), tokenSecret: request.headers.get("X-QR-Secret") ?? "", existing: existing[key], requestResult: prior });
      if (!prior) requestResults[body.clientReqId!] = decision;
      if (decision.result === "present" || decision.result === "present_late") existing[key] = decision;
      await txn.put("checkInRequests", requestResults);
      await txn.put("attendanceByKey", existing);
      const log = (await txn.get<AttendanceRecord[]>("attendanceLog")) ?? [];
      if (!prior) {
        log.push(decision);
        await txn.put("attendanceLog", log);
        await this.enqueueMirror(txn, { id: `attendance:${body.clientReqId!}`, tab: "AttendanceLog", values: [decision.tsUtc, decision.eventId, decision.sessionId, decision.attendeeId, "", decision.result, decision.detail, "", decision.clientReqId, ""], attempts: 0, nextAttemptAt: Date.now(), createdAt: decision.tsUtc });
      }
      return decision;
    });
    return Response.json({ ok: result.result === "present" || result.result === "present_late", ...result }, { status: 200 });
  }

  private async importRoster(request: Request): Promise<Response> {
    let body: { rows?: string[][]; mapping?: { name: number; email?: number; phone?: number; group?: number }; mode?: "merge" | "replace"; confirmReplace?: boolean; eventId?: string };
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (!Array.isArray(body.rows) || body.rows.length > 10_000 || body.rows.some((row) => !Array.isArray(row) || row.length > 100 || row.some((cell) => typeof cell !== "string" || cell.length > 10_000))) {
      return Response.json({ error: "rows must be a valid roster with at most 10,000 rows and 100 columns" }, { status: 400 });
    }
    if (!body.mapping || !Number.isInteger(body.mapping.name) || body.mapping.name < 0 || body.mapping.name >= 100 || !["merge", "replace"].includes(body.mode ?? "merge")) {
      return Response.json({ error: "Valid name mapping and import mode are required" }, { status: 400 });
    }
    try {
      const result = await this.state.storage.transaction(async (txn: DurableObjectTransaction) => {
        const all = (await txn.get<RosterAttendee[]>("attendees")) ?? [];
        const activeIds = (await txn.get<string[]>("activeAttendeeIds")) ?? all.map((attendee) => attendee.attendeeId);
        const current = all.filter((attendee) => activeIds.includes(attendee.attendeeId));
        const version = (await txn.get<number>("rosterVersion")) ?? 0;
        const plan = planRosterImport(body.rows!, body.mapping!, current);
        const committed = commitRosterImport(current, plan, { mode: body.mode ?? "merge", confirmReplace: body.confirmReplace === true }, version);
        await txn.put("attendees", committed.attendees);
        await txn.put("activeAttendeeIds", committed.activeIds);
        await txn.put("rosterVersion", committed.rosterVersion);
        const changedAttendees = changedAttendeeMirrorRows(
          current,
          committed.attendees,
          new Set(committed.activeIds),
          body.eventId ?? "",
        );
        for (const { attendee, values } of changedAttendees) {
          await this.enqueueMirror(txn, {
            id: `attendee:${attendee.attendeeId}:v${committed.rosterVersion}`,
            tab: "Attendees",
            values,
            attempts: 0,
            nextAttemptAt: Date.now(),
            createdAt: attendee.createdAt,
          });
        }
        await txn.put("lastImportAt", new Date().toISOString());
        return { ...committed, counts: plan.counts };
      });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      return Response.json({ error: message }, { status: message.includes("confirmation") ? 409 : 400 });
    }
  }
}
