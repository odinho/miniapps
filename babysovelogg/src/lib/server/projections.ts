import { db } from "./db.js";
import type { AppEvent } from "./events.js";
import { rowToAppEvent } from "./events.js";
import type { EventRow } from "$lib/types.js";
import { validateEventPayload } from "./schemas.js";
import { isoToDateInTz } from "$lib/tz.js";
import { getFamilyTimezone } from "./db.js";
import { shouldReclassifyAsNight } from "$lib/engine/classification.js";

export function applyEvent(event: AppEvent): void {
  const { type, payload } = event;
  const eventId = event.id;

  switch (type) {
    case "baby.created": {
      // Hard cap: a family is at most 2 children (the whole design assumes it —
      // two lanes, "begge", combined status, no dropdown). The add-child UI
      // already gates this, but guard the projection so a raw or duplicated
      // event can't create a third that family roll-ups can't represent. No-op
      // beyond 2; replay-safe (a valid log never has a third, so it never fires).
      const count = (db.prepare("SELECT COUNT(*) AS n FROM baby").get() as { n: number }).n;
      if (count >= 2) {
        // Anomalous — the add-child UI prevents this, so a third only arrives
        // via a raw/duplicated event. Surface it (error level) but don't insert.
        console.error("[projections] baby.created ignored — family already has 2 children");
        break;
      }
      db.prepare(
        `INSERT INTO baby (name, birthdate, timezone, created_at, created_by_event_id) VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run(payload.name, payload.birthdate, payload.timezone ?? null, eventId);
      // The first baby's timezone establishes the household zone. Only fill an
      // empty family.timezone so a second baby's creation can't clobber it, and
      // so a later family.updated wins on replay.
      if (payload.timezone != null) {
        db.prepare("UPDATE family SET timezone = ? WHERE id = 1 AND timezone IS NULL").run(
          payload.timezone,
        );
      }
      break;
    }

    case "family.updated":
      // Only ever SET a zone, never clear it — there's no "unset household
      // timezone" use case, and a null would silently re-derive the server's.
      if (typeof payload.timezone === "string" && payload.timezone) {
        db.prepare(
          "UPDATE family SET timezone = ?, updated_by_event_id = ? WHERE id = 1",
        ).run(payload.timezone, eventId);
      }
      // Twin/sibling override. Unlike timezone this CAN be cleared (null = back
      // to auto-infer), so act whenever the key is present at all.
      if ("modeOverride" in payload) {
        const mode = payload.modeOverride === "twin" || payload.modeOverride === "sibling"
          ? payload.modeOverride
          : null;
        db.prepare(
          "UPDATE family SET mode_override = ?, updated_by_event_id = ? WHERE id = 1",
        ).run(mode, eventId);
      }
      if ("syncMode" in payload) {
        db.prepare(
          "UPDATE family SET sync_mode = ?, updated_by_event_id = ? WHERE id = 1",
        ).run(payload.syncMode ? 1 : 0, eventId);
      }
      break;

    case "baby.updated": {
      // Target the baby named in the event. Pre-multi-child events have no
      // babyId; fall back to the newest baby (the historical single-baby
      // selection) so replay stays correct. Without this, an edit to the
      // first twin would silently hit the second.
      const baby = (
        payload.babyId != null
          ? db.prepare("SELECT id FROM baby WHERE id = ?").get(payload.babyId)
          : db.prepare("SELECT id FROM baby ORDER BY id DESC LIMIT 1").get()
      ) as { id: number } | undefined;
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
      if (payload.trackDiaper !== undefined) {
        sets.push("track_diaper = ?");
        vals.push(payload.trackDiaper ? 1 : 0);
      }
      if (payload.timezone !== undefined) {
        sets.push("timezone = ?");
        vals.push(payload.timezone);
      }
      if (payload.targetBedtime !== undefined) {
        sets.push("target_bedtime = ?");
        vals.push(payload.targetBedtime);
      }
      vals.push(baby.id);
      db.prepare(`UPDATE baby SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      // Replay-compat: historical TZ changes were emitted as baby.updated
      // {timezone}. Timezone is now family-level, so mirror any such change
      // onto the family row (last-writer-wins by event order). New TZ edits
      // emit family.updated instead. Mirror only real zones, never a null.
      if (typeof payload.timezone === "string" && payload.timezone) {
        db.prepare("UPDATE family SET timezone = ?, updated_by_event_id = ? WHERE id = 1").run(
          payload.timezone,
          eventId,
        );
      }
      break;
    }

    case "sleep.started":
      db.prepare(
        "INSERT INTO sleep_log (baby_id, start_time, type, domain_id, synced, created_by_event_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        payload.babyId,
        payload.startTime,
        payload.type || "nap",
        payload.sleepDomainId,
        payload.synced ? 1 : 0,
        eventId,
      );
      break;

    case "sleep.ended": {
      // Sanity-check: reject end times that produce absurd durations (>24h for a single sleep)
      const preCheck = db.prepare("SELECT start_time FROM sleep_log WHERE domain_id = ?").get(payload.sleepDomainId) as { start_time: string } | undefined;
      if (preCheck) {
        const durationMs = new Date(payload.endTime as string).getTime() - new Date(preCheck.start_time).getTime();
        if (durationMs > 24 * 60 * 60 * 1000) {
          console.warn(`sleep.ended: duration ${Math.round(durationMs / 60000)}m exceeds 24h for ${payload.sleepDomainId}, clamping end time`);
          // Clamp to start + 14h (reasonable maximum for a baby sleep)
          payload.endTime = new Date(new Date(preCheck.start_time).getTime() + 14 * 60 * 60 * 1000).toISOString();
        }
      }
      const result = db
        .prepare("UPDATE sleep_log SET end_time = ?, updated_by_event_id = ? WHERE domain_id = ?")
        .run(payload.endTime, eventId, payload.sleepDomainId);
      if (result.changes === 0) {
        throw new Error(`sleep.ended: no sleep found with domain_id ${payload.sleepDomainId}`);
      }
      // Auto-reclassify long evening sleeps as night (B23)
      const sleep = db.prepare("SELECT start_time, type FROM sleep_log WHERE domain_id = ?").get(payload.sleepDomainId) as { start_time: string; type: string } | undefined;
      if (sleep && sleep.type === "nap" && shouldReclassifyAsNight(sleep.start_time, payload.endTime as string, getFamilyTimezone())) {
        db.prepare("UPDATE sleep_log SET type = 'night' WHERE domain_id = ?").run(payload.sleepDomainId);
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
      if (payload.onsetNote !== undefined) {
        sets.push("onset_note = ?");
        vals.push(payload.onsetNote);
      }
      if (payload.wokeBy !== undefined) {
        sets.push("woke_by = ?");
        vals.push(payload.wokeBy);
      }
      if (payload.wakeNotes !== undefined) {
        sets.push("wake_notes = ?");
        vals.push(payload.wakeNotes);
      }
      if (payload.wakeMood !== undefined) {
        sets.push("wake_mood = ?");
        vals.push(payload.wakeMood);
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

    case "sleep.manual": {
      let manualType = (payload.type as string) || "nap";
      // Auto-reclassify long evening sleeps as night (B23)
      if (manualType === "nap" && payload.endTime && shouldReclassifyAsNight(payload.startTime as string, payload.endTime as string, getFamilyTimezone())) {
        manualType = "night";
      }
      db.prepare(
        "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id, created_by_event_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        payload.babyId,
        payload.startTime,
        payload.endTime,
        manualType,
        payload.sleepDomainId,
        eventId,
      );
      break;
    }

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
      if (payload.onsetNote !== undefined) {
        sets.push("onset_note = ?");
        vals.push(payload.onsetNote);
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

    // Legacy pause projections — kept as no-ops so historical events
    // still parse and replay cleanly. The `sleep_pauses` table is gone
    // (dropped in db.ts after the one-time migration to night_waking).
    // New events never emit these types; they only appear in pre-redesign
    // history. See docs/pause-redesign-2026-05-22.md.
    case "sleep.paused":
    case "sleep.resumed":
    case "sleep.pause_deleted":
      break;

    case "night_waking.started": {
      db.prepare(
        "INSERT INTO night_waking (baby_id, domain_id, start_time, created_by_event_id) VALUES (?, ?, ?, ?)",
      ).run(payload.babyId, payload.wakingDomainId, payload.startTime, eventId);
      break;
    }

    case "night_waking.ended": {
      const result = db
        .prepare(
          "UPDATE night_waking SET end_time = ?, updated_by_event_id = ? WHERE domain_id = ? AND deleted = 0",
        )
        .run(payload.endTime, eventId, payload.wakingDomainId);
      if (result.changes === 0) {
        // Soft-fail. During `rebuildAll`, events targeting a migrated
        // `nwk_pse_*` row arrive before the end-of-replay migration has
        // populated it; throwing here would break the rebuild. The
        // migration re-seeds the row from sleep_pauses with the original
        // values; only an interactive edit on a migrated waking gets lost
        // on rebuild — acceptable edge case.
        console.warn(
          `night_waking.ended: no waking found with domain_id ${payload.wakingDomainId} (skipping)`,
        );
      }
      break;
    }

    case "night_waking.edited": {
      const sets: string[] = ["updated_by_event_id = ?"];
      const vals: unknown[] = [eventId];
      if (payload.startTime !== undefined && payload.startTime !== null) {
        sets.push("start_time = ?");
        vals.push(payload.startTime);
      }
      if (payload.endTime !== undefined) {
        sets.push("end_time = ?");
        vals.push(payload.endTime);
      }
      if (payload.notes !== undefined) {
        sets.push("notes = ?");
        vals.push(payload.notes);
      }
      if (payload.mood !== undefined) {
        sets.push("mood = ?");
        vals.push(payload.mood);
      }
      vals.push(payload.wakingDomainId);
      const result = db
        .prepare(`UPDATE night_waking SET ${sets.join(", ")} WHERE domain_id = ? AND deleted = 0`)
        .run(...vals);
      if (result.changes === 0) {
        // Soft-fail (see night_waking.ended).
        console.warn(
          `night_waking.edited: no waking found with domain_id ${payload.wakingDomainId} (skipping)`,
        );
      }
      break;
    }

    case "night_waking.deleted": {
      const result = db
        .prepare(
          "UPDATE night_waking SET deleted = 1, updated_by_event_id = ? WHERE domain_id = ?",
        )
        .run(eventId, payload.wakingDomainId);
      if (result.changes === 0) {
        // Soft-fail (see night_waking.ended).
        console.warn(
          `night_waking.deleted: no waking found with domain_id ${payload.wakingDomainId} (skipping)`,
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
      if (payload.time !== undefined && payload.time !== null) {
        sets.push("time = ?");
        vals.push(payload.time);
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
      // Used during onboarding / cold start when no night sleep exists yet.
      // ON CONFLICT DO UPDATE (not INSERT OR REPLACE) so an existing row's
      // off_day / off_day_reason survives. INSERT OR REPLACE deletes the
      // conflicting row and reinserts with defaults, silently wiping the
      // off-day marker if a parent marked the day off before opening the
      // morning prompt — or during event replay where ordering is
      // arbitrary.
      // Bucket the local date against the household zone (family-level), so
      // both babies' day boundaries agree.
      const tz = getFamilyTimezone();
      const dateStr = isoToDateInTz(payload.wakeTime as string, tz);
      db.prepare(
        `INSERT INTO day_start (baby_id, date, wake_time, created_by_event_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(baby_id, date) DO UPDATE SET
           wake_time = excluded.wake_time,
           created_by_event_id = excluded.created_by_event_id`,
      ).run(payload.babyId, dateStr, payload.wakeTime, eventId);
      break;
    }

    case "day.deleted": {
      db.prepare("DELETE FROM day_start WHERE baby_id = ? AND date = ?")
        .run(payload.babyId, payload.date);
      break;
    }

    case "day.marked_off": {
      // Insert-or-update: an off-day flag may be set before a day.started
      // exists (parent marks before logging anything). wake_time uses
      // the date's midnight as a placeholder — the engine's wake-derivation
      // prefers night end_time anyway, so this is only read when no other
      // wake signal exists, in which case the day was off and the value
      // doesn't influence trend math (off-days are skipped).
      const babyId = payload.babyId as number;
      const date = payload.date as string;
      const reason = (payload.reason as string | null | undefined) ?? null;
      // ON CONFLICT preserves the existing created_by_event_id — that field
      // records the row's *origin* event (typically day.started); a later
      // mark-off shouldn't rewrite history.
      db.prepare(
        `INSERT INTO day_start (baby_id, date, wake_time, off_day, off_day_reason, created_by_event_id)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(baby_id, date) DO UPDATE SET
           off_day = 1,
           off_day_reason = excluded.off_day_reason`,
      ).run(babyId, date, `${date}T00:00:00.000Z`, reason, eventId);
      break;
    }

    case "day.unmarked_off": {
      // If the row was created *only* by day.marked_off (no real day.started
      // happened), wake_time is the midnight placeholder we inserted at
      // line 358 and downstream wake-derivation should not see it. Delete
      // the row outright in that case; otherwise just clear the flag.
      const placeholder = `${payload.date as string}T00:00:00.000Z`;
      db.prepare(
        `DELETE FROM day_start
         WHERE baby_id = ? AND date = ? AND wake_time = ?`,
      ).run(payload.babyId, payload.date, placeholder);
      db.prepare(
        `UPDATE day_start SET off_day = 0, off_day_reason = NULL
         WHERE baby_id = ? AND date = ?`,
      ).run(payload.babyId, payload.date);
      break;
    }
  }
}

export interface RebuildReport {
  success: boolean;
  eventsReplayed: number;
  invalidEvents: { id: number; type: string; error: string }[];
  before: { sleeps: number; diapers: number; nightWakings: number };
  after: { sleeps: number; diapers: number; nightWakings: number };
  durationMs: number;
}

function countProjections() {
  const sleeps = (db.prepare("SELECT COUNT(*) as c FROM sleep_log").get() as { c: number }).c;
  const diapers = (db.prepare("SELECT COUNT(*) as c FROM diaper_log").get() as { c: number }).c;
  const nightWakings = (db.prepare("SELECT COUNT(*) as c FROM night_waking").get() as { c: number }).c;
  return { sleeps, diapers, nightWakings };
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
    db.prepare("DELETE FROM night_waking").run();
    db.prepare("DELETE FROM diaper_log").run();
    db.prepare("DELETE FROM sleep_log").run();
    // Per-day projection rows + nap-budget state reference baby(id); clear
    // before the baby delete or PRAGMA foreign_keys=ON aborts the rebuild.
    // day.marked_off can produce day_start rows even before day.started, so
    // any prod DB that has used off-days will hit this on rebuild.
    db.prepare("DELETE FROM day_start").run();
    db.prepare("DELETE FROM nap_budget_state").run();
    // Notification tables reference baby(id) — clear before deleting baby rows.
    // Subscriptions will need to be re-added after rebuild.
    db.prepare("DELETE FROM notification_schedule").run();
    db.prepare("DELETE FROM notification_subscriptions").run();
    db.prepare("DELETE FROM notification_preferences").run();
    db.prepare("DELETE FROM baby").run();
    // Keep the singleton family row but clear its settings so replay
    // repopulates them from baby.created / baby.updated / family.updated. If
    // history never set a zone, the next read lazily re-derives the server's;
    // a never-set mode_override stays null (auto-infer).
    db.prepare(
      "UPDATE family SET timezone = NULL, mode_override = NULL, sync_mode = NULL, updated_by_event_id = NULL WHERE id = 1",
    ).run();
    // Reset autoincrement so replayed baby IDs match original payload references
    db.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('baby', 'sleep_log', 'diaper_log', 'night_waking')",
    ).run();
    for (const row of events) {
      applyEvent(rowToAppEvent(row));
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
