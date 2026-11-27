export type RosterAttendee = {
  attendeeId: string;
  fullName: string;
  normalized: string;
  email: string;
  phone: string;
  group: string;
  source: "import" | "self";
  needsReview: boolean;
  createdAt: string;
  mergedInto: string;
};

export type RosterVersion = number;

export type SelectableAttendee = {
  id: string;
  display: string;
  hint: string;
};

export function selectableRosterFields(attendee: RosterAttendee): SelectableAttendee {
  return {
    id: attendee.attendeeId,
    display: attendee.fullName,
    hint: attendee.normalized,
  };
}

export type RosterMapping = { name: number; email?: number; phone?: number; group?: number };
export type SelfRegistrationResult = { result: "created" | "existing_match" | "rejected_closed"; attendee?: RosterAttendee; matches?: RosterAttendee[] };

export function resolveSelfRegistration(mode: "closed" | "hybrid" | "open", registrationsOpen: boolean, fullName: string, current: RosterAttendee[], collisionAck = false): SelfRegistrationResult {
  if (mode === "closed" || !registrationsOpen) return { result: "rejected_closed" };
  const normalized = normalizeAttendeeName(fullName);
  if (!normalized || fullName.trim().length > 200) return { result: "rejected_closed" };
  const matches = current.filter((attendee) => attendee.normalized === normalized);
  if (matches.length && !collisionAck) return { result: "existing_match", matches };
  return {
    result: "created",
    attendee: {
      attendeeId: `att_${crypto.randomUUID()}`,
      fullName: fullName.trim().replace(/\s+/g, " "),
      normalized,
      email: "",
      phone: "",
      group: "",
      source: "self",
      needsReview: matches.length > 0,
      createdAt: new Date().toISOString(),
      mergedInto: "",
    },
  };
}
export type ImportCounts = { new: number; matched: number; blank: number; invalid: number };
export type ImportPlan = { attendees: RosterAttendee[]; counts: ImportCounts };

export function normalizeAttendeeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function identifierKey(email: string, phone: string): string {
  return email ? `email:${email.trim().toLocaleLowerCase("en-US")}` : phone ? `phone:${phone.replace(/\D/g, "")}` : "";
}

function makeId(): string {
  return `att_${crypto.randomUUID()}`;
}

export function planRosterImport(rows: string[][], mapping: RosterMapping, current: RosterAttendee[], now = new Date().toISOString()): ImportPlan {
  if (!Number.isInteger(mapping.name) || mapping.name < 0) throw new Error("Name column mapping is required");
  const currentNames = new Map(current.map((attendee) => [attendee.normalized, attendee]));
  const currentIdentifiers = new Map<string, RosterAttendee>();
  for (const attendee of current) {
    const key = identifierKey(attendee.email, attendee.phone);
    if (key && !currentIdentifiers.has(key)) currentIdentifiers.set(key, attendee);
  }
  const stagedNames = new Set<string>();
  const attendees: RosterAttendee[] = [];
  const counts: ImportCounts = { new: 0, matched: 0, blank: 0, invalid: 0 };

  for (const row of rows) {
    const fullName = (row[mapping.name] ?? "").trim().replace(/\s+/g, " ");
    if (!fullName) { counts.blank++; continue; }
    if (fullName.length > 200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(fullName)) { counts.invalid++; continue; }
    const email = (row[mapping.email ?? -1] ?? "").trim();
    const phone = (row[mapping.phone ?? -1] ?? "").trim();
    const group = (row[mapping.group ?? -1] ?? "").trim();
    const normalized = normalizeAttendeeName(fullName);
    if (!normalized || stagedNames.has(normalized)) { counts.invalid++; continue; }
    stagedNames.add(normalized);
    const stableId = identifierKey(email, phone) ? currentIdentifiers.get(identifierKey(email, phone)) : undefined;
    const match = stableId ?? currentNames.get(normalized);
    if (match) {
      counts.matched++;
      attendees.push({ ...match, fullName, normalized, email: email || match.email, phone: phone || match.phone, group, source: "import" });
    } else {
      counts.new++;
      attendees.push({ attendeeId: makeId(), fullName, normalized, email, phone, group, source: "import", needsReview: false, createdAt: now, mergedInto: "" });
    }
  }
  return { attendees, counts };
}

export function commitRosterImport(current: RosterAttendee[], plan: ImportPlan, options: { mode: "merge" | "replace"; confirmReplace: boolean }, version = 0): { attendees: RosterAttendee[]; activeIds: string[]; rosterVersion: number } {
  if (options.mode === "replace" && !options.confirmReplace) throw new Error("Explicit confirmation is required for roster replacement");
  const byId = new Map(current.map((attendee) => [attendee.attendeeId, attendee]));
  const incoming = plan.attendees.map((attendee) => ({ ...byId.get(attendee.attendeeId), ...attendee }));
  const activeIds = options.mode === "replace"
    ? incoming.map((attendee) => attendee.attendeeId)
    : [...new Set([...current.map((attendee) => attendee.attendeeId), ...incoming.map((attendee) => attendee.attendeeId)])];
  return { attendees: [...new Map([...current, ...incoming].map((attendee) => [attendee.attendeeId, attendee])).values()], activeIds, rosterVersion: version + 1 };
}
