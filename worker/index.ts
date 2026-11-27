import { Hono } from "hono";
import { EventDurableObject } from "./event-do";
import { checkSheetConnection } from "./sheets";
import { verifyAccessJwt } from "./access";
import { MIRROR_LAG_WARNING_MS } from "./mirror";
import { flushMirrorEvent } from "./mirror-flush";
import { hasMirrorSecret } from "./internal-auth";
import { validateEvent } from "./validation.ts";

export { EventDurableObject };

export interface Env {
  ASSETS: Fetcher;
  EVENTS: DurableObjectNamespace;
  SHEET_ID: string;
  TZ_DISPLAY: string;
  GOOGLE_SA_JSON_B64?: string;
  QR_HMAC_SECRET?: string;
  MIRROR_INTERNAL_SECRET?: string;
  MIRROR_EVENT_IDS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

type RosterPayload = { ok?: boolean; version?: number; attendees?: unknown; etag?: string };

const app = new Hono<{ Bindings: Env }>();

async function requireAdmin(c: { req: { header(name: string): string | undefined }; env: Env }) {
  return verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD);
}

async function adminDo(c: { env: Env }, eventId: string, path: string, init?: RequestInit) {
  const id = c.env.EVENTS.idFromName(eventId);
  return c.env.EVENTS.get(id).fetch(`https://event.internal${path}`, init);
}

async function catalogDo(c: { env: Env }, path: string, init?: RequestInit) {
  const id = c.env.EVENTS.idFromName("__event-catalog__");
  return c.env.EVENTS.get(id).fetch(`https://event.internal${path}`, init);
}

async function syncCatalog(c: { env: Env }, event: { eventId: string; name: string; eventDate: string; status: string }) {
  await catalogDo(c, "/catalog/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "attendance",
    sheetConfigured: c.env.SHEET_ID !== "replace-after-creating-google-sheet",
    timezone: c.env.TZ_DISPLAY,
  }),
);

async function serveAdminPage(c: { req: { header(name: string): string | undefined; raw: Request }; env: Env }) {
  if (!(await requireAdmin(c))) return new Response("Admin authentication required", { status: 401 });
  return c.env.ASSETS.fetch(c.req.raw);
}

app.get("/admin", serveAdminPage);
app.get("/admin/", serveAdminPage);
app.get("/admin/*", serveAdminPage);

app.get("/api/health/do", async (c) => {
  const id = c.env.EVENTS.idFromName("health-check");
  return c.env.EVENTS.get(id).fetch("https://event.internal/health");
});

app.get("/api/admin/events", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  const response = await catalogDo(c, "/catalog/events");
  if (response.ok) return response;
  return c.json({ ok: true, events: [] });
});

app.get("/api/admin/events/:eventId", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), "/event");
});

app.put("/api/admin/events/:eventId", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  let payload: Record<string, unknown>;
  try { payload = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const validation = validateEvent(payload);
  if (!validation.ok) return c.json({ error: "Invalid event", details: validation.errors }, 400);
  const eventId = c.req.param("eventId");
  const response = await adminDo(c, eventId, "/event", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, eventId }) });
  if (response.ok) {
    const body = await response.clone().json() as { event?: { eventId: string; name: string; eventDate: string; status: string } };
    if (body.event) await syncCatalog(c, body.event);
  }
  return response;
});

app.get("/api/admin/events/:eventId/sessions", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), "/sessions");
});

app.post("/api/admin/events/:eventId/sessions", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), "/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: await c.req.text() });
});

app.patch("/api/admin/events/:eventId/sessions/:sessionId", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), `/sessions/${encodeURIComponent(c.req.param("sessionId"))}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: await c.req.text() });
});

app.get("/api/admin/events/:eventId/summary", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), "/summary");
});

app.get("/api/admin/events/:eventId/attendance", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  const query = c.req.query("sessionId") ? `?sessionId=${encodeURIComponent(c.req.query("sessionId")!)}` : "";
  return adminDo(c, c.req.param("eventId"), `/attendance${query}`);
});

app.get("/api/admin/events/:eventId/collisions", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), "/collisions");
});

app.post("/api/admin/events/:eventId/attendees/:attendeeId/merge", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  return adminDo(c, c.req.param("eventId"), `/attendees/${encodeURIComponent(c.req.param("attendeeId"))}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: await c.req.text() });
});

app.get("/api/admin/events/:eventId/export", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "Admin authentication required" }, 401);
  const query = c.req.query("sessionId") ? `?sessionId=${encodeURIComponent(c.req.query("sessionId")!)}` : "";
  return adminDo(c, c.req.param("eventId"), `/export${query}`);
});

app.post("/api/admin/events/:eventId/roster/import", async (c) => {
  if (!(await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  let payload: Record<string, unknown>;
  try { payload = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return c.json({ error: "Import body must be an object" }, 400);
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  return c.env.EVENTS.get(id).fetch("https://event.internal/roster/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, eventId: c.req.param("eventId") }) });
});

app.get("/api/admin/roster/:eventId/selectable", async (c) => {
  if (!(await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  const roster = await c.env.EVENTS.get(id).fetch("https://event.internal/roster/selectable");
  const body = (await roster.json()) as RosterPayload;
  return c.json({ ok: body.ok, version: body.version, attendees: body.attendees }, { headers: { ETag: body.etag ?? "roster-v0" } });
});

app.get("/api/admin/roster/:eventId", async (c) => {
  if (!(await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  const roster = await c.env.EVENTS.get(id).fetch("https://event.internal/roster");
  const body = (await roster.json()) as RosterPayload;
  return c.json({ ok: body.ok, version: body.version, attendees: body.attendees }, { headers: { ETag: body.etag ?? "roster-v0" } });
});

app.get("/api/roster/selectable/:eventId", async (c) => {
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  const roster = await c.env.EVENTS.get(id).fetch("https://event.internal/roster/selectable");
  const body = (await roster.json()) as RosterPayload;
  return c.json({ ok: body.ok, version: body.version, attendees: body.attendees }, { headers: { ETag: body.etag ?? "roster-v0" } });
});

app.get("/api/token/:eventId/:sessionId", async (c) => {
  const eventId = c.req.param("eventId");
  const sessionId = c.req.param("sessionId");
  const id = c.env.EVENTS.idFromName(eventId);
  const target = new URL("https://event.internal/token");
  target.searchParams.set("eventId", eventId);
  target.searchParams.set("sessionId", sessionId);
  if (c.req.query("static") === "1") target.searchParams.set("static", "1");
  if (!c.env.QR_HMAC_SECRET) return c.json({ error: "QR token secret is not configured" }, 503);
  return c.env.EVENTS.get(id).fetch(target, { headers: { "X-QR-Secret": c.env.QR_HMAC_SECRET } });
});

app.post("/api/self-register", async (c) => {
  let payload: unknown;
  try { payload = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const body = payload as { eventId?: string };
  if (!body.eventId) return c.json({ error: "eventId required" }, 400);
  const id = c.env.EVENTS.idFromName(body.eventId);
  return c.env.EVENTS.get(id).fetch("https://event.internal/self-register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
});

app.post("/api/internal/mirror/:eventId/flush", async (c) => {
  if (!hasMirrorSecret(c.req.raw, c.env.MIRROR_INTERNAL_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    return c.json(await flushMirrorEvent(c.req.param("eventId"), c.env));
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Mirror flush failed",
      },
      503,
    );
  }
});

app.post("/api/internal/mirror/:eventId/claim", async (c) => {
  if (!hasMirrorSecret(c.req.raw, c.env.MIRROR_INTERNAL_SECRET)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  return c.env.EVENTS.get(id).fetch("https://event.internal/mirror/claim", { method: "POST" });
});

app.post("/api/internal/mirror/:eventId/ack", async (c) => {
  if (!hasMirrorSecret(c.req.raw, c.env.MIRROR_INTERNAL_SECRET)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  return c.env.EVENTS.get(id).fetch("https://event.internal/mirror/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: await c.req.text() });
});

app.get("/api/admin/events/:eventId/mirror-status", async (c) => {
  if (!(await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) return c.json({ error: "Admin authentication required" }, 401);
  const id = c.env.EVENTS.idFromName(c.req.param("eventId"));
  return c.env.EVENTS.get(id).fetch("https://event.internal/mirror/status");
});

app.get("/api/admin/mirror-status", async (c) => {
  if (!(await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) {
    return c.json({ error: "Admin authentication required" }, 401);
  }
  const eventIds = [...new Set((c.env.MIRROR_EVENT_IDS ?? "").split(",").map((eventId) => eventId.trim()).filter(Boolean))];
  try {
    const events = await Promise.all(eventIds.map(async (eventId) => {
      const id = c.env.EVENTS.idFromName(eventId);
      const response = await c.env.EVENTS.get(id).fetch("https://event.internal/mirror/status");
      if (!response.ok) throw new Error(`Mirror status request failed for ${eventId}: ${response.status}`);
      const status = await response.json() as { pending: number; oldestAt: string | null; lagMs: number; lastAttemptAt: string | null; lastSuccessAt: string | null };
      return { eventId, ...status, warning: status.lagMs >= MIRROR_LAG_WARNING_MS };
    }));
    return c.json({
      ok: true,
      warningThresholdMs: MIRROR_LAG_WARNING_MS,
      warning: events.some((event) => event.warning),
      pending: events.reduce((total, event) => total + event.pending, 0),
      lagMs: Math.max(0, ...events.map((event) => event.lagMs)),
      events,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Mirror status unavailable" }, 503);
  }
});

app.post("/api/checkin", async (c) => {
  let payload: unknown;
  try { payload = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const body = payload as { eventId?: string; sessionId?: string };
  if (!body.eventId || !body.sessionId) return c.json({ error: "eventId and sessionId required" }, 400);
  if (!c.env.QR_HMAC_SECRET) return c.json({ error: "QR token secret is not configured" }, 503);
  const id = c.env.EVENTS.idFromName(body.eventId);
  return c.env.EVENTS.get(id).fetch("https://event.internal/checkin", { method: "POST", headers: { "Content-Type": "application/json", "X-QR-Secret": c.env.QR_HMAC_SECRET }, body: JSON.stringify(payload) });
});

app.get("/api/health/sheets", async (c) => {
  try {
    await checkSheetConnection(c.env);
    return c.json({ ok: true, service: "google-sheets" });
  } catch (error) {
    return c.json({ ok: false, service: "google-sheets", error: error instanceof Error ? error.message : "Unknown error" }, 503);
  }
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const eventIds = [...new Set((env.MIRROR_EVENT_IDS ?? "")
      .split(",")
      .map((eventId: string) => eventId.trim())
      .filter(Boolean))];

    ctx.waitUntil(
      Promise.all(
        eventIds.map(async (eventId: string) => {
          try {
            await flushMirrorEvent(eventId, env);
          } catch (error) {
            console.error(
              "Scheduled mirror flush failed",
              eventId,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      ),
    );
  },
};
