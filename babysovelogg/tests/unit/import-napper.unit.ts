import { describe, expect, it } from "vitest";
import { parseNapperCsv, mapNapperToEvents } from "../../server/import-napper.js";

// --- DSL helpers for building CSV strings ---

const HEADER =
  "start,end,category,overallHappiness,babyMoodOnWakeUp,diaperWeight,diaperContent,breastLeftMinutes,breastRightMinutes,amountPumpedLeft,amountPumpedRight,feedingAmount,temperature,bottleFeedingType,comment,createdAt,pauses";

/** Build a full CSV from row-builder outputs */
function csv(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

/** NAP row. Times are short-form — expanded to full ISO. */
function nap(start: string, end: string, opts: { mood?: number; comment?: string } = {}): string {
  return row(start, end, "NAP", opts);
}

function wakeUp(time: string, opts: { mood?: number } = {}): string {
  return row(time, time, "WOKE_UP", opts);
}

function bedTime(time: string, opts: { comment?: string } = {}): string {
  return row(time, time, "BED_TIME", opts);
}

function nightWaking(start: string, end: string): string {
  return row(start, end, "NIGHT_WAKING");
}

function solids(time: string): string {
  return row(time, time, "SOLIDS");
}

function medicine(time: string): string {
  return row(time, time, "MEDICINE");
}

/** Generic row builder. Time strings like "2026-01-07T09:00" get "+01:00" appended. */
function row(
  start: string,
  end: string,
  category: string,
  opts: { mood?: number; comment?: string } = {},
): string {
  const s = isoTz(start);
  const e = isoTz(end);
  const mood = opts.mood ?? "";
  const comment = opts.comment ?? "";
  // Fields: start,end,category,overallHappiness,babyMoodOnWakeUp,diaperWeight,diaperContent,
  // breastLeftMinutes,breastRightMinutes,amountPumpedLeft,amountPumpedRight,feedingAmount,
  // temperature,bottleFeedingType,comment,createdAt,pauses
  return `${s},${e},${category},,${mood},,,,,,,,,,${comment},${s},`;
}

/** Ensure a time string has full ISO format with timezone info */
function isoTz(t: string): string {
  if (t.includes("+") || t.includes("Z")) return t;
  // Pad to HH:MM:SS if only HH:MM
  const parts = t.split("T");
  const timePart = parts[1];
  const padded = timePart.length === 5 ? timePart + ":00" : timePart;
  return parts[0] + "T" + padded + ".000+01:00";
}

// --- Tests ---

describe("parseNapperCsv", () => {
  it("parses a NAP row with all fields", () => {
    const result = parseNapperCsv(csv(nap("2026-01-06T09:00", "2026-01-06T09:45", { mood: 5 })));
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("NAP");
    expect(result[0].start).toContain("2026-01-06T09:00");
    expect(result[0].end).toContain("2026-01-06T09:45");
    expect(result[0].babyMoodOnWakeUp).toBe("5");
  });

  it("URL-decodes comments", () => {
    const result = parseNapperCsv(
      csv(nap("2026-01-06T09:00", "2026-01-06T09:45", { comment: "Hello%20World%0ALine2" })),
    );
    expect(result[0].comment).toBe("Hello World\nLine2");
  });

  it("decodes Norwegian characters in comments", () => {
    const result = parseNapperCsv(
      csv(nap("2026-01-06T09:00", "2026-01-06T09:45", { comment: "P%C3%A5%20veg" })),
    );
    expect(result[0].comment).toBe("På veg");
  });

  it("handles empty optional fields", () => {
    const result = parseNapperCsv(csv(nap("2026-01-06T09:00", "2026-01-06T09:45")));
    expect(result[0].babyMoodOnWakeUp).toBe("");
    expect(result[0].comment).toBe("");
  });

  it("handles [object Object] in pauses column", () => {
    // Real data has this bug
    const line = `2026-01-09T04:48:17.000+01:00,2026-01-09T05:39:50.744+01:00,NIGHT_WAKING,,,,,,,,,,,,comment,2026-01-09T04:39:50.498Z,[object Object]`;
    const result = parseNapperCsv(HEADER + "\n" + line);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("NIGHT_WAKING");
  });

  it("rejects CSV with wrong header", () => {
    expect(() => parseNapperCsv("wrong,header\n1,2")).toThrow();
  });

  it("parses multiple rows", () => {
    const result = parseNapperCsv(
      csv(
        wakeUp("2026-01-06T06:00"),
        nap("2026-01-06T09:00", "2026-01-06T09:45"),
        bedTime("2026-01-06T18:00"),
      ),
    );
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.category)).toEqual(["WOKE_UP", "NAP", "BED_TIME"]);
  });

  it("trims trailing whitespace from comments", () => {
    const result = parseNapperCsv(
      csv(nap("2026-01-06T09:00", "2026-01-06T09:45", { comment: "Hello%20" })),
    );
    expect(result[0].comment).toBe("Hello");
  });
});

describe("mapNapperToEvents", () => {
  const BABY = 1;

  /** Shorthand to parse+map in one step */
  function map(...lines: string[]) {
    return mapNapperToEvents(parseNapperCsv(csv(...lines)), BABY);
  }

  it("maps a single nap to sleep.manual", () => {
    const events = map(nap("2026-01-06T09:00", "2026-01-06T09:45"));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("sleep.manual");
    expect(events[0].payload).toMatchObject({
      babyId: 1,
      type: "nap",
    });
    expect(events[0].payload.startTime).toContain("2026-01-06");
    expect(events[0].payload.endTime).toContain("2026-01-06");
    expect(events[0].payload.sleepDomainId).toMatch(/^slp_/);
  });

  it("maps nap with mood to sleep.manual + sleep.tagged", () => {
    const events = map(nap("2026-01-06T09:00", "2026-01-06T09:45", { mood: 3 }));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("sleep.manual");
    expect(events[1].type).toBe("sleep.tagged");
    expect(events[1].payload.mood).toBe("3");
    // Both reference the same sleep
    expect(events[1].payload.sleepDomainId).toBe(events[0].payload.sleepDomainId);
  });

  it("maps nap with comment to sleep.manual + sleep.tagged", () => {
    const events = map(nap("2026-01-06T09:00", "2026-01-06T09:45", { comment: "Sjuk" }));
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("sleep.tagged");
    expect(events[1].payload.notes).toBe("Sjuk");
  });

  it("maps WOKE_UP to day.started", () => {
    const events = map(wakeUp("2026-01-06T06:00"));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("day.started");
    expect(events[0].payload.babyId).toBe(1);
    expect(events[0].payload.wakeTime).toContain("2026-01-06");
  });

  it("maps BED_TIME + WOKE_UP to night sleep + day.started", () => {
    const events = map(bedTime("2026-01-07T18:05"), wakeUp("2026-01-08T06:30"));
    expect(events.map((e) => e.type)).toEqual(["sleep.manual", "day.started"]);
    const sleep = events[0];
    expect(sleep.payload.type).toBe("night");
    // +01:00 → UTC: 18:05→17:05, 06:30→05:30
    expect(sleep.payload.startTime).toBe("2026-01-07T17:05:00.000Z");
    expect(sleep.payload.endTime).toBe("2026-01-08T05:30:00.000Z");
  });

  it("maps BED_TIME comment + WOKE_UP mood onto the night sleep", () => {
    const events = map(
      bedTime("2026-01-07T18:05", { comment: "Fussy" }),
      wakeUp("2026-01-08T06:30", { mood: 3 }),
    );
    expect(events.map((e) => e.type)).toEqual(["sleep.manual", "sleep.tagged", "day.started"]);
    expect(events[1].payload).toMatchObject({
      notes: "Fussy",
      mood: "3",
    });
    expect(events[1].payload.sleepDomainId).toBe(events[0].payload.sleepDomainId);
  });

  it("maps NIGHT_WAKINGs as pause/resume pairs on night sleep", () => {
    const events = map(
      bedTime("2026-01-07T18:05"),
      nightWaking("2026-01-07T20:34", "2026-01-07T20:50"),
      wakeUp("2026-01-08T06:30"),
    );
    expect(events.map((e) => e.type)).toEqual([
      "sleep.manual",
      "sleep.paused",
      "sleep.resumed",
      "day.started",
    ]);
    const sleepId = events[0].payload.sleepDomainId;
    expect(events[1].payload).toMatchObject({
      sleepDomainId: sleepId,
      pauseTime: "2026-01-07T19:34:00.000Z",
    });
    expect(events[2].payload).toMatchObject({
      sleepDomainId: sleepId,
      resumeTime: "2026-01-07T19:50:00.000Z",
    });
  });

  it("handles multiple NIGHT_WAKINGs in one night", () => {
    const events = map(
      bedTime("2026-01-09T19:05"),
      nightWaking("2026-01-09T20:46", "2026-01-09T21:02"),
      nightWaking("2026-01-09T21:21", "2026-01-09T22:03"),
      nightWaking("2026-01-10T00:44", "2026-01-10T00:59"),
      wakeUp("2026-01-10T06:45"),
    );
    const typeList = events.map((e) => e.type);
    expect(typeList).toEqual([
      "sleep.manual",
      "sleep.paused",
      "sleep.resumed",
      "sleep.paused",
      "sleep.resumed",
      "sleep.paused",
      "sleep.resumed",
      "day.started",
    ]);
    // All pause/resume reference same sleep
    const sleepId = events[0].payload.sleepDomainId;
    for (const e of events.slice(1, -1)) {
      expect(e.payload.sleepDomainId).toBe(sleepId);
    }
  });

  it("skips SOLIDS and MEDICINE", () => {
    const events = map(solids("2026-01-07T17:35"), medicine("2026-01-07T12:00"));
    expect(events).toHaveLength(0);
  });

  it("maps a full day sequence", () => {
    const events = map(
      wakeUp("2026-01-06T06:00"),
      nap("2026-01-06T09:00", "2026-01-06T09:45"),
      nap("2026-01-06T13:15", "2026-01-06T14:35"),
      bedTime("2026-01-06T18:26"),
    );
    expect(events.map((e) => e.type)).toEqual([
      "day.started",
      "sleep.manual", // nap 1
      "sleep.manual", // nap 2
      // bedTime starts a night — no WOKE_UP yet so open-ended
      "sleep.started",
    ]);
  });

  it("creates open-ended night for BED_TIME at end of file", () => {
    const events = map(bedTime("2026-01-06T18:26"));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("sleep.started");
    expect(events[0].payload).toMatchObject({
      babyId: 1,
      type: "night",
    });
    expect(events[0].payload.startTime).toBe("2026-01-06T17:26:00.000Z");
  });

  it("converts timestamps to UTC ISO strings", () => {
    const events = map(nap("2026-01-06T09:00:00.000+01:00", "2026-01-06T09:45:00.000+01:00"));
    // Should be stored as UTC
    expect(events[0].payload.startTime).toBe("2026-01-06T08:00:00.000Z");
    expect(events[0].payload.endTime).toBe("2026-01-06T08:45:00.000Z");
  });

  it("generates unique clientEventIds for each event", () => {
    const events = map(wakeUp("2026-01-06T06:00"), nap("2026-01-06T09:00", "2026-01-06T09:45"));
    const ids = events.map((e) => e.clientEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses a consistent clientId for all import events", () => {
    const events = map(wakeUp("2026-01-06T06:00"), nap("2026-01-06T09:00", "2026-01-06T09:45"));
    const clientIds = new Set(events.map((e) => e.clientId));
    expect(clientIds.size).toBe(1);
  });
});
