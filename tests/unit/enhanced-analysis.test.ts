/**
 * Enhanced Analysis Modules — 통합 검증 테스트
 *
 * 5개 분석 모듈 + 통계 유틸리티 + fixPlan enrichment 검증
 */
import { describe, it, expect } from "vitest";
import {
  sampleTrace, sampleTrace2, sampleTrace3,
  sampleCluster, sampleFixPlan,
} from "../fixtures/traces.js";
import type { NormalizedTrace } from "../../src/types.js";

// ─── Stats ─────────────────────────────────────────────────────
import {
  mean, stddev, variance, median, percentile,
  cohensD, welchTTest, proportionTest,
  classifyEffectSize, deltaPct,
} from "../../src/utils/stats.js";

// ─── Regression ────────────────────────────────────────────────
import { detectRegressions } from "../../src/diagnosis/regression.js";

// ─── Prompt Comparison ─────────────────────────────────────────
import { comparePromptVersions } from "../../src/diagnosis/promptComparison.js";

// ─── Chain Analysis ────────────────────────────────────────────
import { analyzeChain, aggregateChains } from "../../src/diagnosis/chainAnalysis.js";
import type { LfObservation } from "../../src/adapters/langfuse/observations.js";

// ─── Cost-Quality ──────────────────────────────────────────────
import { analyzeCostQuality } from "../../src/diagnosis/costQuality.js";
import { estimateCost, isKnownModel } from "../../src/diagnosis/modelPricing.js";

// ─── Fix Plan Enrichment ───────────────────────────────────────
import { generateFixPlan } from "../../src/diagnosis/fixPlan.js";

// ─── Guardrails ────────────────────────────────────────────────
import {
  validateRegressionOutput,
  validateChainAnalysisOutput,
  validateCostQualityOutput,
  validateRecurrenceOutput,
} from "../../src/validation/guardrails.js";

// ════════════════════════════════════════════════════════════════
// Stats Utility
// ════════════════════════════════════════════════════════════════

describe("Stats Utility", () => {
  it("mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([])).toBe(0);
  });

  it("stddev", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  it("variance", () => {
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571, 2);
  });

  it("median", () => {
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("percentile", () => {
    const vals = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(vals, 95)).toBeCloseTo(95.05, 0);
  });

  it("Cohen's d — large effect", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [6, 7, 8, 9, 10];
    const d = cohensD(a, b);
    expect(Math.abs(d)).toBeGreaterThan(0.8); // large
  });

  it("Cohen's d — no effect", () => {
    const a = [5, 5, 5, 5, 5];
    const b = [5, 5, 5, 5, 5];
    expect(cohensD(a, b)).toBe(0);
  });

  it("Welch's t-test — significant difference", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 11, 12, 13, 14];
    const { p } = welchTTest(a, b);
    expect(p).toBeLessThan(0.01);
  });

  it("Welch's t-test — no difference", () => {
    const a = [5, 5, 5, 5, 5];
    const b = [5, 5, 5, 5, 5];
    const { p } = welchTTest(a, b);
    expect(p).toBe(1);
  });

  it("Welch's t-test — insufficient samples", () => {
    const { p } = welchTTest([1], [2]);
    expect(p).toBe(1);
  });

  it("proportionTest", () => {
    // 50% vs 90% success rate should be significant
    const p = proportionTest(50, 100, 90, 100);
    expect(p).toBeLessThan(0.01);
  });

  it("classifyEffectSize", () => {
    expect(classifyEffectSize(0.1)).toBe("none");
    expect(classifyEffectSize(0.3)).toBe("minor");
    expect(classifyEffectSize(0.6)).toBe("major");
    expect(classifyEffectSize(1.0)).toBe("critical");
  });

  it("deltaPct", () => {
    expect(deltaPct(100, 120)).toBe(20);
    expect(deltaPct(100, 80)).toBe(-20);
    expect(deltaPct(0, 0)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// Regression Detection
// ════════════════════════════════════════════════════════════════

describe("Regression Detection", () => {
  const goodTraces: NormalizedTrace[] = Array.from({ length: 20 }, (_, i) => ({
    ...sampleTrace,
    trace_id: `good-${i}`,
    scores: { correctness: 0.85 + Math.random() * 0.1, faithfulness: 0.9 },
    latency_ms: 2000 + Math.random() * 500,
    cost_usd: 0.03,
    status: "ok" as const,
  }));

  const badTraces: NormalizedTrace[] = Array.from({ length: 20 }, (_, i) => ({
    ...sampleTrace,
    trace_id: `bad-${i}`,
    scores: { correctness: 0.45 + Math.random() * 0.1, faithfulness: 0.5 },
    latency_ms: 6000 + Math.random() * 2000,
    cost_usd: 0.08,
    status: "error" as const,
  }));

  it("유의미한 회귀를 감지한다", () => {
    const report = detectRegressions(
      goodTraces, badTraces,
      { from: "2026-04-01", to: "2026-04-03" },
      { from: "2026-04-04", to: "2026-04-06" },
    );

    expect(report.has_significant_regression).toBe(true);
    expect(report.top_regressions.length).toBeGreaterThan(0);
    expect(report.regressions.some((r) => r.metric === "score.correctness")).toBe(true);

    const correctness = report.regressions.find((r) => r.metric === "score.correctness")!;
    expect(correctness.direction).toBe("degraded");
    expect(correctness.severity).not.toBe("none");
  });

  it("동일 데이터에서는 회귀를 감지하지 않는다", () => {
    const report = detectRegressions(
      goodTraces, goodTraces,
      { from: "2026-04-01", to: "2026-04-03" },
      { from: "2026-04-04", to: "2026-04-06" },
    );

    expect(report.has_significant_regression).toBe(false);
  });

  it("에러율 변화를 감지한다", () => {
    const report = detectRegressions(
      goodTraces, badTraces,
      { from: "2026-04-01", to: "2026-04-03" },
      { from: "2026-04-04", to: "2026-04-06" },
    );

    const errorRate = report.regressions.find((r) => r.metric === "error_rate");
    expect(errorRate).toBeDefined();
    expect(errorRate!.direction).toBe("degraded");
  });

  it("guardrail을 통과한다", () => {
    const report = detectRegressions(
      goodTraces, badTraces,
      { from: "2026-04-01", to: "2026-04-03" },
      { from: "2026-04-04", to: "2026-04-06" },
    );
    const check = validateRegressionOutput(report);
    expect(check.valid).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Prompt Comparison
// ════════════════════════════════════════════════════════════════

describe("Prompt Version Comparison", () => {
  const v1Traces: NormalizedTrace[] = Array.from({ length: 15 }, (_, i) => ({
    ...sampleTrace,
    trace_id: `v1-${i}`,
    prompt_version: "v1.0",
    scores: { correctness: 0.6 + Math.random() * 0.1, faithfulness: 0.65 },
    latency_ms: 5000,
    cost_usd: 0.06,
  }));

  const v2Traces: NormalizedTrace[] = Array.from({ length: 15 }, (_, i) => ({
    ...sampleTrace,
    trace_id: `v2-${i}`,
    prompt_version: "v2.0",
    scores: { correctness: 0.85 + Math.random() * 0.05, faithfulness: 0.9 },
    latency_ms: 4000,
    cost_usd: 0.05,
  }));

  it("두 버전을 비교하여 우세 버전을 판별한다", () => {
    const report = comparePromptVersions([...v1Traces, ...v2Traces]);

    expect(report.versions).toHaveLength(2);
    expect(report.pairwise).toHaveLength(1);
    expect(report.overall_recommendation).toBeDefined();
    expect(report.overall_recommendation).toContain("v2.0");
  });

  it("1개 버전만 있으면 비교 불가를 반환한다", () => {
    const report = comparePromptVersions(v1Traces);
    expect(report.pairwise).toHaveLength(0);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it("best_version에 지표별 최고 버전이 포함된다", () => {
    const report = comparePromptVersions([...v1Traces, ...v2Traces]);
    expect(report.best_version.length).toBeGreaterThan(0);
    const bestCorrectness = report.best_version.find((b) => b.metric === "score.correctness");
    expect(bestCorrectness?.version).toBe("v2.0");
  });
});

// ════════════════════════════════════════════════════════════════
// Chain Analysis
// ════════════════════════════════════════════════════════════════

describe("Chain Analysis", () => {
  const mockObservations: LfObservation[] = [
    {
      id: "obs-1", traceId: "trace-001", type: "GENERATION", name: "retrieval",
      startTime: "2026-04-07T00:00:00Z", endTime: "2026-04-07T00:00:04Z",
      input: null, output: null, metadata: null, level: "DEFAULT",
      statusMessage: null, model: null, promptTokens: 100, completionTokens: 0, totalTokens: 100,
      calculatedTotalCost: 0.001,
    },
    {
      id: "obs-2", traceId: "trace-001", type: "GENERATION", name: "llm-generate",
      startTime: "2026-04-07T00:00:04Z", endTime: "2026-04-07T00:00:06Z",
      input: null, output: null, metadata: null, level: "DEFAULT",
      statusMessage: null, model: "gpt-4o", promptTokens: 2000, completionTokens: 500, totalTokens: 2500,
      calculatedTotalCost: 0.03,
    },
    {
      id: "obs-3", traceId: "trace-001", type: "GENERATION", name: "post-process",
      startTime: "2026-04-07T00:00:06Z", endTime: "2026-04-07T00:00:06.200Z",
      input: null, output: null, metadata: null, level: "ERROR",
      statusMessage: "validation failed", model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      calculatedTotalCost: 0,
    },
  ];

  it("체인을 분석하여 steps를 반환한다", () => {
    const report = analyzeChain("trace-001", mockObservations);
    expect(report.total_steps).toBe(3);
    expect(report.steps).toHaveLength(3);
    expect(report.steps[0].name).toBe("retrieval");
    expect(report.steps[1].name).toBe("llm-generate");
  });

  it("병목을 식별한다", () => {
    const report = analyzeChain("trace-001", mockObservations);
    expect(report.bottleneck).not.toBeNull();
    expect(report.bottleneck!.step_name).toBe("retrieval");
    expect(report.bottleneck!.contribution_pct).toBeGreaterThan(50);
  });

  it("에러 지점을 식별한다", () => {
    const report = analyzeChain("trace-001", mockObservations);
    expect(report.failure_points).toHaveLength(1);
    expect(report.failure_points[0].step_name).toBe("post-process");
  });

  it("chain_health를 올바르게 계산한다", () => {
    const report = analyzeChain("trace-001", mockObservations);
    expect(report.chain_health).toBeCloseTo(0.67, 1); // 2/3 steps OK
  });

  it("빈 observation은 graceful하게 처리한다", () => {
    const report = analyzeChain("trace-empty", []);
    expect(report.total_steps).toBe(0);
    expect(report.chain_health).toBe(1);
  });

  it("다수 trace 집계 분석", () => {
    const r1 = analyzeChain("t1", mockObservations);
    const r2 = analyzeChain("t2", mockObservations);
    const agg = aggregateChains([r1, r2]);

    expect(agg.trace_count).toBe(2);
    expect(agg.common_bottleneck).not.toBeNull();
    expect(agg.common_bottleneck!.step_name).toBe("retrieval");
    expect(agg.common_bottleneck!.frequency_pct).toBe(100);
  });

  it("guardrail을 통과한다", () => {
    const report = analyzeChain("trace-001", mockObservations);
    const check = validateChainAnalysisOutput(report);
    expect(check.valid).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Cost-Quality Analysis
// ════════════════════════════════════════════════════════════════

describe("Cost-Quality Analysis", () => {
  it("모델 가격 테이블이 동작한다", () => {
    expect(isKnownModel("gpt-4o")).toBe(true);
    expect(isKnownModel("gpt-4o-2024-08-06")).toBe(true);
    expect(isKnownModel("unknown-model-xyz")).toBe(false);

    const cost = estimateCost("gpt-4o", 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });

  it("모델별 비용-품질 요약을 생성한다", () => {
    const expensiveTraces: NormalizedTrace[] = Array.from({ length: 10 }, (_, i) => ({
      ...sampleTrace,
      trace_id: `expensive-${i}`,
      model_name: "gpt-4o",
      scores: { correctness: 0.9, faithfulness: 0.85 },
      cost_usd: 0.08,
    }));

    const cheapTraces: NormalizedTrace[] = Array.from({ length: 10 }, (_, i) => ({
      ...sampleTrace,
      trace_id: `cheap-${i}`,
      model_name: "gpt-4o-mini",
      scores: { correctness: 0.87, faithfulness: 0.82 },
      cost_usd: 0.005,
    }));

    const report = analyzeCostQuality([...expensiveTraces, ...cheapTraces]);
    expect(report.models).toHaveLength(2);
    expect(report.tradeoffs.length).toBeGreaterThan(0);
  });

  it("절감 시나리오를 제안한다", () => {
    const expensiveTraces: NormalizedTrace[] = Array.from({ length: 10 }, (_, i) => ({
      ...sampleTrace,
      trace_id: `exp-${i}`,
      model_name: "gpt-4o",
      scores: { correctness: 0.9, faithfulness: 0.85 },
      cost_usd: 0.08,
    }));

    const cheapTraces: NormalizedTrace[] = Array.from({ length: 10 }, (_, i) => ({
      ...sampleTrace,
      trace_id: `chp-${i}`,
      model_name: "gpt-4o-mini",
      scores: { correctness: 0.87, faithfulness: 0.82 },
      cost_usd: 0.005,
    }));

    const report = analyzeCostQuality([...expensiveTraces, ...cheapTraces]);
    // gpt-4o → gpt-4o-mini 전환은 비용 절감이 크고 품질 하락이 적으므로 switch 또는 investigate
    const tradeoff = report.tradeoffs.find(
      (t) => t.from_model === "gpt-4o" && t.to_model === "gpt-4o-mini",
    );
    expect(tradeoff).toBeDefined();
    expect(tradeoff!.cost_change_pct).toBeLessThan(-50);
  });

  it("guardrail을 통과한다", () => {
    const traces: NormalizedTrace[] = Array.from({ length: 10 }, (_, i) => ({
      ...sampleTrace,
      trace_id: `g-${i}`,
      model_name: "gpt-4o",
    }));
    const report = analyzeCostQuality(traces);
    const check = validateCostQualityOutput(report);
    expect(check.valid).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Model Pricing
// ════════════════════════════════════════════════════════════════

describe("Model Pricing", () => {
  it("알려진 모델의 비용을 계산한다", () => {
    // gpt-4o: $2.5/1M input, $10/1M output
    const cost = estimateCost("gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 1);
  });

  it("fuzzy match가 동작한다", () => {
    expect(estimateCost("gpt-4o-2024-08-06", 1000, 500)).not.toBeNull();
    expect(estimateCost("claude-3-5-sonnet-20241022", 1000, 500)).not.toBeNull();
  });

  it("알 수 없는 모델은 null 반환", () => {
    expect(estimateCost("totally-unknown-model", 1000, 500)).toBeNull();
  });

  it("null 모델명은 null 반환", () => {
    expect(estimateCost(null, 1000, 500)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// Fix Plan Enrichment
// ════════════════════════════════════════════════════════════════

describe("Fix Plan Enrichment", () => {
  it("regression 정보가 fix plan에 반영된다", () => {
    const plan = generateFixPlan(sampleCluster, "conservative", true, {
      regression: {
        baseline_period: { from: "2026-04-01", to: "2026-04-03" },
        current_period: { from: "2026-04-04", to: "2026-04-06" },
        regressions: [],
        top_regressions: [{
          metric: "score.correctness",
          baseline_mean: 0.85,
          baseline_stddev: 0.05,
          current_mean: 0.45,
          current_stddev: 0.1,
          delta_pct: -47,
          effect_size: -2.5,
          p_value: 0.001,
          severity: "critical",
          direction: "degraded",
          sample_sizes: { baseline: 20, current: 20 },
        }],
        summary: "critical regression",
        has_significant_regression: true,
      },
    });

    const regressionAction = plan.actions.find((a) => a.action.includes("회귀 조사"));
    expect(regressionAction).toBeDefined();
    expect(plan.summary).toContain("회귀");
  });

  it("enriched context 없이도 정상 동작한다", () => {
    const plan = generateFixPlan(sampleCluster, "conservative", true);
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  it("chain bottleneck 정보가 fix plan에 반영된다", () => {
    const plan = generateFixPlan(sampleCluster, "conservative", true, {
      chainAnalysis: {
        trace_count: 10,
        avg_chain_health: 0.7,
        common_bottleneck: {
          step_name: "retrieval",
          frequency_pct: 80,
          avg_contribution_pct: 65,
        },
        common_failure_point: null,
        position_analysis: [],
        summary: "bottleneck",
        recommendations: [],
      },
    });

    const chainAction = plan.actions.find((a) => a.action.includes("체인 병목"));
    expect(chainAction).toBeDefined();
  });
});
