import type { NormalizedTrace } from "../types.js";
import type { PlaybookConfig } from "../types.js";

/** Apply score threshold filters and tag candidate reasons */
export function filterCandidates(
  traces: NormalizedTrace[],
  config: PlaybookConfig,
  filters?: {
    score_thresholds?: Record<string, number>;
    latency_ms_gt?: number;
    status?: string[];
    metadata?: Record<string, string>;
  },
): NormalizedTrace[] {
  return traces.filter((t) => {
    const reasons: string[] = [];

    // status filter
    if (filters?.status?.length && !filters.status.includes(t.status)) {
      return false;
    }

    // metadata filter
    if (filters?.metadata) {
      for (const [k, v] of Object.entries(filters.metadata)) {
        if (t.metadata[k] !== v) return false;
      }
    }

    // score thresholds
    const thresholds = filters?.score_thresholds ?? {};
    for (const [key, threshold] of Object.entries(thresholds)) {
      const match = key.match(/^(.+?)_(lt|gt|lte|gte)$/);
      if (!match) continue;
      const [, scoreName, op] = match;
      const val = t.scores[scoreName];
      if (val == null) continue;

      if (op === "lt" && val >= threshold) return false;
      if (op === "gt" && val <= threshold) return false;
      if (op === "lte" && val > threshold) return false;
      if (op === "gte" && val < threshold) return false;
      reasons.push(`low_${scoreName}`);
    }

    // default threshold check
    if (t.scores.correctness != null && t.scores.correctness < config.thresholds.correctness_low) {
      reasons.push("low_correctness");
    }
    if (t.scores.faithfulness != null && t.scores.faithfulness < config.thresholds.faithfulness_low) {
      reasons.push("low_faithfulness");
    }

    // latency
    const latencyThreshold = filters?.latency_ms_gt ?? config.thresholds.latency_high_ms;
    if (t.latency_ms > latencyThreshold) {
      reasons.push("high_latency");
    }

    // error status
    if (t.status === "error") {
      reasons.push("error_status");
    }

    // If no explicit threshold filters, include if any reason found or status is error/degraded
    if (!Object.keys(thresholds).length) {
      return reasons.length > 0 || t.status !== "ok";
    }

    return true;
  });
}
