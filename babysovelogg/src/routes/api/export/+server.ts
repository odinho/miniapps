import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import type { Baby, SleepLogRow, SleepPauseRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json({ error: "No baby configured" }, { status: 404 });

  const format = url.searchParams.get("format") || "json";
  const sleeps = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0 ORDER BY start_time DESC")
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
    .prepare("SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC")
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
    for (const d of diapers as {
      time: string;
      type: string;
      amount: string | null;
      note: string | null;
    }[]) {
      lines.push(
        ["diaper", d.time, "", d.type, "", "", (d.note || "").replace(/,/g, ";")].join(","),
      );
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=babysovelogg-export.csv",
      },
    });
  }

  return json({ baby, sleeps, diapers, dayStarts });
};
