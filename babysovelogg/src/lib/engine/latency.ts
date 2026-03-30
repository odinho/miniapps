/**
 * Sleep onset latency guidance.
 *
 * Uses the existing fall_asleep_time field to provide feedback on whether
 * the baby was put down at the right time.
 *
 * Reference: Galland 2012 infant mean latency = 19 min (range 0-43 min).
 */

export interface LatencyGuidance {
  latencyMinutes: number;
  category: "overtired" | "good" | "undertired";
  message: string;
}

/**
 * Assess sleep onset latency.
 * @param startTime - When the baby was put down (ISO string)
 * @param fallAsleepTime - When the baby fell asleep (ISO string)
 */
export function assessLatency(startTime: string, fallAsleepTime: string): LatencyGuidance {
  const latencyMinutes = Math.round(
    (new Date(fallAsleepTime).getTime() - new Date(startTime).getTime()) / 60_000,
  );

  if (latencyMinutes < 5) {
    return {
      latencyMinutes,
      category: "overtired",
      message: "Fell asleep very quickly — possibly overtired. Try putting down a bit earlier.",
    };
  }

  if (latencyMinutes <= 20) {
    return {
      latencyMinutes,
      category: "good",
      message: "Good timing — fell asleep within a normal window.",
    };
  }

  return {
    latencyMinutes,
    category: "undertired",
    message: "Took a while to fall asleep — possibly undertired. Try a slightly longer wake window.",
  };
}

/**
 * Summarize latency trends from recent sleeps.
 * Returns the dominant pattern (overtired/good/undertired) and average latency.
 */
export function summarizeLatencyTrend(
  sleeps: { start_time: string; fall_asleep_time: string | null }[],
): { avgMinutes: number; dominantCategory: LatencyGuidance["category"]; count: number } | null {
  const withLatency = sleeps.filter((s) => s.fall_asleep_time);
  if (withLatency.length === 0) return null;

  const assessments = withLatency.map((s) => assessLatency(s.start_time, s.fall_asleep_time!));
  const avgMinutes = Math.round(
    assessments.reduce((sum, a) => sum + a.latencyMinutes, 0) / assessments.length,
  );

  const counts = { overtired: 0, good: 0, undertired: 0 };
  for (const a of assessments) counts[a.category]++;

  const dominantCategory = counts.overtired >= counts.good && counts.overtired >= counts.undertired
    ? "overtired"
    : counts.undertired >= counts.good
      ? "undertired"
      : "good";

  return { avgMinutes, dominantCategory, count: withLatency.length };
}
