"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

type Mapping = { name: number; email?: number; phone?: number; group?: number };
type Parsed = { headers: string[]; rows: string[][] };
type EventRecord = { eventId: string; name: string; eventDate: string; rosterMode: "closed" | "hybrid" | "open"; registrationsOpen: boolean; status: "planned" | "live" | "closed" };
type Session = { eventId: string; sessionId: string; label: string; startAt: string; endAt: string; graceMin: number; status: "planned" | "open" | "closed" };
type Attendee = { attendeeId: string; fullName: string; source: string; needsReview: boolean; mergedInto: string };
type Attendance = { tsUtc: string; sessionId: string; attendeeId: string; result: string; detail: string };
type Summary = { attendees: number; present: number; late: number; duplicates: number; collisions: number; pendingMirror: number };
type MirrorStatus = { pending: number; lagMs: number; warning: boolean; lastSuccessAt: string | null };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string; details?: string[] };
  if (!response.ok) throw new Error(body.error ?? body.details?.join(", ") ?? `Request failed (${response.status})`);
  return body;
}

export default function AdminPage() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [eventId, setEventId] = useState("");
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [qr, setQr] = useState<{ token: string; expiresAt: number; static: boolean } | null>(null);
  const [collisions, setCollisions] = useState<Attendee[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [eventForm, setEventForm] = useState({ name: "", eventDate: "", rosterMode: "hybrid" as EventRecord["rosterMode"], registrationsOpen: false, status: "planned" as EventRecord["status"] });
  const [sessionForm, setSessionForm] = useState({ label: "", startAt: "", endAt: "", graceMin: 10 });
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ name: 0 });
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [confirmReplace, setConfirmReplace] = useState(false);

  async function refreshEvents() {
    const body = await json<{ events: EventRecord[] }>("/api/admin/events");
    setEvents(body.events);
    if (!eventId && body.events[0]?.eventId) setEventId(body.events[0].eventId);
  }

  async function refreshEvent(id = eventId) {
    if (!id) return;
    const [eventBody, sessionBody, summaryBody, attendanceBody, collisionBody, mirrorBody] = await Promise.all([
      json<{ event: EventRecord | null }>(`/api/admin/events/${encodeURIComponent(id)}`),
      json<{ sessions: Session[] }>(`/api/admin/events/${encodeURIComponent(id)}/sessions`),
      json<{ counts: Summary }>(`/api/admin/events/${encodeURIComponent(id)}/summary`),
      json<{ attendance: Attendance[] }>(`/api/admin/events/${encodeURIComponent(id)}/attendance`),
      json<{ attendees: Attendee[] }>(`/api/admin/events/${encodeURIComponent(id)}/collisions`),
      json<MirrorStatus>(`/api/admin/events/${encodeURIComponent(id)}/mirror-status`),
    ]);
    setEvent(eventBody.event);
    setSessions(sessionBody.sessions);
    setSummary(summaryBody.counts);
    setAttendance(attendanceBody.attendance);
    setCollisions(collisionBody.attendees);
    setMirror(mirrorBody);
    if (eventBody.event) setEventForm({ name: eventBody.event.name, eventDate: eventBody.event.eventDate, rosterMode: eventBody.event.rosterMode, registrationsOpen: eventBody.event.registrationsOpen, status: eventBody.event.status });
  }

  useEffect(() => { void refreshEvents().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => { void refreshEvent().catch((error) => setMessage(error.message)); }, [eventId]);

  async function saveEvent() {
    if (!eventForm.name || !eventForm.eventDate) return setMessage("Event name and date required.");
    setBusy(true); setMessage("");
    try {
      const id = eventId || `evt_${eventForm.eventDate.replaceAll("-", "")}`;
      await json(`/api/admin/events/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...eventForm, eventId: id }) });
      setEventId(id); await refreshEvents(); await refreshEvent(id); setMessage("Event saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Event save failed"); }
    finally { setBusy(false); }
  }

  async function saveSession() {
    if (!eventId || !sessionForm.label || !sessionForm.startAt || !sessionForm.endAt) return setMessage("Event, label, start, and end required.");
    setBusy(true); setMessage("");
    try {
      const toUtc = (value: string) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
      await json(`/api/admin/events/${encodeURIComponent(eventId)}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...sessionForm, startAt: toUtc(sessionForm.startAt), endAt: toUtc(sessionForm.endAt) }) });
      setSessionForm({ label: "", startAt: "", endAt: "", graceMin: 10 }); await refreshEvent(); setMessage("Session created.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Session save failed"); }
    finally { setBusy(false); }
  }

  async function setSessionStatus(session: Session, status: Session["status"]) {
    try { await json(`/api/admin/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(session.sessionId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); await refreshEvent(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Session update failed"); }
  }

  async function loadQr(sessionId: string) {
    try { const body = await json<{ token: string; expiresAt: number; static: boolean }>(`/api/token/${encodeURIComponent(eventId)}/${encodeURIComponent(sessionId)}`); setQr(body); }
    catch (error) { setMessage(error instanceof Error ? error.message : "QR token failed"); }
  }

  async function loadFile(file: File) {
    try {
      let data: string[][];
      if (/\.csv$/i.test(file.name) || file.type === "text/csv") data = (await new Promise<Papa.ParseResult<string[]>>((resolve, reject) => Papa.parse<string[]>(file, { skipEmptyLines: "greedy", complete: resolve, error: reject }))).data;
      else { const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" }); const sheet = workbook.Sheets[workbook.SheetNames[0]]; if (!sheet) throw new Error("Workbook has no sheets"); data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false }); }
      if (!data.length || data.length > 10_001 || data.some((row) => row.length > 100)) throw new Error("File must contain 1–10,000 data rows and at most 100 columns");
      const normalized = data.map((row) => row.map((cell) => String(cell ?? "").slice(0, 10_000)));
      const first = normalized[0].map((cell) => cell.trim().toLowerCase());
      const known = ["name", "full name", "fullname", "attendee", "email", "phone", "group"];
      const hasHeader = first.some((cell) => known.includes(cell));
      const headers = hasHeader ? normalized.shift()!.map((cell, index) => cell.trim() || `Column ${index + 1}`) : normalized[0].map((_, index) => `Column ${index + 1}`);
      const column = (...names: string[]) => headers.findIndex((header) => names.includes(header.trim().toLowerCase()));
      setParsed({ headers, rows: normalized });
      setMapping({ name: Math.max(0, column("name", "full name", "fullname", "attendee")), ...(column("email") >= 0 ? { email: column("email") } : {}), ...(column("phone", "mobile") >= 0 ? { phone: column("phone", "mobile") } : {}), ...(column("group", "team", "department") >= 0 ? { group: column("group", "team", "department") } : {}) });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not parse file"); setParsed(null); }
  }

  async function importRoster() {
    if (!parsed || !eventId || (importMode === "replace" && !confirmReplace)) return setMessage("Select event and confirm replacement when needed.");
    try { const body = await json<{ counts: { new: number; matched: number; blank: number; invalid: number } }>(`/api/admin/events/${encodeURIComponent(eventId)}/roster/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: parsed.rows, mapping, mode: importMode, confirmReplace }) }); setMessage(`Imported ${body.counts.new} new, ${body.counts.matched} matched.`); setParsed(null); await refreshEvent(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Import failed"); }
  }

  async function merge(sourceId: string, targetId: string) {
    if (!targetId || targetId === sourceId) return;
    try { await json(`/api/admin/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(sourceId)}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId }) }); await refreshEvent(); setMessage("Attendee merged; source retained in audit history."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Merge failed"); }
  }

  return <main>
    <p className="eyebrow">Attendance system</p><h1>Admin console</h1><p className="lead">Operate events, sessions, roster, check-in, review, and export.</p>
    {message && <p className="notice" role="status">{message}</p>}
    <section><h2>Event</h2><label>Event<select value={eventId} onChange={(e) => setEventId(e.target.value)}><option value="">New event</option>{events.map((item) => <option key={item.eventId} value={item.eventId}>{item.eventId} — {item.name}</option>)}</select></label><div className="mapping-grid"><label>Name<input value={eventForm.name} onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })} /></label><label>Date<input type="date" value={eventForm.eventDate} onChange={(e) => setEventForm({ ...eventForm, eventDate: e.target.value })} /></label><label>Roster mode<select value={eventForm.rosterMode} onChange={(e) => setEventForm({ ...eventForm, rosterMode: e.target.value as EventRecord["rosterMode"] })}><option value="closed">closed</option><option value="hybrid">hybrid</option><option value="open">open</option></select></label><label>Status<select value={eventForm.status} onChange={(e) => setEventForm({ ...eventForm, status: e.target.value as EventRecord["status"] })}><option value="planned">planned</option><option value="live">live</option><option value="closed">closed</option></select></label></div><label className="confirm"><input type="checkbox" checked={eventForm.registrationsOpen} onChange={(e) => setEventForm({ ...eventForm, registrationsOpen: e.target.checked })} />Self-registration open</label><button disabled={busy} onClick={() => void saveEvent()}>Save event</button></section>
    {eventId && <><section><h2>Sessions</h2><div className="mapping-grid"><label>Label<input value={sessionForm.label} onChange={(e) => setSessionForm({ ...sessionForm, label: e.target.value })} /></label><label>Start<input type="datetime-local" value={sessionForm.startAt} onChange={(e) => setSessionForm({ ...sessionForm, startAt: e.target.value })} /></label><label>End<input type="datetime-local" value={sessionForm.endAt} onChange={(e) => setSessionForm({ ...sessionForm, endAt: e.target.value })} /></label><label>Grace minutes<input type="number" min="0" value={sessionForm.graceMin} onChange={(e) => setSessionForm({ ...sessionForm, graceMin: Number(e.target.value) })} /></label></div><button disabled={busy} onClick={() => void saveSession()}>Create session</button><ul>{sessions.map((session) => <li key={session.sessionId}><strong>{session.label}</strong> ({session.status}) — {new Date(session.startAt).toLocaleString()} <button onClick={() => void setSessionStatus(session, session.status === "open" ? "closed" : "open")}>{session.status === "open" ? "Close" : "Open"}</button> <button onClick={() => void loadQr(session.sessionId)}>Show QR token</button></li>)}</ul>{qr && <p className="notice" role="status"><code>{qr.token}</code> — expires {new Date(qr.expiresAt).toLocaleTimeString()}</p>}</section>
    <section><h2>Live counts</h2>{summary ? <ul><li>Active attendees: {summary.attendees}</li><li>Present: {summary.present}</li><li>Late: {summary.late}</li><li>Duplicates: {summary.duplicates}</li><li>Collisions: {summary.collisions}</li><li>Mirror pending: {summary.pendingMirror}</li></ul> : <p className="muted">Loading…</p>}{mirror && <p className="notice" role="status">Mirror: {mirror.pending} pending, lag {Math.floor(mirror.lagMs / 1000)}s.</p>}<a href={`/api/admin/events/${encodeURIComponent(eventId)}/export`} download>Download attendance CSV</a></section>
    <section><h2>Attendance review</h2>{attendance.length === 0 ? <p className="muted">No attendance records.</p> : <div className="table-wrap"><table><thead><tr><th>Time</th><th>Session</th><th>Attendee</th><th>Result</th><th>Detail</th></tr></thead><tbody>{attendance.map((row, index) => <tr key={`${row.tsUtc}-${index}`}><td>{row.tsUtc}</td><td>{row.sessionId}</td><td>{row.attendeeId}</td><td>{row.result}</td><td>{row.detail}</td></tr>)}</tbody></table></div>}</section>
    <section><h2>Collision review</h2>{collisions.length === 0 ? <p className="muted">No collisions.</p> : collisions.map((source) => <div key={source.attendeeId}><strong>{source.fullName}</strong><select aria-label={`Merge ${source.fullName}`} defaultValue="" onChange={(e) => void merge(source.attendeeId, e.target.value)}><option value="">Merge into…</option>{collisions.filter((target) => target.attendeeId !== source.attendeeId).map((target) => <option key={target.attendeeId} value={target.attendeeId}>{target.fullName}</option>)}</select></div>)}</section>
    <section><h2>Roster import</h2><label className="file-picker">CSV or XLSX file<input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => { const file = e.target.files?.[0]; if (file) void loadFile(file); }} /></label>{parsed && <><div className="mapping-grid">{([ ["Name", "name"], ["Email", "email"], ["Phone", "phone"], ["Group", "group"] ] as const).map(([label, key]) => <label key={key}>{label}<select value={mapping[key] ?? ""} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">Not mapped</option>{parsed.headers.map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}</div><label>Mode<select value={importMode} onChange={(e) => setImportMode(e.target.value as "merge" | "replace")}><option value="merge">Merge</option><option value="replace">Replace</option></select></label>{importMode === "replace" && <label className="confirm"><input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} />Confirm replacement</label>}<button onClick={() => void importRoster()}>Import roster</button></>}</section></>}
  </main>;
}
