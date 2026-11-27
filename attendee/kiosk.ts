import QRCode from "qrcode";

const root = document.querySelector<HTMLDivElement>("#app");
const params = new URLSearchParams(location.search);
const eventId = params.get("eventId") ?? "";
const sessionId = params.get("sessionId") ?? "";
const staticFallback = params.get("static") === "1";
let refreshTimer: number | undefined;

function escapeHostUrl(path: string): URL {
  return new URL(path, location.origin);
}

async function refreshQr() {
  if (!root || !eventId || !sessionId) return;
  try {
    const response = await fetch(`/api/token/${encodeURIComponent(eventId)}/${encodeURIComponent(sessionId)}${staticFallback ? "?static=1" : ""}`);
    const body = await response.json() as { token?: string; expiresAt?: number; error?: string };
    if (!response.ok || !body.token || !body.expiresAt) throw new Error(body.error ?? "Could not issue QR token");

    const checkInUrl = escapeHostUrl("/checkin.html");
    checkInUrl.searchParams.set("eventId", eventId);
    checkInUrl.searchParams.set("sessionId", sessionId);
    checkInUrl.searchParams.set("token", body.token);
    if (staticFallback) checkInUrl.searchParams.set("static", "1");

    const image = root.querySelector<HTMLImageElement>("#qr-image");
    if (image) {
      image.src = await QRCode.toDataURL(checkInUrl.toString(), {
        width: Math.min(520, Math.max(280, window.innerWidth - 80)),
        margin: 2,
        errorCorrectionLevel: "M",
      });
    }
    const expiry = root.querySelector<HTMLElement>("#qr-expiry");
    if (expiry) expiry.textContent = `Refreshes ${new Date(body.expiresAt).toLocaleTimeString()}`;

    if (refreshTimer) window.clearTimeout(refreshTimer);
    const refreshIn = staticFallback
      ? Math.max(60_000, body.expiresAt - Date.now() - 60_000)
      : Math.max(10_000, body.expiresAt - Date.now() - 10_000);
    refreshTimer = window.setTimeout(() => void refreshQr(), refreshIn);
  } catch (error) {
    const expiry = root.querySelector<HTMLElement>("#qr-expiry");
    if (expiry) expiry.textContent = error instanceof Error ? error.message : "QR unavailable";
  }
}

if (root) {
  if (!eventId || !sessionId) {
    root.replaceChildren(document.createTextNode("Add ?eventId=...&sessionId=... to the kiosk URL."));
  } else {
    root.innerHTML = `
      <section class="kiosk-card">
        <p class="eyebrow">Attendance kiosk</p>
        <h1>Scan to check in</h1>
        <img id="qr-image" alt="Attendance check-in QR code" width="520" height="520" />
        <p id="qr-expiry" role="status">Loading QR…</p>
        <p class="session">Event ${eventId} · Session ${sessionId}</p>
      </section>`;
    void refreshQr();
  }
}
