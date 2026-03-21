import { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";
import { appendEvent, getEvents } from "./events.js";
import { applyEvent } from "./projections.js";
import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
} from "../src/engine/schedule.js";
import { getTodayStats } from "../src/engine/stats.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry } from "../types.js";

/** Convert DB row type (string) to SleepEntry type ("nap" | "night"). */
function toSleepEntry(s: SleepLogRow): SleepEntry {
  return { start_time: s.start_time, end_time: s.end_time, type: s.type as SleepEntry["type"] };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SSE connected clients
const sseClients = new Set<ServerResponse>();

function broadcast(eventType: string, data: Record<string, unknown>) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}
const distDir =
  process.env.NODE_ENV === "production" ? __dirname : path.join(__dirname, "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

async function serveStatic(res: ServerResponse, filePath: string) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function getState() {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby)
    return { baby: null, activeSleep: null, todaySleeps: [], stats: null, prediction: null };

  let activeSleep = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND end_time IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1",
    )
    .get(baby.id) as SleepLogRow | undefined;

  if (activeSleep) {
    const pauses = db
      .prepare("SELECT * FROM sleep_pauses WHERE sleep_id = ? ORDER BY pause_time ASC")
      .all(activeSleep.id) as SleepPauseRow[];
    activeSleep = { ...activeSleep, pauses };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Use local date to match the projection logic
  const year = todayStart.getFullYear();
  const month = String(todayStart.getMonth() + 1).padStart(2, "0");
  const day = String(todayStart.getDate()).padStart(2, "0");
  const todayDateStr = `${year}-${month}-${day}`;

  const todaySleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, todayStart.toISOString()) as SleepLogRow[];

  const todayWakeUp = db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? AND date = ?")
    .get(baby.id, todayDateStr) as DayStartRow | undefined;

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentSleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, weekAgo) as SleepLogRow[];

  const ageMonths = calculateAgeMonths(baby.birthdate);
  // Batch-fetch pauses for all today's sleeps (avoids N+1 query)
  const todaySleepIds = todaySleeps.map((s) => s.id);
  const pausesBySlept = new Map<number, SleepPauseRow[]>();
  if (todaySleepIds.length > 0) {
    const allPauses = db
      .prepare(
        `SELECT * FROM sleep_pauses WHERE sleep_id IN (${todaySleepIds.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
      )
      .all(...todaySleepIds) as SleepPauseRow[];
    for (const p of allPauses) {
      if (!pausesBySlept.has(p.sleep_id)) pausesBySlept.set(p.sleep_id, []);
      pausesBySlept.get(p.sleep_id)!.push(p);
    }
  }

  const todaySleepsWithPauses = todaySleeps.map((s) => ({
    ...toSleepEntry(s),
    pauses: pausesBySlept.get(s.id) || [],
  }));
  const stats = getTodayStats(todaySleepsWithPauses);

  let prediction = null;
  if (!activeSleep) {
    const lastCompleted = todaySleeps.find((s) => s.end_time);
    const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

    if (wakeTimeForPrediction) {
      const customNaps = baby.custom_nap_count ?? null;
      const bedtime = recommendBedtime(
        todaySleeps.map(toSleepEntry),
        ageMonths,
        customNaps,
      );

      // Predict remaining naps for the day, accounting for completed naps
      let predictedNaps = null;
      if (todayWakeUp) {
        const allPredicted = predictDayNaps(
          todayWakeUp.wake_time,
          ageMonths,
          recentSleeps.map(toSleepEntry),
          customNaps,
        );
        // Filter out predictions that overlap with completed naps
        const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
        predictedNaps = allPredicted.slice(completedNaps.length);
      }

      prediction = {
        nextNap: predictNextNap(
          wakeTimeForPrediction,
          ageMonths,
          recentSleeps.map(toSleepEntry),
        ),
        bedtime,
        predictedNaps,
      };
    }
  }

  const todayDiapers = db
    .prepare(
      "SELECT COUNT(*) as count FROM diaper_log WHERE baby_id = ? AND time >= ? AND deleted = 0",
    )
    .get(baby.id, todayStart.toISOString()) as { count: number } | undefined;
  const diaperCount = todayDiapers?.count ?? 0;

  const lastDiaper = db
    .prepare(
      "SELECT time FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC LIMIT 1",
    )
    .get(baby.id) as { time: string } | undefined;
  const lastDiaperTime = lastDiaper?.time ?? null;

  return {
    baby,
    activeSleep,
    todaySleeps,
    stats,
    prediction,
    ageMonths,
    diaperCount,
    lastDiaperTime,
    todayWakeUp,
  };
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const method = req.method || "GET";

  if (url.pathname.startsWith("/api/")) {
    console.log(`[${new Date().toISOString()}] ${method} ${url.pathname}`);
  }

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // SSE stream
  if (url.pathname === "/api/stream" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders();
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (err) {
        console.error("SSE heartbeat failed:", err);
      }
    }, 30000);
    req.on("close", () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
    });
    return;
  }

  // API routes
  if (url.pathname === "/api/state" && method === "GET") {
    return json(res, getState());
  }

  if (url.pathname === "/api/events" && method === "GET") {
    const since = url.searchParams.get("since");
    return json(res, getEvents(since ? parseInt(since) : undefined));
  }

  if (url.pathname === "/api/events" && method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const results = [];
      for (const evt of body.events || [body]) {
        const event = appendEvent(evt.type, evt.payload, evt.clientId, evt.clientEventId);
        if (!event) continue; // Duplicate event, skip
        applyEvent(event);
        results.push(event);
      }
      const state = getState();
      broadcast("update", { state });
      return json(res, { events: results, state });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Request body too large") {
        return json(res, { error: message }, 413);
      }
      console.error(`[ERROR] POST /api/events:`, message);
      return json(res, { error: message }, 500);
    }
  }

  if (url.pathname === "/api/sleeps" && method === "GET") {
    const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as
      | Baby
      | undefined;
    if (!baby) return json(res, []);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = url.searchParams.get("limit") || "50";
    let sql = "SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0";
    const params: (string | number)[] = [baby.id];
    if (from) {
      sql += " AND start_time >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND start_time <= ?";
      params.push(to);
    }
    sql += " ORDER BY start_time DESC LIMIT ?";
    params.push(parseInt(limit));
    const sleeps = db.prepare(sql).all(...params) as SleepLogRow[];
    // Batch-fetch pauses for all returned sleeps
    const sleepIds = sleeps.map((s) => s.id);
    if (sleepIds.length > 0) {
      const allPauses = db
        .prepare(
          `SELECT * FROM sleep_pauses WHERE sleep_id IN (${sleepIds.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
        )
        .all(...sleepIds) as SleepPauseRow[];
      const grouped = new Map<number, SleepPauseRow[]>();
      for (const p of allPauses) {
        if (!grouped.has(p.sleep_id)) grouped.set(p.sleep_id, []);
        grouped.get(p.sleep_id)!.push(p);
      }
      for (const s of sleeps) {
        s.pauses = grouped.get(s.id) || [];
      }
    } else {
      for (const s of sleeps) s.pauses = [];
    }
    return json(res, sleeps);
  }

  if (url.pathname === "/api/diapers" && method === "GET") {
    const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as
      | Baby
      | undefined;
    if (!baby) return json(res, []);
    const from = url.searchParams.get("from");
    const limit = url.searchParams.get("limit") || "50";
    let sql = "SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0";
    const params: (string | number)[] = [baby.id];
    if (from) {
      sql += " AND time >= ?";
      params.push(from);
    }
    sql += " ORDER BY time DESC LIMIT ?";
    params.push(parseInt(limit));
    return json(res, db.prepare(sql).all(...params));
  }

  // Data export
  if (url.pathname === "/api/export" && method === "GET") {
    const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as
      | Baby
      | undefined;
    if (!baby) return json(res, { error: "No baby configured" }, 404);

    const format = url.searchParams.get("format") || "json";
    const sleeps = db
      .prepare(
        "SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0 ORDER BY start_time DESC",
      )
      .all(baby.id) as SleepLogRow[];

    // Batch-fetch pauses
    const sIds = sleeps.map((s) => s.id);
    if (sIds.length > 0) {
      const pAll = db
        .prepare(
          `SELECT * FROM sleep_pauses WHERE sleep_id IN (${sIds.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
        )
        .all(...sIds) as SleepPauseRow[];
      const pMap = new Map<number, SleepPauseRow[]>();
      for (const p of pAll) {
        if (!pMap.has(p.sleep_id)) pMap.set(p.sleep_id, []);
        pMap.get(p.sleep_id)!.push(p);
      }
      for (const s of sleeps) s.pauses = pMap.get(s.id) || [];
    }

    const diapers = db
      .prepare(
        "SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC",
      )
      .all(baby.id);

    const dayStarts = db
      .prepare("SELECT * FROM day_start WHERE baby_id = ? ORDER BY date DESC")
      .all(baby.id);

    if (format === "csv") {
      const lines = ["type,start,end,sleep_type,mood,method,notes"];
      for (const s of sleeps) {
        lines.push(
          [
            "sleep",
            s.start_time,
            s.end_time || "",
            s.type,
            s.mood || "",
            s.method || "",
            (s.notes || "").replace(/,/g, ";"),
          ].join(","),
        );
      }
      for (const d of diapers as { time: string; type: string; amount: string | null; note: string | null }[]) {
        lines.push(
          ["diaper", d.time, "", d.type, "", "", (d.note || "").replace(/,/g, ";")].join(","),
        );
      }
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=babysovelogg-export.csv",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(lines.join("\n"));
      return;
    }

    return json(res, { baby, sleeps, diapers, dayStarts });
  }

  // Static files
  let filePath: string;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    filePath = path.join(distDir, "index.html");
  } else {
    filePath = path.join(distDir, url.pathname);
  }

  return serveStatic(res, filePath);
}
