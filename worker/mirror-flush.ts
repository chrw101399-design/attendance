import type { Env } from "./index";
import { appendMirrorRows, readMirrorIds, type MirrorAppendRow } from "./sheets.ts";
import { partitionMirrorRows, type MirrorRow } from "./mirror.ts";

export type MirrorFlushResult = {
  ok: boolean;
  claimed: number;
  written: number;
  skipped: number;
  failed: number;
};

type MirrorSheets = {
  readMirrorIds(env: Env): Promise<Set<string>>;
  appendMirrorRows(env: Env, rows: MirrorAppendRow[]): Promise<void>;
};

const defaultSheets: MirrorSheets = { readMirrorIds, appendMirrorRows };

export async function flushMirrorEvent(
  eventId: string,
  env: Env,
  sheets: MirrorSheets = defaultSheets,
): Promise<MirrorFlushResult> {
  const id = env.EVENTS.idFromName(eventId);
  const headers = { "X-Mirror-Secret": env.MIRROR_INTERNAL_SECRET ?? "" };
  const claimed = await env.EVENTS.get(id).fetch(
    "https://event.internal/mirror/claim",
    { method: "POST", headers },
  );
  if (!claimed.ok) throw new Error(`Mirror claim failed for ${eventId}: ${claimed.status}`);

  const body = await claimed.json() as { rows?: MirrorRow[] };
  const rows = body.rows ?? [];
  if (!rows.length) return { ok: true, claimed: 0, written: 0, skipped: 0, failed: 0 };

  const acknowledge = async (ids: string[], failedIds: string[]) => {
    const response = await env.EVENTS.get(id).fetch(
      "https://event.internal/mirror/ack",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ids, failedIds }),
      },
    );
    if (!response.ok) throw new Error(`Mirror ack failed for ${eventId}: ${response.status}`);
  };

  let alreadyWritten: Set<string>;
  try {
    alreadyWritten = await sheets.readMirrorIds(env);
  } catch (error) {
    await acknowledge([], rows.map((row) => row.id));
    throw new Error(`Mirror index read failed for ${eventId}: ${error instanceof Error ? error.message : error}`);
  }

  const partition = partitionMirrorRows(rows, alreadyWritten);
  try {
    await sheets.appendMirrorRows(env, partition.pending);
  } catch (error) {
    await acknowledge(partition.alreadyWrittenIds, partition.pending.map((row) => row.id));
    throw new Error(`Atomic Google Sheets mirror write failed for ${eventId}: ${error instanceof Error ? error.message : error}`);
  }
  await acknowledge([...partition.alreadyWrittenIds, ...partition.pending.map((row) => row.id)], []);

  return {
    ok: true,
    claimed: rows.length,
    written: partition.pending.length,
    skipped: partition.alreadyWrittenIds.length,
    failed: 0,
  };
}
