import type { NormalizedTrace } from "../types.js";

export interface CandidateTrace extends NormalizedTrace {
  candidate_reasons: string[];
}

/** Tag each trace with reasons it was selected as a failure candidate */
export function tagCandidateReasons(
  traces: NormalizedTrace[],
  thresholds: {
    correctness_low: number;
    faithfulness_low: number;
    context_relevance_low: number;
    latency_high_ms: number;
  },
): CandidateTrace[] {
  return traces.map((t) => {
    const reasons: string[] = [];

    if (t.status === "error") reasons.push("error_status");
    if (t.status === "degraded") reasons.push("degraded_status");

    if (t.scores.correctness != null && t.scores.correctness < thresholds.correctness_low) {
      reasons.push("low_correctness");
    }
    if (t.scores.faithfulness != null && t.scores.faithfulness < thresholds.faithfulness_low) {
      reasons.push("low_faithfulness");
    }
    if (t.scores.context_relevance != null && t.scores.context_relevance < thresholds.context_relevance_low) {
      reasons.push("low_context_relevance");
    }
    if (t.latency_ms > thresholds.latency_high_ms) {
      reasons.push("high_latency");
    }
    if (t.retrieval.count === 0) {
      reasons.push("retrieval_miss");
    }
    if (t.errors.length > 0) {
      for (const e of t.errors) reasons.push(`error_${e.kind}`);
    }

    return { ...t, candidate_reasons: reasons };
  });
}
