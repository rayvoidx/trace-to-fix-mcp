import type {
  FailureCluster,
  FixPlan,
  RecommendedAction,
  RootCauseHypothesis,
} from "../types.js";
import type { RegressionReport } from "./regression.js";
import type { PromptComparisonReport } from "./promptComparison.js";
import type { ChainAnalysisReport, AggregateChainReport } from "./chainAnalysis.js";
import type { CostQualityReport } from "./costQuality.js";
import type { RecurrenceReport } from "./recurrence.js";

/** Optional enriched context from advanced analysis modules */
export interface EnrichedContext {
  regression?: RegressionReport;
  promptComparison?: PromptComparisonReport;
  chainAnalysis?: ChainAnalysisReport | AggregateChainReport;
  costQuality?: CostQualityReport;
  recurrence?: RecurrenceReport;
}

const ACTION_MAP: Record<string, RecommendedAction[]> = {
  retrieval_quality_issue: [
    {
      priority: 1,
      owner: "backend_or_retrieval",
      action: "retrieval filter 완화 및 reranker cutoff 재검토",
      expected_impact: "correctness +0.08~0.15",
    },
    {
      priority: 2,
      owner: "prompt_owner",
      action: "context grounding 규칙 강화 (no-context fallback 추가)",
      expected_impact: "faithfulness +0.05~0.10",
    },
  ],
  answer_grounding_issue: [
    {
      priority: 1,
      owner: "prompt_owner",
      action: "answer grounding 규칙 강화 — 출처 인용 필수화",
      expected_impact: "faithfulness +0.10~0.15",
    },
  ],
  over_compression: [
    {
      priority: 1,
      owner: "prompt_owner",
      action: "답변 길이 최소 기준 추가, 핵심 정보 누락 방지 규칙",
      expected_impact: "correctness +0.05~0.10",
    },
  ],
  infrastructure_latency: [
    {
      priority: 1,
      owner: "infra",
      action: "모델 호출 타임아웃/배치 전략 점검, GPU 가용성 확인",
      expected_impact: "p95 latency -30~50%",
    },
  ],
  prompt_bloat_or_model_overuse: [
    {
      priority: 1,
      owner: "prompt_owner",
      action: "프롬프트 길이 최적화, 불필요한 context 제거",
      expected_impact: "cost -20~40%, latency -10~20%",
    },
    {
      priority: 2,
      owner: "backend",
      action: "모델 다운그레이드 가능 여부 평가 (예: gpt-4o → gpt-4o-mini)",
      expected_impact: "cost -50~70%",
    },
  ],
};

export function generateFixPlan(
  cluster: FailureCluster,
  strategy: "conservative" | "aggressive" = "conservative",
  includeExperiment: boolean = true,
  enriched?: EnrichedContext,
): FixPlan {
  const actions: RecommendedAction[] = [];
  const hypotheses = cluster.root_cause_hypotheses;

  // 동일 cause 중복 제거 (built-in + config 규칙이 같은 ID를 가질 수 있음)
  const seenCauses = new Set<string>();

  for (const h of hypotheses) {
    if (seenCauses.has(h.cause)) continue;
    seenCauses.add(h.cause);

    const mapped = ACTION_MAP[h.cause];
    if (mapped) {
      if (strategy === "conservative") {
        actions.push({ ...mapped[0] });
      } else {
        actions.push(...mapped.map((a) => ({ ...a })));
      }
    } else {
      actions.push({
        priority: actions.length + 1,
        owner: "team",
        action: `${h.cause} 에 대한 수동 조사 필요`,
        expected_impact: "unknown",
      });
    }
  }

  // ─── Enriched context → data-driven actions ────────────────────
  if (enriched) {
    // Regression: 특정 지표가 최근 악화됐다면 구체적 정보 추가
    if (enriched.regression?.has_significant_regression) {
      for (const r of enriched.regression.top_regressions) {
        actions.push({
          priority: 0,
          owner: "team",
          action: `${r.metric} 회귀 조사: ${r.baseline_mean} → ${r.current_mean} (${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}%, p=${r.p_value}) — ${enriched.regression.current_period.from} 이후 변경사항 점검`,
          expected_impact: `${r.metric} 회복`,
        });
      }
    }

    // Chain analysis: 병목 step이 있으면 구체적 최적화 제안
    if (enriched.chainAnalysis) {
      const chain = enriched.chainAnalysis;
      if ("common_bottleneck" in chain && chain.common_bottleneck) {
        const bn = chain.common_bottleneck;
        actions.push({
          priority: 0,
          owner: "backend",
          action: `체인 병목 ${bn.step_name} 최적화 (${bn.frequency_pct}% trace에서 평균 ${bn.avg_contribution_pct}% latency 기여)`,
          expected_impact: `latency -${Math.round(bn.avg_contribution_pct * 0.3)}~${Math.round(bn.avg_contribution_pct * 0.5)}%`,
        });
      } else if ("bottleneck" in chain && chain.bottleneck) {
        const bn = chain.bottleneck;
        actions.push({
          priority: 0,
          owner: "backend",
          action: `체인 병목 ${bn.step_name} 최적화 (${bn.reason})`,
          expected_impact: `latency -${Math.round(bn.contribution_pct * 0.3)}~${Math.round(bn.contribution_pct * 0.5)}%`,
        });
      }
    }

    // Prompt comparison: 더 나은 버전이 있으면 롤포워드 제안
    if (enriched.promptComparison?.overall_recommendation) {
      const best = enriched.promptComparison.best_version;
      const bestVersions = [...new Set(best.map((b) => b.version))];
      if (bestVersions.length === 1) {
        actions.push({
          priority: 0,
          owner: "prompt_owner",
          action: `프롬프트 ${bestVersions[0]}로 롤포워드 검토 — 대부분의 지표에서 우수`,
          expected_impact: enriched.promptComparison.overall_recommendation,
        });
      }
    }

    // Cost-quality: 절감 가능 시나리오가 있으면 추가
    if (enriched.costQuality && enriched.costQuality.potential_savings.length > 0) {
      const top = enriched.costQuality.potential_savings[0];
      actions.push({
        priority: 0,
        owner: "backend",
        action: `모델 전환 검토: ${top.scenario} (${top.savings_pct.toFixed(0)}% 비용 절감)`,
        expected_impact: top.quality_impact,
      });
    }

    // Recurrence: 재발 패턴이면 높은 우선순위로 경고
    const recMatch = enriched.recurrence?.recurrences.find(
      (r) => r.current_cluster_id === cluster.cluster_id,
    );
    if (recMatch) {
      actions.unshift({
        priority: 0,
        owner: "team",
        action: `⚠ 재발 패턴: ${recMatch.days_since_resolution}일 전 해결된 문제가 다시 발생 (${recMatch.match_type} match, ${recMatch.severity_comparison}) — 이전 수정이 충분했는지 재검토`,
        expected_impact: "재발 방지",
      });
    }
  }

  // Renumber priorities
  actions.forEach((a, i) => (a.priority = i + 1));

  const summary = buildSummary(cluster, enriched);

  const experimentPlan = includeExperiment
    ? buildExperimentPlan(cluster, hypotheses)
    : [];

  return {
    target_id: cluster.cluster_id,
    target_type: "cluster",
    summary,
    hypotheses,
    actions,
    experiment_plan: experimentPlan,
    owner_suggestions: [...new Set(actions.map((a) => a.owner))],
  };
}

function buildSummary(cluster: FailureCluster, enriched?: EnrichedContext): string {
  const parts: string[] = [];
  const fs = cluster.feature_summary as Record<string, unknown>;

  if (fs.trace_name) parts.push(`${fs.trace_name}`);
  if (fs.route) parts.push(`route=${fs.route}`);
  if (cluster.symptoms.length) parts.push(`symptoms: ${cluster.symptoms.join(", ")}`);
  parts.push(`${cluster.size}건 발생`);

  if (enriched?.regression?.has_significant_regression) {
    parts.push("⚠ 최근 회귀 감지");
  }
  if (enriched?.recurrence?.recurrences.some((r) => r.current_cluster_id === cluster.cluster_id)) {
    parts.push("⚠ 재발 패턴");
  }

  return parts.join(" / ");
}

function buildExperimentPlan(
  cluster: FailureCluster,
  hypotheses: RootCauseHypothesis[],
): string[] {
  const plan: string[] = [
    `baseline dataset ${Math.min(cluster.size, 50)}건 추출`,
  ];

  for (const h of hypotheses) {
    switch (h.cause) {
      case "retrieval_quality_issue":
        plan.push("retrieval cutoff A/B 실험");
        plan.push("reranker threshold 비교 평가");
        break;
      case "answer_grounding_issue":
        plan.push("prompt v(current) vs v(next) offline eval");
        break;
      case "over_compression":
        plan.push("답변 길이 제한 완화 후 correctness 재측정");
        break;
      case "infrastructure_latency":
        plan.push("부하 테스트 및 autoscaling 정책 검토");
        break;
      default:
        plan.push(`${h.cause} 관련 수동 A/B 평가`);
    }
  }

  plan.push("성공 기준 달성 여부 확인 후 배포 결정");
  return plan;
}
