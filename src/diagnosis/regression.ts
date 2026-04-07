/**
 * Time-Series Regression Detection
 *
 * 현재 기간과 베이스라인 기간의 trace를 비교하여
 * 통계적으로 유의미한 품질/성능 저하를 탐지한다.
 *
 * Langfuse 대시보드와의 차별점:
 * - Cohen's d effect size로 "얼마나 심각한" 변화인지 정량화
 * - Welch's t-test로 우연이 아닌 실제 변화인지 판별
 * - 여러 지표를 동시에 비교하여 종합 판단
 */
import type { NormalizedTrace } from "../types.js";
import {
  mean, stddev, welchTTest, cohensD,
  classifyEffectSize, deltaPct,
  proportionTest,
} from "../utils/stats.js";

export interface MetricRegression {
  metric: string;
  baseline_mean: number;
  baseline_stddev: number;
  current_mean: number;
  current_stddev: number;
  delta_pct: number;
  effect_size: number;
  p_value: number;
  severity: "none" | "minor" | "major" | "critical";
  direction: "improved" | "degraded" | "unchanged";
  sample_sizes: { baseline: number; current: number };
}

export interface RegressionReport {
  baseline_period: { from: string; to: string };
  current_period: { from: string; to: string };
  regressions: MetricRegression[];
  top_regressions: MetricRegression[];
  summary: string;
  has_significant_regression: boolean;
}

/** Minimum sample size for reliable statistical comparison */
const MIN_SAMPLE_SIZE = 5;

/** Extract all numeric metric arrays from traces */
function extractMetrics(traces: NormalizedTrace[]): Map<string, number[]> {
  const metrics = new Map<string, number[]>();

  const latencies: number[] = [];
  const costs: number[] = [];
  const inputTokens: number[] = [];
  const outputTokens: number[] = [];

  for (const t of traces) {
    latencies.push(t.latency_ms);
    costs.push(t.cost_usd);
    inputTokens.push(t.usage.input_tokens);
    outputTokens.push(t.usage.output_tokens);

    for (const [name, value] of Object.entries(t.scores)) {
      if (!metrics.has(`score.${name}`)) metrics.set(`score.${name}`, []);
      metrics.get(`score.${name}`)!.push(value);
    }
  }

  metrics.set("latency_ms", latencies);
  metrics.set("cost_usd", costs);
  metrics.set("input_tokens", inputTokens);
  metrics.set("output_tokens", outputTokens);

  return metrics;
}

/** Determine direction: for scores higher=better, for latency/cost lower=better */
function getDirection(
  metric: string,
  baselineMean: number,
  currentMean: number,
): "improved" | "degraded" | "unchanged" {
  const diff = currentMean - baselineMean;
  const threshold = Math.abs(baselineMean) * 0.01; // 1% noise floor

  if (Math.abs(diff) < threshold) return "unchanged";

  // Higher is better for scores
  if (metric.startsWith("score.")) {
    return diff > 0 ? "improved" : "degraded";
  }
  // Lower is better for latency, cost, tokens
  return diff < 0 ? "improved" : "degraded";
}

export function detectRegressions(
  baselineTraces: NormalizedTrace[],
  currentTraces: NormalizedTrace[],
  baselinePeriod: { from: string; to: string },
  currentPeriod: { from: string; to: string },
): RegressionReport {
  const baselineMetrics = extractMetrics(baselineTraces);
  const currentMetrics = extractMetrics(currentTraces);

  // Union of all metric names
  const allMetricNames = new Set([
    ...baselineMetrics.keys(),
    ...currentMetrics.keys(),
  ]);

  const regressions: MetricRegression[] = [];

  for (const name of allMetricNames) {
    const baseVals = baselineMetrics.get(name) ?? [];
    const currVals = currentMetrics.get(name) ?? [];

    if (baseVals.length < MIN_SAMPLE_SIZE || currVals.length < MIN_SAMPLE_SIZE) {
      continue; // 샘플 부족 — 신뢰 불가
    }

    const baseMean = mean(baseVals);
    const currMean = mean(currVals);
    const effectSize = cohensD(baseVals, currVals);
    const { p } = welchTTest(baseVals, currVals);
    const severity = classifyEffectSize(effectSize);
    const direction = getDirection(name, baseMean, currMean);

    regressions.push({
      metric: name,
      baseline_mean: Number(baseMean.toFixed(4)),
      baseline_stddev: Number(stddev(baseVals).toFixed(4)),
      current_mean: Number(currMean.toFixed(4)),
      current_stddev: Number(stddev(currVals).toFixed(4)),
      delta_pct: Number(deltaPct(baseMean, currMean).toFixed(2)),
      effect_size: Number(effectSize.toFixed(3)),
      p_value: Number(p.toFixed(4)),
      severity,
      direction,
      sample_sizes: { baseline: baseVals.length, current: currVals.length },
    });
  }

  // Error rate comparison (proportion test)
  const baseErrors = baselineTraces.filter((t) => t.status === "error").length;
  const currErrors = currentTraces.filter((t) => t.status === "error").length;
  if (baselineTraces.length >= MIN_SAMPLE_SIZE && currentTraces.length >= MIN_SAMPLE_SIZE) {
    const baseRate = baseErrors / baselineTraces.length;
    const currRate = currErrors / currentTraces.length;
    const pVal = proportionTest(
      baselineTraces.length - baseErrors, baselineTraces.length,
      currentTraces.length - currErrors, currentTraces.length,
    );
    const diff = currRate - baseRate;
    const severity: MetricRegression["severity"] =
      Math.abs(diff) < 0.05 ? "none" :
      Math.abs(diff) < 0.1 ? "minor" :
      Math.abs(diff) < 0.2 ? "major" : "critical";

    regressions.push({
      metric: "error_rate",
      baseline_mean: Number(baseRate.toFixed(4)),
      baseline_stddev: 0,
      current_mean: Number(currRate.toFixed(4)),
      current_stddev: 0,
      delta_pct: Number(deltaPct(baseRate, currRate).toFixed(2)),
      effect_size: Number(diff.toFixed(3)),
      p_value: Number(pVal.toFixed(4)),
      severity,
      direction: diff > 0.01 ? "degraded" : diff < -0.01 ? "improved" : "unchanged",
      sample_sizes: { baseline: baselineTraces.length, current: currentTraces.length },
    });
  }

  // Sort by severity (critical first), then by absolute effect size
  const severityOrder = { critical: 0, major: 1, minor: 2, none: 3 };
  regressions.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return Math.abs(b.effect_size) - Math.abs(a.effect_size);
  });

  const topRegressions = regressions
    .filter((r) => r.direction === "degraded" && r.severity !== "none")
    .slice(0, 5);

  const hasSignificant = topRegressions.some(
    (r) => r.p_value < 0.05 && (r.severity === "major" || r.severity === "critical"),
  );

  const summary = buildSummary(topRegressions, baselineTraces.length, currentTraces.length, hasSignificant);

  return {
    baseline_period: baselinePeriod,
    current_period: currentPeriod,
    regressions,
    top_regressions: topRegressions,
    summary,
    has_significant_regression: hasSignificant,
  };
}

function buildSummary(
  top: MetricRegression[],
  baselineN: number,
  currentN: number,
  significant: boolean,
): string {
  if (top.length === 0) {
    return `유의미한 회귀 없음 (baseline ${baselineN}건, current ${currentN}건 비교)`;
  }

  const lines = [`${top.length}개 지표에서 저하 감지 (baseline ${baselineN}건 vs current ${currentN}건):`];
  for (const r of top) {
    const arrow = r.delta_pct > 0 ? "▲" : "▼";
    lines.push(
      `  - ${r.metric}: ${r.baseline_mean} → ${r.current_mean} (${arrow}${Math.abs(r.delta_pct)}%, effect=${r.effect_size}, p=${r.p_value}) [${r.severity}]`,
    );
  }

  if (significant) {
    lines.push("⚠ 통계적으로 유의미한 심각한 회귀가 감지되었습니다.");
  }

  return lines.join("\n");
}
