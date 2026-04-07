/**
 * Observation Chain Bottleneck Analysis
 *
 * trace 내 개별 observation(LLM 호출, retrieval, tool call)을
 * 체인으로 분석하여 병목과 실패 지점을 정확히 찾아낸다.
 *
 * Langfuse 대시보드와의 차별점:
 * - Waterfall은 보여주지만 "어디가 병목인지"는 사용자가 판단해야 함
 * - 이 모듈은 자동으로 "retrieval step이 전체 latency의 68%"를 계산
 * - 다수 trace를 집계하면 "position 3이 78% 확률로 병목" 패턴 발견
 */
import type { LfObservation } from "../adapters/langfuse/observations.js";

export interface ObservationStep {
  observation_id: string;
  name: string;
  type: string;
  position: number;
  duration_ms: number;
  duration_pct: number;
  tokens: { input: number; output: number; total: number };
  cost_usd: number;
  has_error: boolean;
  error_message: string | null;
  model: string | null;
}

export interface BottleneckInfo {
  step_name: string;
  position: number;
  reason: string;
  contribution_pct: number;
}

export interface FailurePoint {
  step_name: string;
  position: number;
  error: string;
}

export interface ChainAnalysisReport {
  trace_id: string;
  total_steps: number;
  total_duration_ms: number;
  steps: ObservationStep[];
  bottleneck: BottleneckInfo | null;
  failure_points: FailurePoint[];
  chain_health: number;
  recommendations: string[];
}

export interface AggregateChainReport {
  trace_count: number;
  avg_chain_health: number;
  common_bottleneck: {
    step_name: string;
    frequency_pct: number;
    avg_contribution_pct: number;
  } | null;
  common_failure_point: {
    step_name: string;
    frequency_pct: number;
  } | null;
  position_analysis: PositionStats[];
  summary: string;
  recommendations: string[];
}

export interface PositionStats {
  position: number;
  most_common_name: string;
  avg_duration_ms: number;
  avg_duration_pct: number;
  error_rate: number;
  is_common_bottleneck: boolean;
}

/** Analyze a single trace's observation chain */
export function analyzeChain(
  traceId: string,
  observations: LfObservation[],
): ChainAnalysisReport {
  if (observations.length === 0) {
    return {
      trace_id: traceId,
      total_steps: 0,
      total_duration_ms: 0,
      steps: [],
      bottleneck: null,
      failure_points: [],
      chain_health: 1,
      recommendations: ["observation이 없습니다 — tracing 설정을 확인하세요."],
    };
  }

  // Sort by startTime
  const sorted = [...observations].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  // Calculate total duration from first start to last end
  const firstStart = new Date(sorted[0].startTime).getTime();
  const lastEnd = Math.max(
    ...sorted.map((o) =>
      o.endTime ? new Date(o.endTime).getTime() : new Date(o.startTime).getTime(),
    ),
  );
  const totalDuration = Math.max(lastEnd - firstStart, 1);

  const steps: ObservationStep[] = sorted.map((obs, idx) => {
    const start = new Date(obs.startTime).getTime();
    const end = obs.endTime
      ? new Date(obs.endTime).getTime()
      : start;
    const duration = Math.max(end - start, 0);

    return {
      observation_id: obs.id,
      name: obs.name ?? `step_${idx + 1}`,
      type: obs.type,
      position: idx + 1,
      duration_ms: duration,
      duration_pct: Number(((duration / totalDuration) * 100).toFixed(1)),
      tokens: {
        input: obs.promptTokens,
        output: obs.completionTokens,
        total: obs.totalTokens,
      },
      cost_usd: obs.calculatedTotalCost ?? 0,
      has_error: obs.level === "ERROR",
      error_message: obs.level === "ERROR" ? obs.statusMessage : null,
      model: obs.model,
    };
  });

  // Identify bottleneck: step with highest duration_pct
  let bottleneck: BottleneckInfo | null = null;
  const maxDuration = steps.reduce((max, s) => (s.duration_ms > max.duration_ms ? s : max), steps[0]);
  if (maxDuration.duration_pct > 30) {
    const reasons: string[] = [];
    if (maxDuration.duration_pct > 50) reasons.push(`전체 시간의 ${maxDuration.duration_pct}% 차지`);
    if (maxDuration.tokens.total > 3000) reasons.push(`토큰 ${maxDuration.tokens.total}개 사용`);
    if (maxDuration.type.toLowerCase().includes("retrieval") || maxDuration.name?.toLowerCase().includes("retrieval")) {
      reasons.push("retrieval step으로 외부 의존성 존재");
    }
    bottleneck = {
      step_name: maxDuration.name,
      position: maxDuration.position,
      reason: reasons.length > 0 ? reasons.join("; ") : `latency ${maxDuration.duration_ms}ms`,
      contribution_pct: maxDuration.duration_pct,
    };
  }

  // Identify failure points
  const failurePoints = steps
    .filter((s) => s.has_error)
    .map((s) => ({
      step_name: s.name,
      position: s.position,
      error: s.error_message ?? "unknown error",
    }));

  // Chain health: (successful steps / total steps)
  const errorCount = steps.filter((s) => s.has_error).length;
  const chainHealth = Number(((steps.length - errorCount) / steps.length).toFixed(2));

  // Recommendations
  const recommendations = generateRecommendations(steps, bottleneck, failurePoints);

  return {
    trace_id: traceId,
    total_steps: steps.length,
    total_duration_ms: totalDuration,
    steps,
    bottleneck,
    failure_points: failurePoints,
    chain_health: chainHealth,
    recommendations,
  };
}

/** Aggregate chain analysis across multiple traces */
export function aggregateChains(
  reports: ChainAnalysisReport[],
): AggregateChainReport {
  if (reports.length === 0) {
    return {
      trace_count: 0,
      avg_chain_health: 0,
      common_bottleneck: null,
      common_failure_point: null,
      position_analysis: [],
      summary: "분석할 trace가 없습니다.",
      recommendations: [],
    };
  }

  const avgHealth =
    reports.reduce((sum, r) => sum + r.chain_health, 0) / reports.length;

  // Bottleneck frequency
  const bottleneckCounts = new Map<string, { count: number; contributions: number[] }>();
  for (const r of reports) {
    if (r.bottleneck) {
      const name = r.bottleneck.step_name;
      const entry = bottleneckCounts.get(name) ?? { count: 0, contributions: [] };
      entry.count++;
      entry.contributions.push(r.bottleneck.contribution_pct);
      bottleneckCounts.set(name, entry);
    }
  }

  let commonBottleneck: AggregateChainReport["common_bottleneck"] = null;
  if (bottleneckCounts.size > 0) {
    const [topName, topData] = [...bottleneckCounts.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    )[0];
    commonBottleneck = {
      step_name: topName,
      frequency_pct: Number(((topData.count / reports.length) * 100).toFixed(1)),
      avg_contribution_pct: Number(
        (topData.contributions.reduce((a, b) => a + b, 0) / topData.contributions.length).toFixed(1),
      ),
    };
  }

  // Failure point frequency
  const failureCounts = new Map<string, number>();
  for (const r of reports) {
    for (const f of r.failure_points) {
      failureCounts.set(f.step_name, (failureCounts.get(f.step_name) ?? 0) + 1);
    }
  }

  let commonFailure: AggregateChainReport["common_failure_point"] = null;
  if (failureCounts.size > 0) {
    const [topName, topCount] = [...failureCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    commonFailure = {
      step_name: topName,
      frequency_pct: Number(((topCount / reports.length) * 100).toFixed(1)),
    };
  }

  // Position-level aggregation
  const maxPositions = Math.max(...reports.map((r) => r.total_steps));
  const positionAnalysis: PositionStats[] = [];

  for (let pos = 1; pos <= maxPositions; pos++) {
    const stepsAtPos = reports
      .flatMap((r) => r.steps)
      .filter((s) => s.position === pos);
    if (stepsAtPos.length === 0) continue;

    // Most common name at this position
    const nameCounts = new Map<string, number>();
    for (const s of stepsAtPos) {
      nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
    }
    const mostCommonName = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const avgDuration = stepsAtPos.reduce((s, st) => s + st.duration_ms, 0) / stepsAtPos.length;
    const avgDurationPct = stepsAtPos.reduce((s, st) => s + st.duration_pct, 0) / stepsAtPos.length;
    const errorRate = stepsAtPos.filter((s) => s.has_error).length / stepsAtPos.length;

    const isBottleneck = commonBottleneck?.step_name === mostCommonName;

    positionAnalysis.push({
      position: pos,
      most_common_name: mostCommonName,
      avg_duration_ms: Number(avgDuration.toFixed(1)),
      avg_duration_pct: Number(avgDurationPct.toFixed(1)),
      error_rate: Number(errorRate.toFixed(4)),
      is_common_bottleneck: isBottleneck,
    });
  }

  const recommendations = generateAggregateRecommendations(
    commonBottleneck, commonFailure, avgHealth, positionAnalysis,
  );

  const summary = buildAggregateSummary(
    reports.length, avgHealth, commonBottleneck, commonFailure,
  );

  return {
    trace_count: reports.length,
    avg_chain_health: Number(avgHealth.toFixed(2)),
    common_bottleneck: commonBottleneck,
    common_failure_point: commonFailure,
    position_analysis: positionAnalysis,
    summary,
    recommendations,
  };
}

function generateRecommendations(
  steps: ObservationStep[],
  bottleneck: BottleneckInfo | null,
  failures: FailurePoint[],
): string[] {
  const recs: string[] = [];

  if (bottleneck && bottleneck.contribution_pct > 50) {
    const name = bottleneck.step_name.toLowerCase();
    if (name.includes("retrieval") || name.includes("search") || name.includes("rag")) {
      recs.push(`${bottleneck.step_name}이 전체 시간의 ${bottleneck.contribution_pct}% — retrieval 캐싱 또는 병렬화 검토`);
    } else if (name.includes("llm") || name.includes("generate") || name.includes("completion")) {
      recs.push(`${bottleneck.step_name}이 전체 시간의 ${bottleneck.contribution_pct}% — 프롬프트 최적화 또는 모델 다운그레이드 검토`);
    } else {
      recs.push(`${bottleneck.step_name}이 전체 시간의 ${bottleneck.contribution_pct}% — 최적화 필요`);
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      recs.push(`step ${f.position} (${f.step_name}) 에러: ${f.error} — 에러 핸들링 또는 재시도 로직 필요`);
    }
  }

  // Token efficiency
  const highTokenSteps = steps.filter((s) => s.tokens.total > 4000);
  for (const s of highTokenSteps) {
    recs.push(`${s.name}: 토큰 ${s.tokens.total}개 — 프롬프트 길이 최적화 검토`);
  }

  return recs;
}

function generateAggregateRecommendations(
  bottleneck: AggregateChainReport["common_bottleneck"],
  failure: AggregateChainReport["common_failure_point"],
  health: number,
  positions: PositionStats[],
): string[] {
  const recs: string[] = [];

  if (bottleneck && bottleneck.frequency_pct > 50) {
    recs.push(
      `${bottleneck.step_name}이 ${bottleneck.frequency_pct}%의 trace에서 병목 (평균 ${bottleneck.avg_contribution_pct}% latency 기여) — 최우선 최적화 대상`,
    );
  }

  if (failure && failure.frequency_pct > 20) {
    recs.push(
      `${failure.step_name}이 ${failure.frequency_pct}%의 trace에서 에러 발생 — 안정성 개선 필요`,
    );
  }

  if (health < 0.7) {
    recs.push(`평균 체인 건강도 ${(health * 100).toFixed(0)}% — 전반적인 에러 핸들링 강화 필요`);
  }

  const highErrorPositions = positions.filter((p) => p.error_rate > 0.3);
  for (const p of highErrorPositions) {
    recs.push(`position ${p.position} (${p.most_common_name}): 에러율 ${(p.error_rate * 100).toFixed(0)}% — 안정성 개선 필요`);
  }

  return recs;
}

function buildAggregateSummary(
  traceCount: number,
  health: number,
  bottleneck: AggregateChainReport["common_bottleneck"],
  failure: AggregateChainReport["common_failure_point"],
): string {
  const lines = [`${traceCount}개 trace 체인 분석 (평균 건강도: ${(health * 100).toFixed(0)}%):`];

  if (bottleneck) {
    lines.push(`  병목: ${bottleneck.step_name} (${bottleneck.frequency_pct}% 빈도, 평균 ${bottleneck.avg_contribution_pct}% 기여)`);
  } else {
    lines.push("  뚜렷한 공통 병목 없음");
  }

  if (failure) {
    lines.push(`  주요 실패 지점: ${failure.step_name} (${failure.frequency_pct}% 빈도)`);
  }

  return lines.join("\n");
}
