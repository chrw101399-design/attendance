type SelectableAttendee = { id: string; display: string; hint: string };
type RosterResponse = { ok: boolean; version: number; attendees: SelectableAttendee[] };
type CheckInResponse = { ok: boolean; result: string; detail?: string };
type SelfRegisterResponse =
  | { result: "created"; attendee: { attendeeId: string } }
  | { result: "existing_match"; matches: Array<{ attendeeId: string; fullName: string }> }
  | { result: "rejected_closed"; error?: string };

const root = document.querySelector<HTMLDivElement>("#app");
const params = new URLSearchParams(location.search);
const eventId = params.get("eventId") ?? "";
const sessionId = params.get("sessionId") ?? "";
let token = params.get("token") ?? "";
const staticFallback = params.get("static") === "1";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function showMessage(container: HTMLElement, text: string, kind: "ok" | "error" | "info" = "info") {
  container.replaceChildren(element("p", `notice ${kind}`, text));
}

async function loadToken() {
  if (token) return;
  const response = await fetch(`/api/token/${encodeURIComponent(eventId)}/${encodeURIComponent(sessionId)}${staticFallback ? "?static=1" : ""}`);
  const body = await response.json() as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error ?? "Could not issue check-in token");
  token = body.token;
}

async function checkIn(attendeeId: string, notice: HTMLElement) {
  showMessage(notice, "Submitting attendance…");
  try {
    await loadToken();
    const body = await jsonRequest<CheckInResponse>("/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sessionId,
        attendeeId,
        token,
        clientReqId: clientRequestId(),
      }),
    });
    if (body.result === "present") showMessage(notice, "Check-in confirmed.", "ok");
    else if (body.result === "present_late") showMessage(notice, "Late check-in confirmed.", "ok");
    else if (body.result === "duplicate") showMessage(notice, "You are already checked in.", "info");
    else if (body.detail === "outside_session_window") showMessage(notice, "This session is outside its scheduled time. Ask the event operator to open the correct session.", "error");
    else if (body.detail === "session_not_open") showMessage(notice, "This session is not open yet. Ask the event operator to open it.", "error");
    else showMessage(notice, `Check-in was not accepted: ${body.detail ?? body.result}`, "error");
  } catch (error) {
    showMessage(notice, error instanceof Error ? error.message : "Check-in failed. Please retry.", "error");
  }
}

async function selfRegister(fullName: string, attendeeIdInput: HTMLInputElement, notice: HTMLElement) {
  showMessage(notice, "Checking registration…");
  try {
    const body = await jsonRequest<SelfRegisterResponse>("/api/self-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, sessionId, token, fullName }),
    });
    if (body.result === "created") {
      await checkIn(body.attendee.attendeeId, notice);
      return;
    }
    if (body.result === "existing_match") {
      const prompt = element("div", "identity-options");
      prompt.appendChild(element("p", "info", "This name matches an existing attendee."));
      for (const match of body.matches) {
        const me = element("button", "secondary", `This is ${match.fullName}`);
        me.type = "button";
        me.addEventListener("click", () => void checkIn(match.attendeeId, notice));
        prompt.appendChild(me);
      }
      const other = element("button", "primary", "This is a different person");
      other.type = "button";
      other.addEventListener("click", () => void selfRegisterDifferent(fullName, notice));
      prompt.appendChild(other);
      notice.replaceChildren(prompt);
      return;
    }
    showMessage(notice, "Self-registration is closed. Please choose your imported roster name.", "error");
  } catch (error) {
    attendeeIdInput.focus();
    showMessage(notice, error instanceof Error ? error.message : "Registration failed.", "error");
  }
}

async function selfRegisterDifferent(fullName: string, notice: HTMLElement) {
  showMessage(notice, "Registering and checking in…");
  try {
    const body = await jsonRequest<SelfRegisterResponse>("/api/self-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, sessionId, token, fullName, collisionAck: true }),
    });
    if (body.result === "created") await checkIn(body.attendee.attendeeId, notice);
    else showMessage(notice, "This person could not be registered.", "error");
  } catch (error) {
    showMessage(notice, error instanceof Error ? error.message : "Registration failed.", "error");
  }
}

if (root) {
  const normalizedToken = token.trim();
  if (normalizedToken.startsWith("http://") || normalizedToken.startsWith("https://")) {
    try {
      const scannedUrl = new URL(normalizedToken);
      token = scannedUrl.searchParams.get("token") ?? token;
    } catch { /* keep original token for normal validation */ }
  }
  if (!eventId || !sessionId || !token) {
    root.replaceChildren(element("section", "card", "Invalid or incomplete QR link."));
  } else {
    void (async () => {
      root.replaceChildren(element("p", "info", "Loading roster…"));
      try {
        const roster = await jsonRequest<RosterResponse>(`/api/roster/selectable/${encodeURIComponent(eventId)}`);
        const card = element("section", "card");
        card.appendChild(element("p", "eyebrow", "Attendance check-in"));
        card.appendChild(element("h1", "", "Find your name"));
        const form = element("form");
        const label = element("label", "", "Name");
        const input = element("input");
        input.type = "text";
        input.autocomplete = "name";
        input.placeholder = "Start typing";
        input.required = true;
        label.appendChild(input);
        form.appendChild(label);
        const suggestions = element("div", "suggestions");
        suggestions.setAttribute("aria-live", "polite");
        form.appendChild(suggestions);
        const notice = element("div", "notice");
        form.appendChild(notice);

        let selectedId = "";
        input.addEventListener("input", () => {
          selectedId = "";
          const query = input.value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
          suggestions.replaceChildren();
          if (!query) return;
          const matches = roster.attendees
            .filter((attendee) => `${attendee.display} ${attendee.hint}`.toLowerCase().includes(query))
            .slice(0, 8);
          for (const attendee of matches) {
            const button = element("button", "suggestion", attendee.display);
            button.type = "button";
            button.addEventListener("click", () => {
              input.value = attendee.display;
              selectedId = attendee.id;
              suggestions.replaceChildren();
              input.focus();
            });
            suggestions.appendChild(button);
          }
        });

        const submit = element("button", "primary", "Check in");
        submit.type = "submit";
        form.appendChild(submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const fullName = input.value.trim();
          if (!fullName) return showMessage(notice, "Enter your name.", "error");
          if (selectedId) void checkIn(selectedId, notice);
          else void selfRegister(fullName, input, notice);
        });

        card.appendChild(form);
        root.replaceChildren(card);
      } catch (error) {
        root.replaceChildren(element("section", "card", error instanceof Error ? error.message : "Could not load the roster."));
      }
    })();
  }
}
