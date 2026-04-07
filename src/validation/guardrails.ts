/**
 * Validation Guardrails Layer
 *
 * Generator(분석 결과 생성)와 Evaluator(결과 검증)를 분리한다.
 * 린터/타입체커처럼 결정론적 도구를 결합하여
 * 에이전트 출력의 오염을 최소화한다.
 *
 * 핵심 원칙:
 * - 모든 tool output은 guardrail을 통과해야 한다
 * - 실패 시 재시도하되, 같은 실패 반복은 차단한다
 * - soft/hard 두 수준으로 구분한다
 */
import { z } from "zod";
import { logger } from "../utils/logger.js";
import type { FailureCluster, FixPlan, NormalizedTrace } from "../types.js";

// ─── Failure Circuit Breaker ────────────────────────────────────

interface FailureRecord {
  key: string;
  count: number;
  lastError: string;
  firstSeen: number;
  lastSeen: number;
}

class CircuitBreaker {
  private failures = new Map<string, FailureRecord>();
  private readonly maxRetries: number;
  private readonly windowMs: number;

  constructor(maxRetries = 3, windowMs = 300_000) {
    this.maxRetries = maxRetries;
    this.windowMs = windowMs;
  }

  check(key: string): void {
    const record = this.failures.get(key);
    if (!record) return;

    if (
      record.count >= this.maxRetries &&
      Date.now() - record.lastSeen < this.windowMs
    ) {
      throw new Error(
        `Circuit breaker open for "${key}": failed ${record.count} times. ` +
        `Last error: ${record.lastError}. ` +
        `Wait ${Math.ceil((this.windowMs - (Date.now() - record.lastSeen)) / 1000)}s or fix the underlying issue.`,
      );
    }

    // Window expired, reset
    if (Date.now() - record.lastSeen >= this.windowMs) {
      this.failures.delete(key);
    }
  }

  recordFailure(key: string, error: string): void {
    const existing = this.failures.get(key);
    if (existing) {
      existing.count++;
      existing.lastError = error;
      existing.lastSeen = Date.now();
    } else {
      this.failures.set(key, {
        key,
        count: 1,
        lastError: error,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      });
    }

    logger.warn(
      { key, count: this.failures.get(key)!.count, maxRetries: this.maxRetries },
      "Failure recorded in circuit breaker",
    );
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  getStatus(): Record<string, FailureRecord> {
    return Object.fromEntries(this.failures);
  }
}

export const circuitBreaker = new CircuitBreaker();

// ─── Output Validators (Evaluator role) ─────────────────────────

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate cluster output meets quality bar */
export function validateClusterOutput(cluster: FailureCluster): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Hard checks
  if (cluster.size <= 0) errors.push("cluster size must be > 0");
  if (cluster.trace_ids.length !== cluster.size) {
    errors.push(`size (${cluster.size}) != trace_ids count (${cluster.trace_ids.length})`);
  }
  if (!cluster.fingerprint) errors.push("fingerprint must not be empty");
  if (!cluster.cluster_id) errors.push("cluster_id must not be empty");

  // Duplicate trace_ids
  const uniqueIds = new Set(cluster.trace_ids);
  if (uniqueIds.size !== cluster.trace_ids.length) {
    errors.push(`${cluster.trace_ids.length - uniqueIds.size} duplicate trace_ids found`);
  }

  // Hypothesis confidence ranges
  for (const h of cluster.root_cause_hypotheses) {
    if (h.confidence < 0 || h.confidence > 1) {
      errors.push(`hypothesis "${h.cause}" confidence ${h.confidence} out of [0,1]`);
    }
    if (h.evidence.length === 0) {
      warnings.push(`hypothesis "${h.cause}" has no evidence`);
    }
  }

  // Priority range
  if (cluster.priority_score < 0 || cluster.priority_score > 1) {
    errors.push(`priority_score ${cluster.priority_score} out of [0,1]`);
  }

  // Soft checks
  if (cluster.symptoms.length === 0) {
    warnings.push("cluster has no symptoms — analysis may be incomplete");
  }
  if (cluster.root_cause_hypotheses.length === 0) {
    warnings.push("no root cause hypotheses — heuristics may not have matched");
  }
  if (cluster.representative_trace_ids.length === 0) {
    warnings.push("no representative traces selected");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate fix plan output */
export function validateFixPlanOutput(plan: FixPlan): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan.target_id) errors.push("target_id must not be empty");
  if (!plan.summary) errors.push("summary must not be empty");
  if (plan.actions.length === 0) errors.push("fix plan must have at least one action");

  // Priority sequence check
  for (let i = 0; i < plan.actions.length; i++) {
    if (plan.actions[i].priority !== i + 1) {
      errors.push(`action priorities not sequential at index ${i}`);
      break;
    }
  }

  // Action completeness
  for (const a of plan.actions) {
    if (!a.action) errors.push(`action at priority ${a.priority} has empty action text`);
    if (!a.owner) warnings.push(`action at priority ${a.priority} has no owner`);
  }

  if (plan.experiment_plan.length === 0) {
    warnings.push("no experiment plan — fix may be hard to validate");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate issue draft output */
export function validateIssueDraft(draft: {
  issue_title: string;
  issue_body_markdown: string;
}): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!draft.issue_title || draft.issue_title.length < 10) {
    errors.push("issue title too short or empty");
  }
  if (draft.issue_title.length > 200) {
    warnings.push("issue title is very long — consider shortening");
  }
  if (!draft.issue_body_markdown || draft.issue_body_markdown.length < 100) {
    errors.push("issue body too short — likely incomplete");
  }

  // Check required sections
  const requiredSections = ["Summary", "Impact", "Evidence"];
  for (const section of requiredSections) {
    if (!draft.issue_body_markdown.includes(`## ${section}`)) {
      errors.push(`missing required section: ## ${section}`);
    }
  }

  const optionalSections = ["Recommended Actions", "Done Criteria"];
  for (const section of optionalSections) {
    if (!draft.issue_body_markdown.includes(`## ${section}`)) {
      warnings.push(`missing optional section: ## ${section}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Enhanced Analysis Guardrails ──────────────────────────────

import type { RegressionReport } from "../diagnosis/regression.js";
import type { ChainAnalysisReport } from "../diagnosis/chainAnalysis.js";
import type { CostQualityReport } from "../diagnosis/costQuality.js";
import type { RecurrenceReport } from "../diagnosis/recurrence.js";

/** Validate regression report output */
export function validateRegressionOutput(report: RegressionReport): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const r of report.regressions) {
    if (r.p_value < 0 || r.p_value > 1) errors.push(`${r.metric}: p_value ${r.p_value} out of [0,1]`);
    if (!isFinite(r.effect_size)) errors.push(`${r.metric}: effect_size is not finite`);
    if (r.sample_sizes.baseline < 5 || r.sample_sizes.current < 5) {
      warnings.push(`${r.metric}: 샘플 크기 부족 (baseline=${r.sample_sizes.baseline}, current=${r.sample_sizes.current})`);
    }
  }

  if (report.regressions.length === 0) {
    warnings.push("비교 가능한 지표가 없음 — 샘플 부족 가능성");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate chain analysis report output */
export function validateChainAnalysisOutput(report: ChainAnalysisReport): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (report.chain_health < 0 || report.chain_health > 1) {
    errors.push(`chain_health ${report.chain_health} out of [0,1]`);
  }
  if (report.total_steps !== report.steps.length) {
    errors.push(`total_steps (${report.total_steps}) != steps.length (${report.steps.length})`);
  }

  const pctSum = report.steps.reduce((s, step) => s + step.duration_pct, 0);
  if (report.steps.length > 0 && Math.abs(pctSum - 100) > 5) {
    warnings.push(`duration_pct 합계 ${pctSum.toFixed(1)}% — 100%와 차이 큼 (병렬 실행 가능성)`);
  }

  if (report.steps.length === 0) {
    warnings.push("observation이 없습니다");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate cost-quality report output */
export function validateCostQualityOutput(report: CostQualityReport): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (report.models.length === 0) {
    errors.push("분석할 모델이 없음");
  }

  for (const m of report.models) {
    if (m.cost_efficiency < 0) errors.push(`${m.model_name}: cost_efficiency < 0`);
    if (m.trace_count === 0) errors.push(`${m.model_name}: trace_count = 0`);
  }

  if (report.warnings.length > 0) {
    warnings.push(...report.warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate recurrence report output */
export function validateRecurrenceOutput(report: RecurrenceReport): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (report.recurrence_rate < 0 || report.recurrence_rate > 1) {
    errors.push(`recurrence_rate ${report.recurrence_rate} out of [0,1]`);
  }

  for (const adj of report.priority_adjustments) {
    if (adj.boost < 0) errors.push(`${adj.cluster_id}: priority boost < 0`);
  }

  if (report.recurrence_rate > 0.5) {
    warnings.push(`재발률 ${(report.recurrence_rate * 100).toFixed(0)}% — 이전 수정이 근본 원인을 해결하지 못했을 가능성`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Phase 2: Write Operation Guardrails ───────────────────────

import type { PromptFixContext } from "../actions/promptFix.js";
import type { EvalDatasetResult } from "../actions/evalRunner.js";
import type { AutofixReport } from "../actions/autofix.js";

/** Validate prompt fix context */
export function validatePromptFixContext(ctx: PromptFixContext): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!ctx.current_prompt.name) errors.push("prompt name is empty");
  if (ctx.suggested_changes.length === 0) {
    warnings.push("수정 제안이 없음 — 프롬프트 문제가 아닐 수 있습니다");
  }
  if (ctx.diagnosis.root_causes.length === 0) {
    warnings.push("원인 가설이 없음 — 진단 데이터 부족");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate eval dataset creation result */
export function validateEvalDatasetResult(result: EvalDatasetResult): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!result.dataset_name) errors.push("dataset name is empty");
  if (result.item_count === 0) {
    warnings.push("데이터셋에 항목이 없음 — trace에서 input/output 추출 실패 가능성");
  }
  if (result.item_count !== result.items.length) {
    errors.push(`item_count (${result.item_count}) != items.length (${result.items.length})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate autofix report */
export function validateAutofixReport(report: AutofixReport): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (report.trace_count === 0) {
    warnings.push("분석할 trace가 없음");
  }
  if (report.clusters.length === 0 && report.trace_count > 0) {
    warnings.push("실패 클러스터가 생성되지 않음 — 모든 trace가 정상이거나 클러스터링 기준 미달");
  }
  if (!report.summary) errors.push("summary is empty");
  if (report.next_steps.length === 0) errors.push("next_steps is empty");

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Wrap a tool handler with guardrail validation.
 * If validation fails, the error is logged and returned to the user,
 * rather than silently passing bad data through.
 */
export function withGuardrail<T>(
  name: string,
  validator: (result: T) => GuardrailResult,
  result: T,
): T {
  const check = validator(result);

  if (check.warnings.length > 0) {
    logger.warn(
      { tool: name, warnings: check.warnings },
      "Guardrail warnings on output",
    );
  }

  if (!check.valid) {
    logger.error(
      { tool: name, errors: check.errors },
      "Guardrail validation failed",
    );
    throw new Error(
      `Output validation failed for ${name}: ${check.errors.join("; ")}`,
    );
  }

  return result;
}
