import * as v from "valibot";

// Level 1: event envelope schema (applied to each item in the batch)
const eventEnvelopeSchema = v.object({
  type: v.string(),
  payload: v.record(v.string(), v.unknown()),
  clientId: v.string(),
  clientEventId: v.string(),
});

// Level 1: batch body schema
const batchBodySchema = v.object({
  events: v.array(eventEnvelopeSchema),
});

// Level 2: payload schemas keyed by event type
// Accept ISO 8601 datetime strings including milliseconds and timezone (e.g. "2025-01-01T12:00:00.000Z")
const isoDateTime = v.pipe(
  v.string(),
  v.check(
    (s) => !isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s),
    "Invalid ISO datetime string",
  ),
);
const uuid = v.pipe(v.string(), v.uuid());

// v.nullish allows both undefined and null — the client sends null for unset optional fields
const optStr = v.nullish(v.string());
const optNum = v.nullish(v.number());

const payloadSchemas: Record<string, v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>> = {
  "baby.created": v.object({
    name: v.string(),
    birthdate: v.string(),
  }),
  "baby.updated": v.object({
    name: optStr,
    birthdate: optStr,
    customNapCount: optNum,
    pottyMode: v.nullish(v.boolean()),
  }),
  "sleep.started": v.object({
    babyId: v.number(),
    startTime: isoDateTime,
    type: v.nullish(v.picklist(["nap", "night"])),
    sleepDomainId: uuid,
  }),
  "sleep.ended": v.object({
    sleepDomainId: uuid,
    endTime: isoDateTime,
  }),
  "sleep.updated": v.object({
    sleepDomainId: uuid,
    startTime: v.nullish(isoDateTime),
    endTime: v.nullish(isoDateTime),
    type: v.nullish(v.picklist(["nap", "night"])),
    notes: optStr,
    mood: optStr,
    method: optStr,
    fallAsleepTime: optStr,
    wokeBy: optStr,
    wakeNotes: optStr,
  }),
  "sleep.manual": v.object({
    babyId: v.number(),
    startTime: isoDateTime,
    endTime: isoDateTime,
    type: v.nullish(v.picklist(["nap", "night"])),
    sleepDomainId: uuid,
  }),
  "sleep.deleted": v.object({
    sleepDomainId: uuid,
  }),
  "sleep.tagged": v.object({
    sleepDomainId: uuid,
    mood: optStr,
    method: optStr,
    fallAsleepTime: optStr,
    notes: optStr,
  }),
  "sleep.paused": v.object({
    sleepDomainId: uuid,
    pauseTime: isoDateTime,
  }),
  "sleep.resumed": v.object({
    sleepDomainId: uuid,
    resumeTime: isoDateTime,
  }),
  "diaper.logged": v.object({
    babyId: v.number(),
    time: isoDateTime,
    type: v.string(),
    diaperDomainId: uuid,
    amount: optStr,
    note: optStr,
  }),
  "diaper.updated": v.object({
    diaperDomainId: uuid,
    type: optStr,
    amount: optStr,
    note: optStr,
  }),
  "diaper.deleted": v.object({
    diaperDomainId: uuid,
  }),
  "day.started": v.object({
    babyId: v.number(),
    wakeTime: isoDateTime,
  }),
};

function summarizeIssues(issues: v.BaseIssue<unknown>[]): string {
  return issues.map((i) => `${i.path?.map((p) => p.key).join(".") || "root"}: ${i.message}`).join("; ");
}

/** Validate the entire POST body (envelope + payloads). Returns all errors or ok. */
export function validateBatch(
  body: unknown,
):
  | {
      ok: true;
      events: { type: string; payload: Record<string, unknown>; clientId: string; clientEventId: string }[];
    }
  | { ok: false; errors: string[] } {
  // Level 1: validate body shape
  const bodyResult = v.safeParse(batchBodySchema, body);
  if (!bodyResult.success) return { ok: false, errors: [summarizeIssues(bodyResult.issues)] };

  // Level 2: validate each event's payload
  const errors: string[] = [];
  for (let i = 0; i < bodyResult.output.events.length; i++) {
    const evt = bodyResult.output.events[i];
    const schema = payloadSchemas[evt.type];
    if (!schema) {
      errors.push(`events[${i}]: unknown event type "${evt.type}"`);
      continue;
    }
    const payloadResult = v.safeParse(schema, evt.payload);
    if (!payloadResult.success) {
      errors.push(`events[${i}] (${evt.type}): ${summarizeIssues(payloadResult.issues)}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, events: bodyResult.output.events };
}

/** Validate one event payload by type. Used by rebuild and integrity tooling. */
export function validateEventPayload(
  type: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema = payloadSchemas[type];
  if (!schema) return { ok: false, error: `unknown event type "${type}"` };
  const result = v.safeParse(schema, payload);
  if (!result.success) return { ok: false, error: summarizeIssues(result.issues) };
  return { ok: true };
}
