const base = (process.env.DEPLOY_URL ?? "").replace(/\/$/, "");
if (!base) throw new Error("DEPLOY_URL GitHub environment variable is required");

async function check(path, expectedStatus, predicate, init = {}) {
  const response = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  const text = await response.text();
  if (response.status !== expectedStatus || !predicate(text, response)) {
    throw new Error(`${path}: expected ${expectedStatus}, got ${response.status}`);
  }
  console.log(`${path}: ${response.status}`);
}

await check("/api/health", 200, (text) => JSON.parse(text).ok === true);
await check("/api/health/do", 200, (text) => JSON.parse(text).ok === true);
await check("/", 200, (text) => text.includes("<!DOCTYPE html>") || text.includes("<html"));
await check("/api/roster/selectable/__deployment_probe__", 200, (text, response) => response.headers.has("etag") && JSON.parse(text).ok === true);
await check("/api/checkin", 400, (text) => JSON.parse(text).error === "eventId and sessionId required", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await check("/api/self-register", 400, (text) => JSON.parse(text).error === "eventId required", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});

if (process.env.ADMIN_EXPECT_ACCESS === "true") {
  await check("/admin", 302, (_text, response) => Boolean(response.headers.get("location")?.includes("/cdn-cgi/access/login")));
  await check("/api/admin/events", 302, (_text, response) => Boolean(response.headers.get("location")?.includes("/cdn-cgi/access/login")));
}
