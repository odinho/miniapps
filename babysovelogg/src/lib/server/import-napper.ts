import { setHourInTz } from "$lib/tz.js";

export interface NapperRow {
  start: string;
  end: string;
  category: string;
  babyMoodOnWakeUp: string;
  comment: string;
}

export interface ImportEvent {
  type: string;
  payload: Record<string, unknown>;
  clientId: string;
  clientEventId: string;
}

const EXPECTED_HEADER_PREFIX = "start,end,category,";

export function parseNapperCsv(csv: string): NapperRow[] {
  const lines = csv.trim().split("\n");
  if (lines.length === 0 || !lines[0].startsWith(EXPECTED_HEADER_PREFIX)) {
    throw new Error("Invalid Napper CSV: unexpected header");
  }

  const rows: NapperRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(",");
    const comment = decodeURIComponent(fields[14] || "").trim();

    rows.push({
      start: fields[0],
      end: fields[1],
      category: fields[2],
      babyMoodOnWakeUp: fields[4] || "",
      comment,
    });
  }

  return rows;
}

/** Convert a timestamp to UTC ISO string */
function toUtc(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

interface NightContext {
  bedTime: NapperRow;
  nightWakings: NapperRow[];
}

export function mapNapperToEvents(
  rows: NapperRow[],
  babyId: number,
  babyTz: string = "UTC",
): ImportEvent[] {
  // Include a batch hash so a second import doesn't collide with the first
  // on (client_id, client_event_id) and get silently deduped. The original
  // numbering was `evt_import_1, evt_import_2, ...` reset per call, which
  // meant every re-import shared the same keys as the first.
  const clientId = "napper-import";
  const batchHash = Math.random().toString(36).slice(2, 10);
  let eventCounter = 0;
  const makeEventId = () => `evt_import_${batchHash}_${++eventCounter}`;
  const makeSleepId = () => `slp_import_${batchHash}_${++eventCounter}`;

  const sorted = [...rows].toSorted(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const events: ImportEvent[] = [];
  let nightCtx: NightContext | null = null;

  function emit(type: string, payload: Record<string, unknown>): void {
    events.push({ type, payload, clientId, clientEventId: makeEventId() });
  }

  function closeNight(endTime: string | null, wakeUpMood: string): void {
    if (!nightCtx) return;
    const sleepDomainId = makeSleepId();
    const startUtc = toUtc(nightCtx.bedTime.start);

    if (endTime) {
      emit("sleep.manual", {
        babyId,
        startTime: startUtc,
        endTime: toUtc(endTime),
        type: "night",
        sleepDomainId,
      });
    } else {
      // No explicit wake-up. If the night is older than 24h, auto-close
      // with a 06:00 next-morning estimate to prevent ghost active sleeps.
      // 06:00 is baby-local clock time; thread baby.timezone through so
      // we pick the right UTC instant rather than the server's clock.
      const startMs = new Date(startUtc).getTime();
      const ageMs = Date.now() - startMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        const nextMorning = setHourInTz(new Date(startMs + 24 * 60 * 60 * 1000), 6, 0, babyTz);
        emit("sleep.manual", {
          babyId,
          startTime: startUtc,
          endTime: nextMorning.toISOString(),
          type: "night",
          sleepDomainId,
        });
      } else {
        emit("sleep.started", {
          babyId,
          startTime: startUtc,
          type: "night",
          sleepDomainId,
        });
      }
    }

    // Tag with BED_TIME comment and/or WOKE_UP mood
    const notes = nightCtx.bedTime.comment || null;
    const mood = wakeUpMood || null;
    if (notes || mood) {
      emit("sleep.tagged", { sleepDomainId, notes, mood });
    }

    // Emit pause/resume for each NIGHT_WAKING
    for (const nw of nightCtx.nightWakings) {
      emit("sleep.paused", {
        sleepDomainId,
        pauseTime: toUtc(nw.start),
      });
      emit("sleep.resumed", {
        sleepDomainId,
        resumeTime: toUtc(nw.end),
      });
    }

    nightCtx = null;
  }

  for (const row of sorted) {
    switch (row.category) {
      case "WOKE_UP": {
        const hadNight = !!nightCtx;
        closeNight(row.start, row.babyMoodOnWakeUp);
        // Standalone WOKE_UP (no preceding BED_TIME) needs explicit day.started
        if (!hadNight) {
          emit("day.started", { babyId, wakeTime: toUtc(row.start) });
        }
        break;
      }
      case "NAP": {
        const sleepDomainId = makeSleepId();
        emit("sleep.manual", {
          babyId,
          startTime: toUtc(row.start),
          endTime: toUtc(row.end),
          type: "nap",
          sleepDomainId,
        });
        if (row.babyMoodOnWakeUp || row.comment) {
          emit("sleep.tagged", {
            sleepDomainId,
            mood: row.babyMoodOnWakeUp || null,
            notes: row.comment || null,
          });
        }
        break;
      }
      case "BED_TIME": {
        // Close any previous unclosed night (shouldn't happen with clean data)
        if (nightCtx) closeNight(null, "");
        nightCtx = { bedTime: row, nightWakings: [] };
        break;
      }
      case "NIGHT_WAKING": {
        if (nightCtx) {
          nightCtx.nightWakings.push(row);
        }
        break;
      }
      // SOLIDS, MEDICINE, etc: skip
    }
  }

  // Close any trailing open night (BED_TIME at end of file)
  if (nightCtx) closeNight(null, "");

  return events;
}
