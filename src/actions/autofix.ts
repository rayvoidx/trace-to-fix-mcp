/**
 * Autofix Orchestrator
 *
 * 진단 → 데이터셋 생성 → 프롬프트 수정 컨텍스트 → 배포까지
 * 전체 closed loop을 한 번에 실행하는 오케스트레이션 레이어.
 *
 * 자동으로 프롬프트를 수정하지 않는다 (사용자 확인 필요).
 * 대신 모든 단계를 실행하고 사용자에게 판단 재료를 제공한다.
 */
import type { NormalizedTrace, FailureCluster, FixPlan } from "../types.js";
import { clusterTraces } from "../diagnosis/clustering.js";
import { rankClusters } from "../diagnosis/priority.js";
import { generateFixPlan, type EnrichedContext } from "../diagnosis/fixPlan.js";
import { detectRegressions, type RegressionReport } from "../diagnosis/regression.js";
import { analyzeChain, aggregateChains, type AggregateChainReport } from "../diagnosis/chainAnalysis.js";
import { analyzeCostQuality, type CostQualityReport } from "../diagnosis/costQuality.js";
import { buildPromptFixContext, type PromptFixContext } from "./promptFix.js";
import { createEvalDatasetFromTraces, type EvalDatasetResult } from "./evalRunner.js";
import { fetchTraces } from "../adapters/langfuse/traces.js";
import { fetchObservations } from "../adapters/langfuse/observations.js";
import { loadPlaybookConfig } from "../server/config.js";
import { validateClusterInvariants } from "../validation/invariants.js";
import { withGuardrail, validateClusterOutput, validateFixPlanOutput } from "../validation/guardrails.js";
import { logger } from "../utils/logger.js";

export interface AutofixInput {
  time_from: string;
  time_to: string;
  baseline_from?: string;
  baseline_to?: string;
  trace_name?: string;
  prompt_name?: string;
  create_dataset?: boolean;
  max_traces?: number;
}

export interface AutofixReport {
  // 1단계: 데이터 수집
  trace_count: number;
  baseline_trace_count: number;

  // 2단계: 진단
  regression: RegressionReport | null;
  clusters: FailureCluster[];
  top_cluster: FailureCluster | null;
  chain_analysis: AggregateChainReport | null;
  cost_quality: CostQualityReport | null;

  // 3단계: 처방
  fix_plan: FixPlan | null;
  prompt_fix_context: PromptFixContext | null;

  // 4단계: 준비
  eval_dataset: EvalDatasetResult | null;

  // 요약
  summary: string;
  next_steps: string[];
}

export async function runAutofix(input: AutofixInput): Promise<AutofixReport> {
  const config = loadPlaybookConfig();
  const maxTraces = input.max_traces ?? 200;

  logger.info({ input }, "Starting autofix pipeline");

  // ─── 1단계: 데이터 수집 ──────────────────────────────────────
  const currentTraces = await fetchTraces({
    time_from: input.time_from,
    time_to: input.time_to,
    filters: { trace_name: input.trace_name ? [input.trace_name] : undefined },
    limit: maxTraces,
  });

  // 베이스라인 (자동 계산 또는 사용자 지정)
  const currentFrom = new Date(input.time_from);
  const currentTo = new Date(input.time_to);
  const durationMs = currentTo.getTime() - currentFrom.getTime();
  const baseFrom = input.baseline_from ?? new Date(currentFrom.getTime() - durationMs).toISOString();
  const baseTo = input.baseline_to ?? input.time_from;

  const baselineTraces = await fetchTraces({
    time_from: baseFrom,
    time_to: baseTo,
    filters: { trace_name: input.trace_name ? [input.trace_name] : undefined },
    limit: maxTraces,
  });

  if (currentTraces.length === 0) {
    return emptyReport(currentTraces.length, baselineTraces.length, "현재 기간에 trace가 없습니다.");
  }

  // ─── 2단계: 진단 ────────────────────────────────────────────
  // 회귀 탐지
  let regression: RegressionReport | null = null;
  if (baselineTraces.length >= 5 && currentTraces.length >= 5) {
    regression = detectRegressions(
      baselineTraces, currentTraces,
      { from: baseFrom, to: baseTo },
      { from: input.time_from, to: input.time_to },
    );
  }

  // 클러스터링
  const clusters = clusterTraces(currentTraces, config);
  const ranked = rankClusters(clusters, {
    totalTraces: currentTraces.length,
    prodEnvironment: currentTraces[0]?.environment === "prod",
  });

  // 클러스터 검증
  for (const c of ranked) {
    validateClusterInvariants(c);
    withGuardrail("autofix", validateClusterOutput, c);
  }

  const topCluster = ranked[0] ?? null;

  // 체인 분석 (상위 클러스터의 대표 trace)
  let chainAnalysis: AggregateChainReport | null = null;
  if (topCluster && topCluster.representative_trace_ids.length > 0) {
    try {
      const chainReports = [];
      for (const tid of topCluster.representative_trace_ids.slice(0, 5)) {
        const obs = await fetchObservations(tid);
        chainReports.push(analyzeChain(tid, obs));
      }
      if (chainReports.length > 1) {
        chainAnalysis = aggregateChains(chainReports);
      }
    } catch (err) {
      logger.warn({ err }, "Chain analysis failed — skipping");
    }
  }

  // 비용-품질 분석
  const costQuality = currentTraces.length >= 5
    ? analyzeCostQuality(currentTraces)
    : null;

  // ─── 3단계: 처방 ────────────────────────────────────────────
  let fixPlan: FixPlan | null = null;
  let promptFixContext: PromptFixContext | null = null;

  if (topCluster) {
    const enriched: EnrichedContext = {};
    if (regression) enriched.regression = regression;
    if (chainAnalysis) enriched.chainAnalysis = chainAnalysis;
    if (costQuality) enriched.costQuality = costQuality;

    fixPlan = generateFixPlan(topCluster, "conservative", true, enriched);
    withGuardrail("autofix", validateFixPlanOutput, fixPlan);

    // 프롬프트 수정 컨텍스트 (prompt_name이 있으면)
    if (input.prompt_name) {
      try {
        promptFixContext = await buildPromptFixContext(
          input.prompt_name, topCluster, fixPlan,
        );
      } catch (err) {
        logger.warn({ err, prompt_name: input.prompt_name }, "Failed to build prompt fix context");
      }
    }
  }

  // ─── 4단계: 준비 ────────────────────────────────────────────
  let evalDataset: EvalDatasetResult | null = null;
  if (input.create_dataset && topCluster) {
    try {
      const clusterTraceObjs = currentTraces.filter(
        (t) => topCluster.trace_ids.includes(t.trace_id),
      );
      const datasetName = `autofix-${topCluster.cluster_id.slice(0, 8)}-${Date.now()}`;
      evalDataset = await createEvalDatasetFromTraces(datasetName, clusterTraceObjs, topCluster);
    } catch (err) {
      logger.warn({ err }, "Failed to create eval dataset");
    }
  }

  // ─── 요약 ──────────────────────────────────────────────────
  const summary = buildSummary(
    currentTraces.length, baselineTraces.length,
    regression, ranked, topCluster, fixPlan,
    chainAnalysis, costQuality,
  );

  const nextSteps = buildNextSteps(
    fixPlan, promptFixContext, evalDataset, regression,
  );

  return {
    trace_count: currentTraces.length,
    baseline_trace_count: baselineTraces.length,
    regression,
    clusters: ranked,
    top_cluster: topCluster,
    chain_analysis: chainAnalysis,
    cost_quality: costQuality,
    fix_plan: fixPlan,
    prompt_fix_context: promptFixContext,
    eval_dataset: evalDataset,
    summary,
    next_steps: nextSteps,
  };
}

function emptyReport(current: number, baseline: number, reason: string): AutofixReport {
  return {
    trace_count: current,
    baseline_trace_count: baseline,
    regression: null,
    clusters: [],
    top_cluster: null,
    chain_analysis: null,
    cost_quality: null,
    fix_plan: null,
    prompt_fix_context: null,
    eval_dataset: null,
    summary: reason,
    next_steps: ["데이터가 있는 시간대를 지정해주세요."],
  };
}

function buildSummary(
  currentN: number, baselineN: number,
  regression: RegressionReport | null,
  clusters: FailureCluster[],
  topCluster: FailureCluster | null,
  fixPlan: FixPlan | null,
  chain: AggregateChainReport | null,
  cost: CostQualityReport | null,
): string {
  const lines: string[] = [`📊 자동 분석 완료 (현재 ${currentN}건, 베이스라인 ${baselineN}건)`];

  if (regression?.has_significant_regression) {
    lines.push(`⚠ 회귀 감지: ${regression.top_regressions.length}개 지표 악화`);
  } else if (regression) {
    lines.push("✅ 유의미한 회귀 없음");
  }

  if (clusters.length > 0) {
    lines.push(`🔍 ${clusters.length}개 실패 클러스터 발견`);
    if (topCluster) {
      const fs = topCluster.feature_summary as Record<string, unknown>;
      lines.push(`  최우선: ${fs.trace_name ?? "unknown"} (${topCluster.size}건, priority ${topCluster.priority_score.toFixed(2)})`);
    }
  }

  if (chain?.common_bottleneck) {
    lines.push(`⏱ 병목: ${chain.common_bottleneck.step_name} (${chain.common_bottleneck.frequency_pct}% trace에서 ${chain.common_bottleneck.avg_contribution_pct}% latency)`);
  }

  if (cost?.potential_savings.length) {
    lines.push(`💰 비용 절감 가능: ${cost.potential_savings[0].scenario} (${cost.potential_savings[0].savings_pct.toFixed(0)}%)`);
  }

  if (fixPlan) {
    lines.push(`🔧 수정 계획: ${fixPlan.actions.length}개 액션`);
  }

  return lines.join("\n");
}

function buildNextSteps(
  fixPlan: FixPlan | null,
  promptCtx: PromptFixContext | null,
  evalDataset: EvalDatasetResult | null,
  regression: RegressionReport | null,
): string[] {
  const steps: string[] = [];

  if (promptCtx) {
    steps.push(`프롬프트 "${promptCtx.current_prompt.name}" v${promptCtx.current_prompt.version}을 수정하세요. 제안: ${promptCtx.suggested_changes.join("; ")}`);
    steps.push("수정된 프롬프트를 lf_create_prompt_version으로 새 버전 등록");
  }

  if (evalDataset) {
    steps.push(`데이터셋 "${evalDataset.dataset_name}" (${evalDataset.item_count}건)이 생성되었습니다. expectedOutput을 채운 후 평가를 실행하세요.`);
  } else if (fixPlan) {
    steps.push("lf_create_eval_dataset로 실패 trace 기반 평가 데이터셋을 생성하세요.");
  }

  if (fixPlan && fixPlan.actions.length > 0) {
    steps.push("수정 후 lf_detect_regression으로 개선 여부를 확인하세요.");
  }

  if (regression?.has_significant_regression) {
    steps.push("회귀의 원인이 되는 배포/변경사항을 점검하세요.");
  }

  if (steps.length === 0) {
    steps.push("현재 심각한 문제가 감지되지 않았습니다. 정기 모니터링을 계속하세요.");
  }

  return steps;
}
