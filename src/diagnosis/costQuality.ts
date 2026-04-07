/**
 * Cost-Quality Tradeoff Analysis
 *
 * 모델별 비용·품질·지연을 비교하여 최적의 모델 조합을 추천.
 *
 * Langfuse 대시보드와의 차별점:
 * - "gpt-4o → gpt-4o-mini 전환 시 비용 60% 절감, 품질 3% 하락" 같은 구체적 트레이드오프
 * - cost efficiency score (품질/비용) 자동 계산
 * - 일일 비용 추정 및 절감 시나리오 제시
 */
import type { NormalizedTrace } from "../types.js";
import { mean, welchTTest, cohensD, classifyEffectSize, deltaPct } from "../utils/stats.js";
import { estimateCost, isKnownModel } from "./modelPricing.js";

export interface ModelSummary {
  model_name: string;
  trace_count: number;
  avg_scores: Record<string, number>;
  avg_latency_ms: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  cost_efficiency: number;
  avg_tokens: { input: number; output: number; total: number };
}

export interface ModelTradeoff {
  from_model: string;
  to_model: string;
  cost_change_pct: number;
  quality_changes: Record<string, number>;
  latency_change_pct: number;
  recommendation: "switch" | "keep" | "investigate";
  rationale: string;
}

export interface CostQualityReport {
  models: ModelSummary[];
  tradeoffs: ModelTradeoff[];
  total_daily_cost_estimate: number;
  potential_savings: { scenario: string; savings_pct: number; quality_impact: string }[];
  summary: string;
  warnings: string[];
}

function qualityComposite(scores: Record<string, number>): number {
  const weights: Record<string, number> = {
    correctness: 0.4,
    faithfulness: 0.3,
    context_relevance: 0.2,
    conciseness: 0.1,
  };
  let totalWeight = 0;
  let weightedSum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (scores[key] != null) {
      weightedSum += scores[key] * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) {
    // Fallback: average all available scores
    const vals = Object.values(scores);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return weightedSum / totalWeight;
}

function buildModelSummary(modelName: string, traces: NormalizedTrace[]): ModelSummary {
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

  // Fill in missing costs from model pricing table
  const costs = traces.map((t) => {
    if (t.cost_usd > 0) return t.cost_usd;
    return estimateCost(t.model_name, t.usage.input_tokens, t.usage.output_tokens) ?? 0;
  });

  const avgCost = mean(costs);
  const composite = qualityComposite(avgScores);
  const efficiency = avgCost > 0 ? composite / avgCost : 0;

  return {
    model_name: modelName,
    trace_count: traces.length,
    avg_scores: avgScores,
    avg_latency_ms: Number(mean(traces.map((t) => t.latency_ms)).toFixed(1)),
    avg_cost_usd: Number(avgCost.toFixed(6)),
    total_cost_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(4)),
    cost_efficiency: Number(efficiency.toFixed(2)),
    avg_tokens: {
      input: Math.round(mean(traces.map((t) => t.usage.input_tokens))),
      output: Math.round(mean(traces.map((t) => t.usage.output_tokens))),
      total: Math.round(mean(traces.map((t) => t.usage.total_tokens))),
    },
  };
}

function evaluateTradeoff(from: ModelSummary, to: ModelSummary): ModelTradeoff {
  const costChange = deltaPct(from.avg_cost_usd, to.avg_cost_usd);
  const latencyChange = deltaPct(from.avg_latency_ms, to.avg_latency_ms);

  const qualityChanges: Record<string, number> = {};
  const allKeys = new Set([...Object.keys(from.avg_scores), ...Object.keys(to.avg_scores)]);
  for (const key of allKeys) {
    const fromVal = from.avg_scores[key];
    const toVal = to.avg_scores[key];
    if (fromVal != null && toVal != null) {
      qualityChanges[key] = Number(deltaPct(fromVal, toVal).toFixed(2));
    }
  }

  // Decision logic
  const costSaving = costChange < -10; // at least 10% cheaper
  const qualityLoss = Object.values(qualityChanges).some((c) => c < -5); // any score drops > 5%
  const bigQualityLoss = Object.values(qualityChanges).some((c) => c < -15);

  let recommendation: ModelTradeoff["recommendation"];
  let rationale: string;

  if (costSaving && !qualityLoss) {
    recommendation = "switch";
    rationale = `${to.model_name}로 전환 시 비용 ${Math.abs(costChange).toFixed(0)}% 절감, 품질 영향 미미`;
  } else if (costSaving && qualityLoss && !bigQualityLoss) {
    recommendation = "investigate";
    rationale = `${to.model_name}로 전환 시 비용 ${Math.abs(costChange).toFixed(0)}% 절감 가능하나 일부 품질 저하 — A/B 테스트 권장`;
  } else if (costSaving && bigQualityLoss) {
    recommendation = "keep";
    rationale = `${to.model_name}는 비용 절감되나 품질 저하 심각 — 전환 비추천`;
  } else {
    recommendation = "keep";
    rationale = `${to.model_name}가 비용 대비 이점 없음`;
  }

  return {
    from_model: from.model_name,
    to_model: to.model_name,
    cost_change_pct: Number(costChange.toFixed(1)),
    quality_changes: qualityChanges,
    latency_change_pct: Number(latencyChange.toFixed(1)),
    recommendation,
    rationale,
  };
}

export function analyzeCostQuality(traces: NormalizedTrace[]): CostQualityReport {
  const warnings: string[] = [];

  // Group by model
  const groups = new Map<string, NormalizedTrace[]>();
  for (const t of traces) {
    const model = t.model_name ?? "unknown";
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model)!.push(t);
  }

  const models: ModelSummary[] = [];
  for (const [name, ts] of groups) {
    if (!isKnownModel(name) && name !== "unknown") {
      warnings.push(`${name}: 가격 테이블에 없는 모델 — 비용 추정치가 부정확할 수 있음`);
    }
    models.push(buildModelSummary(name, ts));
  }

  // Sort by cost efficiency desc
  models.sort((a, b) => b.cost_efficiency - a.cost_efficiency);

  // Pairwise tradeoffs (from expensive to cheaper)
  const tradeoffs: ModelTradeoff[] = [];
  const sortedByCost = [...models].sort((a, b) => b.avg_cost_usd - a.avg_cost_usd);
  for (let i = 0; i < sortedByCost.length; i++) {
    for (let j = i + 1; j < sortedByCost.length; j++) {
      tradeoffs.push(evaluateTradeoff(sortedByCost[i], sortedByCost[j]));
    }
  }

  // Daily cost estimate (extrapolate from data period)
  const totalCost = models.reduce((sum, m) => sum + m.total_cost_usd, 0);
  // Rough estimate: assume data covers ~1 day
  const dailyCostEstimate = Number(totalCost.toFixed(4));

  // Savings scenarios
  const savings: CostQualityReport["potential_savings"] = [];
  for (const t of tradeoffs) {
    if (t.recommendation === "switch") {
      const from = models.find((m) => m.model_name === t.from_model);
      if (from) {
        savings.push({
          scenario: `${t.from_model} → ${t.to_model}`,
          savings_pct: Math.abs(t.cost_change_pct),
          quality_impact: t.rationale,
        });
      }
    }
  }

  const summary = buildSummary(models, tradeoffs, dailyCostEstimate, savings);

  return { models, tradeoffs, total_daily_cost_estimate: dailyCostEstimate, potential_savings: savings, summary, warnings };
}

function buildSummary(
  models: ModelSummary[],
  tradeoffs: ModelTradeoff[],
  dailyCost: number,
  savings: CostQualityReport["potential_savings"],
): string {
  const lines = [`${models.length}개 모델 비용-품질 분석 (추정 일일 비용: $${dailyCost}):`];

  for (const m of models) {
    lines.push(`  - ${m.model_name}: ${m.trace_count}건, 효율=${m.cost_efficiency}, 평균비용=$${m.avg_cost_usd}`);
  }

  if (savings.length > 0) {
    lines.push("\n절감 가능 시나리오:");
    for (const s of savings) {
      lines.push(`  - ${s.scenario}: ${s.savings_pct.toFixed(0)}% 절감 — ${s.quality_impact}`);
    }
  } else if (models.length > 1) {
    lines.push("\n현재 모델 구성이 최적이거나, 전환 시 품질 저하가 큼");
  }

  return lines.join("\n");
}
