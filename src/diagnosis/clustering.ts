import type { NormalizedTrace, FailureCluster, RootCauseHypothesis } from "../types.js";
import { fingerprint, clusterId } from "../utils/hash.js";
import { applyHeuristics } from "./heuristics.js";
import type { PlaybookConfig } from "../types.js";

function scoreBucket(score: number | undefined): string {
  if (score == null) return "no_score";
  if (score < 0.3) return "very_low";
  if (score < 0.5) return "low";
  if (score < 0.7) return "medium";
  if (score < 0.85) return "high";
  return "very_high";
}

function latencyBucket(ms: number): string {
  if (ms < 1000) return "fast";
  if (ms < 3000) return "normal";
  if (ms < 5000) return "slow";
  return "very_slow";
}

export function buildFingerprint(t: NormalizedTrace): string {
  const primaryError = t.errors[0]?.kind ?? "none";
  return fingerprint(
    t.trace_name,
    t.route,
    t.prompt_version,
    primaryError,
    scoreBucket(t.scores.correctness),
    t.retrieval.count === 0 ? "retrieval_miss" : "retrieval_ok",
  );
}

export function clusterTraces(
  traces: NormalizedTrace[],
  config: PlaybookConfig,
  maxClusters: number = 20,
): FailureCluster[] {
  const groups = new Map<string, NormalizedTrace[]>();

  for (const t of traces) {
    const fp = buildFingerprint(t);
    const existing = groups.get(fp) ?? [];
    existing.push(t);
    groups.set(fp, existing);
  }

  const clusters: FailureCluster[] = [];

  for (const [fp, members] of groups.entries()) {
    const id = clusterId(fp);
    const symptoms = deriveSymptoms(members);
    const hypotheses = applyHeuristics(members, config);

    clusters.push({
      cluster_id: id,
      fingerprint: fp,
      size: members.length,
      trace_ids: members.map((m) => m.trace_id),
      symptoms,
      feature_summary: {
        avg_latency_ms: avg(members.map((m) => m.latency_ms)),
        avg_correctness: avg(members.map((m) => m.scores.correctness).filter(nonNull)),
        avg_faithfulness: avg(members.map((m) => m.scores.faithfulness).filter(nonNull)),
        latency_bucket: latencyBucket(avg(members.map((m) => m.latency_ms))),
        trace_name: members[0].trace_name,
        route: members[0].route,
        prompt_version: members[0].prompt_version,
      },
      root_cause_hypotheses: hypotheses,
      priority_score: 0, // scored later
      representative_trace_ids: members.slice(0, 3).map((m) => m.trace_id),
    });
  }

  // sort by size desc and trim
  clusters.sort((a, b) => b.size - a.size);
  return clusters.slice(0, maxClusters);
}

function deriveSymptoms(traces: NormalizedTrace[]): string[] {
  const symptoms = new Set<string>();
  for (const t of traces) {
    if (t.scores.correctness != null && t.scores.correctness < 0.7) symptoms.add("correctness<0.7");
    if (t.scores.faithfulness != null && t.scores.faithfulness < 0.75) symptoms.add("faithfulness<0.75");
    if (t.scores.context_relevance != null && t.scores.context_relevance < 0.65) symptoms.add("context_relevance<0.65");
    if (t.latency_ms > 5000) symptoms.add("high_latency");
    if (t.retrieval.count === 0) symptoms.add("retrieval_miss");
    if (t.status === "error") symptoms.add("error");
  }
  return [...symptoms];
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v != null;
}
