/**
 * Prompt Version A/B Comparison
 *
 * 동일 trace name/route에서 프롬프트 버전별 품질·비용·지연 비교.
 * Langfuse 대시보드와의 차별점:
 * - 버전 간 통계적 유의성 검정 (단순 평균 비교가 아님)
 * - 지표별 "최고 버전" 자동 판별
 * - 샘플 부족 시 경고하여 조기 결론 방지
 */
import type { NormalizedTrace } from "../types.js";
import type { MetricRegression } from "./regression.js";
import {
  mean, stddev, welchTTest, cohensD,
  classifyEffectSize, deltaPct,
  proportionTest,
} from "../utils/stats.js";

export interface PromptVersionSummary {
  prompt_version: string;
  trace_count: number;
  avg_scores: Record<string, number>;
  avg_latency_ms: number;
  avg_cost_usd: number;
  error_rate: number;
  p95_latency_ms: number;
}

export interface PromptPairComparison {
  version_a: string;
  version_b: string;
  metric_comparisons: MetricRegression[];
  winner: string | null;
  recommendation: string;
}

export interface PromptComparisonReport {
  versions: PromptVersionSummary[];
  pairwise: PromptPairComparison[];
  best_version: { metric: string; version: string; value: number }[];
  overall_recommendation: string | null;
  summary: string;
  warnings: string[];
}

const MIN_SAMPLE = 5;

function buildVersionSummary(
  version: string,
  traces: NormalizedTrace[],
): PromptVersionSummary {
  const scores: Record<string, number[]> = {};
  for (const t of traces) {
    for (const [k, v] of Object.entries(t.scores)) {
      if (!scores[k]) scores[k] = [];
      scores[k].push(v);
    }
  }

  const avgScores: Record<string, number> = {};
  for (const [k, vals] of Object.entries(scores)) {
    avgScores[k] = Number(mean(vals).toFixed(4));
  }

  const latencies = traces.map((t) => t.latency_ms).sort((a, b) => a - b);
  const p95Idx = Math.floor(latencies.length * 0.95);

  return {
    prompt_version: version,
    trace_count: traces.length,
    avg_scores: avgScores,
    avg_latency_ms: Number(mean(traces.map((t) => t.latency_ms)).toFixed(1)),
    avg_cost_usd: Number(mean(traces.map((t) => t.cost_usd)).toFixed(5)),
    error_rate: Number(
      (traces.filter((t) => t.status === "error").length / traces.length).toFixed(4),
    ),
    p95_latency_ms: latencies[p95Idx] ?? latencies[latencies.length - 1] ?? 0,
  };
}

function comparePair(
  vA: string, tracesA: NormalizedTrace[],
  vB: string, tracesB: NormalizedTrace[],
): PromptPairComparison {
  const comparisons: MetricRegression[] = [];

  // Collect all score keys from both groups
  const scoreKeys = new Set<string>();
  for (const t of [...tracesA, ...tracesB]) {
    for (const k of Object.keys(t.scores)) scoreKeys.add(k);
  }

  // Compare each score
  for (const key of scoreKeys) {
    const aVals = tracesA.map((t) => t.scores[key]).filter((v) => v != null);
    const bVals = tracesB.map((t) => t.scores[key]).filter((v) => v != null);
    if (aVals.length < MIN_SAMPLE || bVals.length < MIN_SAMPLE) continue;

    const d = cohensD(aVals, bVals);
    const { p } = welchTTest(aVals, bVals);
    const mA = mean(aVals);
    const mB = mean(bVals);

    comparisons.push({
      metric: `score.${key}`,
      baseline_mean: Number(mA.toFixed(4)),
      baseline_stddev: Number(stddev(aVals).toFixed(4)),
      current_mean: Number(mB.toFixed(4)),
      current_stddev: Number(stddev(bVals).toFixed(4)),
      delta_pct: Number(deltaPct(mA, mB).toFixed(2)),
      effect_size: Number(d.toFixed(3)),
      p_value: Number(p.toFixed(4)),
      severity: classifyEffectSize(d),
      direction: mB > mA ? "improved" : mB < mA ? "degraded" : "unchanged",
      sample_sizes: { baseline: aVals.length, current: bVals.length },
    });
  }

  // Compare latency (lower is better)
  const latA = tracesA.map((t) => t.latency_ms);
  const latB = tracesB.map((t) => t.latency_ms);
  if (latA.length >= MIN_SAMPLE && latB.length >= MIN_SAMPLE) {
    const d = cohensD(latA, latB);
    const { p } = welchTTest(latA, latB);
    const mA = mean(latA);
    const mB = mean(latB);
    comparisons.push({
      metric: "latency_ms",
      baseline_mean: Number(mA.toFixed(1)),
      baseline_stddev: Number(stddev(latA).toFixed(1)),
      current_mean: Number(mB.toFixed(1)),
      current_stddev: Number(stddev(latB).toFixed(1)),
      delta_pct: Number(deltaPct(mA, mB).toFixed(2)),
      effect_size: Number(d.toFixed(3)),
      p_value: Number(p.toFixed(4)),
      severity: classifyEffectSize(d),
      direction: mB < mA ? "improved" : mB > mA ? "degraded" : "unchanged",
      sample_sizes: { baseline: latA.length, current: latB.length },
    });
  }

  // Compare cost (lower is better)
  const costA = tracesA.map((t) => t.cost_usd);
  const costB = tracesB.map((t) => t.cost_usd);
  if (costA.length >= MIN_SAMPLE && costB.length >= MIN_SAMPLE) {
    const d = cohensD(costA, costB);
    const { p } = welchTTest(costA, costB);
    const mA = mean(costA);
    const mB = mean(costB);
    comparisons.push({
      metric: "cost_usd",
      baseline_mean: Number(mA.toFixed(5)),
      baseline_stddev: Number(stddev(costA).toFixed(5)),
      current_mean: Number(mB.toFixed(5)),
      current_stddev: Number(stddev(costB).toFixed(5)),
      delta_pct: Number(deltaPct(mA, mB).toFixed(2)),
      effect_size: Number(d.toFixed(3)),
      p_value: Number(p.toFixed(4)),
      severity: classifyEffectSize(d),
      direction: mB < mA ? "improved" : mB > mA ? "degraded" : "unchanged",
      sample_sizes: { baseline: costA.length, current: costB.length },
    });
  }

  // Determine winner: version with more "improved" comparisons at significant level
  const significantImproved = comparisons.filter(
    (c) => c.direction === "improved" && c.p_value < 0.05,
  ).length;
  const significantDegraded = comparisons.filter(
    (c) => c.direction === "degraded" && c.p_value < 0.05,
  ).length;

  let winner: string | null = null;
  let recommendation: string;
  if (significantImproved > significantDegraded) {
    winner = vB;
    recommendation = `${vB}가 ${significantImproved}개 지표에서 유의미하게 우수`;
  } else if (significantDegraded > significantImproved) {
    winner = vA;
    recommendation = `${vA}가 ${significantDegraded}개 지표에서 유의미하게 우수`;
  } else {
    recommendation = "통계적으로 유의미한 차이 없음 — 추가 데이터 필요";
  }

  return { version_a: vA, version_b: vB, metric_comparisons: comparisons, winner, recommendation };
}

export function comparePromptVersions(
  traces: NormalizedTrace[],
): PromptComparisonReport {
  const warnings: string[] = [];

  // Group by prompt_version
  const groups = new Map<string, NormalizedTrace[]>();
  for (const t of traces) {
    const version = t.prompt_version ?? "unknown";
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version)!.push(t);
  }

  if (groups.size < 2) {
    return {
      versions: [...groups.entries()].map(([v, ts]) => buildVersionSummary(v, ts)),
      pairwise: [],
      best_version: [],
      overall_recommendation: null,
      summary: groups.size === 0
        ? "분석할 trace가 없습니다."
        : `프롬프트 버전이 1개(${[...groups.keys()][0]})뿐이라 비교 불가`,
      warnings: ["비교를 위해 최소 2개 이상의 프롬프트 버전이 필요합니다."],
    };
  }

  // Build summaries
  const versions: PromptVersionSummary[] = [];
  for (const [v, ts] of groups) {
    if (ts.length < MIN_SAMPLE) {
      warnings.push(`${v}: ${ts.length}건으로 샘플 부족 (최소 ${MIN_SAMPLE}건 필요) — 결과 신뢰도 낮음`);
    }
    versions.push(buildVersionSummary(v, ts));
  }

  // Pairwise comparisons
  const versionKeys = [...groups.keys()];
  const pairwise: PromptPairComparison[] = [];
  for (let i = 0; i < versionKeys.length; i++) {
    for (let j = i + 1; j < versionKeys.length; j++) {
      pairwise.push(
        comparePair(
          versionKeys[i], groups.get(versionKeys[i])!,
          versionKeys[j], groups.get(versionKeys[j])!,
        ),
      );
    }
  }

  // Best version per metric
  const bestVersion: { metric: string; version: string; value: number }[] = [];
  const allScoreKeys = new Set(versions.flatMap((v) => Object.keys(v.avg_scores)));
  for (const key of allScoreKeys) {
    let best = versions[0];
    for (const v of versions) {
      if ((v.avg_scores[key] ?? 0) > (best.avg_scores[key] ?? 0)) best = v;
    }
    bestVersion.push({ metric: `score.${key}`, version: best.prompt_version, value: best.avg_scores[key] ?? 0 });
  }
  // Best latency (lowest)
  const bestLat = versions.reduce((a, b) => (a.avg_latency_ms < b.avg_latency_ms ? a : b));
  bestVersion.push({ metric: "latency_ms", version: bestLat.prompt_version, value: bestLat.avg_latency_ms });
  // Best cost (lowest)
  const bestCost = versions.reduce((a, b) => (a.avg_cost_usd < b.avg_cost_usd ? a : b));
  bestVersion.push({ metric: "cost_usd", version: bestCost.prompt_version, value: bestCost.avg_cost_usd });

  // Overall recommendation
  const winCounts = new Map<string, number>();
  for (const p of pairwise) {
    if (p.winner) winCounts.set(p.winner, (winCounts.get(p.winner) ?? 0) + 1);
  }
  let overallRec: string | null = null;
  if (winCounts.size > 0) {
    const [topVersion, topWins] = [...winCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    overallRec = `${topVersion} 권장 (${topWins}/${pairwise.length} 비교에서 우세)`;
  }

  const summary = buildSummary(versions, pairwise, overallRec);

  return { versions, pairwise, best_version: bestVersion, overall_recommendation: overallRec, summary, warnings };
}

function buildSummary(
  versions: PromptVersionSummary[],
  pairwise: PromptPairComparison[],
  overallRec: string | null,
): string {
  const lines = [`${versions.length}개 프롬프트 버전 비교:`];
  for (const v of versions) {
    lines.push(`  - ${v.prompt_version}: ${v.trace_count}건, correctness=${v.avg_scores.correctness ?? "N/A"}, latency=${v.avg_latency_ms}ms, cost=$${v.avg_cost_usd}`);
  }
  if (overallRec) lines.push(`\n추천: ${overallRec}`);
  return lines.join("\n");
}
