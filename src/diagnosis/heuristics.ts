import type { NormalizedTrace, RootCauseHypothesis, PlaybookConfig } from "../types.js";

/** Apply rule-based heuristics to a group of traces to generate root cause hypotheses */
export function applyHeuristics(
  traces: NormalizedTrace[],
  config: PlaybookConfig,
): RootCauseHypothesis[] {
  const hypotheses: RootCauseHypothesis[] = [];
  const n = traces.length;
  if (n === 0) return hypotheses;

  const avgScore = (key: string) => {
    const vals = traces.map((t) => t.scores[key]).filter((v) => v != null) as number[];
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const retrievalMissRate =
    traces.filter((t) => t.retrieval.count === 0).length / n;

  const avgCorrectness = avgScore("correctness");
  const avgFaithfulness = avgScore("faithfulness");
  const avgContextRelevance = avgScore("context_relevance");
  const avgConciseness = avgScore("conciseness");
  const avgLatency = traces.reduce((a, t) => a + t.latency_ms, 0) / n;

  // Rule 1: retrieval quality issue
  if (
    avgContextRelevance != null &&
    avgContextRelevance < config.thresholds.context_relevance_low &&
    retrievalMissRate > 0.3
  ) {
    hypotheses.push({
      cause: "retrieval_quality_issue",
      confidence: 0.6 + retrievalMissRate * 0.3,
      evidence: [
        `avg context_relevance=${avgContextRelevance.toFixed(2)}`,
        `retrieval_miss_rate=${(retrievalMissRate * 100).toFixed(0)}%`,
      ],
    });
  }

  // Rule 2: answer synthesis / grounding problem
  if (
    avgContextRelevance != null &&
    avgContextRelevance >= config.thresholds.context_relevance_low &&
    avgFaithfulness != null &&
    avgFaithfulness < config.thresholds.faithfulness_low
  ) {
    hypotheses.push({
      cause: "answer_grounding_issue",
      confidence: 0.75,
      evidence: [
        `avg context_relevance=${avgContextRelevance.toFixed(2)} (adequate)`,
        `avg faithfulness=${avgFaithfulness.toFixed(2)} (low)`,
      ],
    });
  }

  // Rule 3: information loss / over-compression
  if (
    avgCorrectness != null &&
    avgCorrectness < config.thresholds.correctness_low &&
    avgConciseness != null &&
    avgConciseness > 0.85
  ) {
    hypotheses.push({
      cause: "over_compression",
      confidence: 0.65,
      evidence: [
        `avg correctness=${avgCorrectness.toFixed(2)} (low)`,
        `avg conciseness=${avgConciseness.toFixed(2)} (too high)`,
      ],
    });
  }

  // Rule 4: latency / infrastructure issue
  if (
    avgLatency > config.thresholds.latency_high_ms &&
    (avgCorrectness == null || avgCorrectness >= config.thresholds.correctness_low)
  ) {
    hypotheses.push({
      cause: "infrastructure_latency",
      confidence: 0.7,
      evidence: [
        `avg latency=${Math.round(avgLatency)}ms (high)`,
        "quality scores within acceptable range",
      ],
    });
  }

  // Rule 5: model overuse / prompt bloat
  const avgCost = traces.reduce((a, t) => a + t.cost_usd, 0) / n;
  const avgTokens = traces.reduce((a, t) => a + t.usage.total_tokens, 0) / n;
  if (avgCost > 0.05 && avgTokens > 4000) {
    hypotheses.push({
      cause: "prompt_bloat_or_model_overuse",
      confidence: 0.55,
      evidence: [
        `avg cost=$${avgCost.toFixed(3)}`,
        `avg tokens=${Math.round(avgTokens)}`,
      ],
    });
  }

  // Apply config-defined heuristics
  for (const rule of config.heuristics) {
    let match = true;
    const evidence: string[] = [];

    for (const [condition, threshold] of Object.entries(rule.when)) {
      if (condition === "retrieval_count_lte") {
        const avgRetrieval = traces.reduce((a, t) => a + t.retrieval.count, 0) / n;
        if (avgRetrieval > threshold) match = false;
        else evidence.push(`avg retrieval_count=${avgRetrieval.toFixed(1)}`);
      } else if (condition.endsWith("_lt")) {
        const scoreName = condition.replace(/_lt$/, "");
        const avg = avgScore(scoreName);
        if (avg == null || avg >= threshold) match = false;
        else evidence.push(`avg ${scoreName}=${avg.toFixed(2)}`);
      }
    }

    if (match && evidence.length > 0) {
      hypotheses.push({
        cause: rule.id,
        confidence: 0.6,
        evidence,
      });
    }
  }

  // Sort by confidence desc
  hypotheses.sort((a, b) => b.confidence - a.confidence);
  return hypotheses;
}
