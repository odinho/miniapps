import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, resolveBaby, getFamilyTimezone } from "$lib/server/db.js";
import type { SleepLogRow, NightWakingRow } from "$lib/types.js";

function csvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const GET: RequestHandler = ({ url }) => {
  const baby = resolveBaby(url);
  if (!baby) return json({ error: "No baby configured" }, { status: 404 });
  // Timezone is family-level; overlay it so exports carry the real zone
  // rather than a possibly-stale per-baby column.
  baby.timezone = getFamilyTimezone();

  const format = url.searchParams.get("format") || "json";
  const sleeps = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0 ORDER BY start_time DESC")
    .all(baby.id) as SleepLogRow[];

  const diapers = db
    .prepare("SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC")
    .all(baby.id);

  const nightWakings = db
    .prepare("SELECT * FROM night_waking WHERE baby_id = ? AND deleted = 0 ORDER BY start_time DESC")
    .all(baby.id) as NightWakingRow[];

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
          csvField(s.notes || ""),
        ].join(","),
      );
    }
    for (const w of nightWakings) {
      lines.push(
        [
          "night_waking",
          w.start_time,
          w.end_time || "",
          "",
          w.mood || "",
          "",
          csvField(w.notes || ""),
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
        ["diaper", d.time, "", d.type, "", "", csvField(d.note || "")].join(","),
      );
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=babysovelogg-export.csv",
      },
    });
  }

  return json({ baby, sleeps, diapers, nightWakings });
};
