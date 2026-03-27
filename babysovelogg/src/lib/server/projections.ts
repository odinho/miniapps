import { db } from "./db.js";
import type { AppEvent } from "./events.js";
import type { EventRow } from "$lib/types.js";
import { validateEventPayload } from "./schemas.js";
import { isoToDateInTz } from "$lib/tz.js";

export function applyEvent(event: AppEvent): void {
  const { type, payload } = event;
  const eventId = event.id;

  switch (type) {
    case "baby.created":
      db.prepare(
        `INSERT INTO baby (name, birthdate, timezone, created_at, created_by_event_id) VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run(payload.name, payload.birthdate, payload.timezone ?? null, eventId);
      break;

    case "baby.updated": {
      const baby = db.prepare("SELECT id FROM baby ORDER BY id DESC LIMIT 1").get() as
        | { id: number }
        | undefined;
      if (!baby) throw new Error("baby.updated: no baby found");
      const sets: string[] = ["updated_by_event_id = ?"];
      const vals: unknown[] = [eventId];
      if (payload.name !== undefined) {
        sets.push("name = ?");
        vals.push(payload.name);
      }
      if (payload.birthdate !== undefined) {
        sets.push("birthdate = ?");
        vals.push(payload.birthdate);
      }
      if (payload.customNapCount !== undefined) {
        sets.push("custom_nap_count = ?");
        vals.push(payload.customNapCount);
      }
      if (payload.pottyMode !== undefined) {
        sets.push("potty_mode = ?");
        vals.push(payload.pottyMode ? 1 : 0);
      }
      if (payload.timezone !== undefined) {
        sets.push("timezone = ?");
        vals.push(payload.timezone);
      }
      vals.push(baby.id);
      db.prepare(`UPDATE baby SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      break;
    }

    case "sleep.started":
      db.prepare(
        "INSERT INTO sleep_log (baby_id, start_time, type, domain_id, created_by_event_id) VALUES (?, ?, ?, ?, ?)",
      ).run(
        payload.babyId,
        payload.startTime,
        payload.type || "nap",
        payload.sleepDomainId,
        eventId,
      );
      break;

    case "sleep.ended": {
      const result = db
        .prepare("UPDATE sleep_log SET end_time = ?, updated_by_event_id = ? WHERE domain_id = ?")
        .run(payload.endTime, eventId, payload.sleepDomainId);
      if (result.changes === 0) {
        throw new Error(`sleep.ended: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      break;
    }

    case "sleep.updated": {
      const sets: string[] = ["updated_by_event_id = ?"];
      const vals: unknown[] = [eventId];
      if (payload.startTime !== undefined) {
        sets.push("start_time = ?");
        vals.push(payload.startTime);
      }
      if (payload.endTime !== undefined) {
        sets.push("end_time = ?");
        vals.push(payload.endTime);
      }
      if (payload.type !== undefined) {
        sets.push("type = ?");
        vals.push(payload.type);
      }
      if (payload.notes !== undefined) {
        sets.push("notes = ?");
        vals.push(payload.notes);
      }
      if (payload.mood !== undefined) {
        sets.push("mood = ?");
        vals.push(payload.mood);
      }
      if (payload.method !== undefined) {
        sets.push("method = ?");
        vals.push(payload.method);
      }
      if (payload.fallAsleepTime !== undefined) {
        sets.push("fall_asleep_time = ?");
        vals.push(payload.fallAsleepTime);
      }
      if (payload.wokeBy !== undefined) {
        sets.push("woke_by = ?");
        vals.push(payload.wokeBy);
      }
      if (payload.wakeNotes !== undefined) {
        sets.push("wake_notes = ?");
        vals.push(payload.wakeNotes);
      }
      vals.push(payload.sleepDomainId);
      const result = db
        .prepare(`UPDATE sleep_log SET ${sets.join(", ")} WHERE domain_id = ?`)
        .run(...vals);
      if (result.changes === 0) {
        throw new Error(`sleep.updated: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      break;
    }

    case "sleep.manual":
      db.prepare(
        "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id, created_by_event_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        payload.babyId,
        payload.startTime,
        payload.endTime,
        payload.type || "nap",
        payload.sleepDomainId,
        eventId,
      );
      break;

    case "sleep.deleted": {
      const result = db
        .prepare("UPDATE sleep_log SET deleted = 1, updated_by_event_id = ? WHERE domain_id = ?")
        .run(eventId, payload.sleepDomainId);
      if (result.changes === 0) {
        throw new Error(`sleep.deleted: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      break;
    }

    case "sleep.restarted": {
      const result = db
        .prepare("UPDATE sleep_log SET end_time = NULL, updated_by_event_id = ? WHERE domain_id = ?")
        .run(eventId, payload.sleepDomainId);
      if (result.changes === 0) {
        throw new Error(`sleep.restarted: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      break;
    }

    case "sleep.tagged": {
      const sets: string[] = ["updated_by_event_id = ?"];
      const vals: unknown[] = [eventId];
      if (payload.mood !== undefined) {
        sets.push("mood = ?");
        vals.push(payload.mood);
      }
      if (payload.method !== undefined) {
        sets.push("method = ?");
        vals.push(payload.method);
      }
      if (payload.fallAsleepTime !== undefined) {
        sets.push("fall_asleep_time = ?");
        vals.push(payload.fallAsleepTime);
      }
      if (payload.notes !== undefined) {
        sets.push("notes = ?");
        vals.push(payload.notes);
      }
      vals.push(payload.sleepDomainId);
      const result = db
        .prepare(`UPDATE sleep_log SET ${sets.join(", ")} WHERE domain_id = ?`)
        .run(...vals);
      if (result.changes === 0) {
        throw new Error(`sleep.tagged: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      break;
    }

    case "sleep.paused": {
      const sleep = db
        .prepare("SELECT id FROM sleep_log WHERE domain_id = ?")
        .get(payload.sleepDomainId) as { id: number } | undefined;
      if (!sleep) {
        throw new Error(`sleep.paused: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      db.prepare(
        "INSERT INTO sleep_pauses (sleep_id, pause_time, created_by_event_id) VALUES (?, ?, ?)",
      ).run(sleep.id, payload.pauseTime, eventId);
      break;
    }

    case "sleep.resumed": {
      const sleep = db
        .prepare("SELECT id FROM sleep_log WHERE domain_id = ?")
        .get(payload.sleepDomainId) as { id: number } | undefined;
      if (!sleep) {
        throw new Error(`sleep.resumed: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      const result = db
        .prepare(
          "UPDATE sleep_pauses SET resume_time = ? WHERE sleep_id = ? AND resume_time IS NULL",
        )
        .run(payload.resumeTime, sleep.id);
      if (result.changes === 0) {
        throw new Error(
          `sleep.resumed: no open pause found for domain_id ${payload.sleepDomainId}`,
        );
      }
      break;
    }

    case "diaper.logged":
      db.prepare(
        "INSERT INTO diaper_log (baby_id, time, type, amount, note, domain_id, created_by_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        payload.babyId,
        payload.time,
        payload.type,
        payload.amount ?? null,
        payload.note ?? null,
        payload.diaperDomainId,
        eventId,
      );
      break;

    case "diaper.updated": {
      const sets: string[] = ["updated_by_event_id = ?"];
      const vals: unknown[] = [eventId];
      if (payload.type !== undefined) {
        sets.push("type = ?");
        vals.push(payload.type);
      }
      if (payload.amount !== undefined) {
        sets.push("amount = ?");
        vals.push(payload.amount);
      }
      if (payload.note !== undefined) {
        sets.push("note = ?");
        vals.push(payload.note);
      }
      vals.push(payload.diaperDomainId);
      const result = db
        .prepare(`UPDATE diaper_log SET ${sets.join(", ")} WHERE domain_id = ?`)
        .run(...vals);
      if (result.changes === 0) {
        throw new Error(`diaper.updated: no diaper found with domain_id ${payload.diaperDomainId}`);
      }
      break;
    }

    case "diaper.deleted": {
      const result = db
        .prepare("UPDATE diaper_log SET deleted = 1, updated_by_event_id = ? WHERE domain_id = ?")
        .run(eventId, payload.diaperDomainId);
      if (result.changes === 0) {
        throw new Error(`diaper.deleted: no diaper found with domain_id ${payload.diaperDomainId}`);
      }
      break;
    }

    case "day.started": {
      // Derive date in the baby's timezone (falls back to UTC if no timezone set)
      const baby = db.prepare("SELECT timezone FROM baby ORDER BY id DESC LIMIT 1").get() as { timezone: string | null } | undefined;
      const tz = baby?.timezone || "UTC";
      const dateStr = isoToDateInTz(payload.wakeTime as string, tz);
      db.prepare(
        "INSERT OR REPLACE INTO day_start (baby_id, date, wake_time, created_by_event_id) VALUES (?, ?, ?, ?)",
      ).run(payload.babyId, dateStr, payload.wakeTime, eventId);
      break;
    }
  }
}

export interface RebuildReport {
  success: boolean;
  eventsReplayed: number;
  invalidEvents: { id: number; type: string; error: string }[];
  before: { sleeps: number; diapers: number; pauses: number; dayStarts: number };
  after: { sleeps: number; diapers: number; pauses: number; dayStarts: number };
  durationMs: number;
}

function countProjections() {
  const sleeps = (db.prepare("SELECT COUNT(*) as c FROM sleep_log").get() as { c: number }).c;
  const diapers = (db.prepare("SELECT COUNT(*) as c FROM diaper_log").get() as { c: number }).c;
  const pauses = (db.prepare("SELECT COUNT(*) as c FROM sleep_pauses").get() as { c: number }).c;
  const dayStarts = (db.prepare("SELECT COUNT(*) as c FROM day_start").get() as { c: number }).c;
  return { sleeps, diapers, pauses, dayStarts };
}

export function rebuildAll(): RebuildReport {
  const start = Date.now();
  const events = db.prepare("SELECT * FROM events ORDER BY id ASC").all() as EventRow[];

  // Preflight: validate all events
  const invalidEvents: { id: number; type: string; error: string }[] = [];
  for (const row of events) {
    const payload = JSON.parse(row.payload);
    const result = validateEventPayload(row.type, payload);
    if (!result.ok) {
      invalidEvents.push({ id: row.id, type: row.type, error: result.error });
    }
  }
  if (invalidEvents.length > 0) {
    return {
      success: false,
      eventsReplayed: 0,
      invalidEvents,
      before: countProjections(),
      after: countProjections(),
      durationMs: Date.now() - start,
    };
  }

  const before = countProjections();

  // Rebuild in transaction
  const doRebuild = db.transaction(() => {
    db.prepare("DELETE FROM sleep_pauses").run();
    db.prepare("DELETE FROM diaper_log").run();
    db.prepare("DELETE FROM sleep_log").run();
    db.prepare("DELETE FROM day_start").run();
    db.prepare("DELETE FROM baby").run();
    // Reset autoincrement so replayed baby IDs match original payload references
    db.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('baby', 'sleep_log', 'diaper_log', 'sleep_pauses', 'day_start')",
    ).run();
    for (const row of events) {
      applyEvent({ ...row, payload: JSON.parse(row.payload) } as unknown as AppEvent);
    }
  });
  doRebuild();

  const after = countProjections();
  return {
    success: true,
    eventsReplayed: events.length,
    invalidEvents: [],
    before,
    after,
    durationMs: Date.now() - start,
  };
}
