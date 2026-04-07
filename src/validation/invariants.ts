/**
 * Domain Invariant Checks
 *
 * 비즈니스 규칙을 코드로 강제한다.
 * 문서가 아닌 코드로 제약을 걸어야 에이전트가 이탈하지 않는다.
 */
import type { FailureCluster, FixPlan, NormalizedTrace } from "../types.js";
import { logger } from "../utils/logger.js";

export class InvariantViolation extends Error {
  constructor(
    public readonly rule: string,
    message: string,
  ) {
    super(`[Invariant: ${rule}] ${message}`);
    this.name = "InvariantViolation";
  }
}

/** Cluster must have at least 1 trace */
export function assertClusterNotEmpty(cluster: FailureCluster): void {
  if (cluster.size === 0 || cluster.trace_ids.length === 0) {
    throw new InvariantViolation(
      "CLUSTER_NOT_EMPTY",
      `Cluster ${cluster.cluster_id} has no traces`,
    );
  }
}

/** Cluster size must match trace_ids length */
export function assertClusterSizeConsistent(cluster: FailureCluster): void {
  if (cluster.size !== cluster.trace_ids.length) {
    throw new InvariantViolation(
      "CLUSTER_SIZE_CONSISTENT",
      `Cluster ${cluster.cluster_id}: size=${cluster.size} but trace_ids.length=${cluster.trace_ids.length}`,
    );
  }
}

/** Confidence must be between 0 and 1 */
export function assertConfidenceRange(cluster: FailureCluster): void {
  for (const h of cluster.root_cause_hypotheses) {
    if (h.confidence < 0 || h.confidence > 1) {
      throw new InvariantViolation(
        "CONFIDENCE_RANGE",
        `Hypothesis ${h.cause}: confidence=${h.confidence} out of [0,1]`,
      );
    }
  }
}

/** Priority score must be between 0 and 1 */
export function assertPriorityRange(cluster: FailureCluster): void {
  if (cluster.priority_score < 0 || cluster.priority_score > 1) {
    throw new InvariantViolation(
      "PRIORITY_RANGE",
      `Cluster ${cluster.cluster_id}: priority_score=${cluster.priority_score} out of [0,1]`,
    );
  }
}

/** Fix plan actions must have sequential priorities */
export function assertActionPrioritiesSequential(plan: FixPlan): void {
  for (let i = 0; i < plan.actions.length; i++) {
    if (plan.actions[i].priority !== i + 1) {
      throw new InvariantViolation(
        "ACTION_PRIORITIES_SEQUENTIAL",
        `Action at index ${i} has priority=${plan.actions[i].priority}, expected ${i + 1}`,
      );
    }
  }
}

/** Latency cannot be negative */
export function assertLatencyNonNegative(trace: NormalizedTrace): void {
  if (trace.latency_ms < 0) {
    throw new InvariantViolation(
      "LATENCY_NON_NEGATIVE",
      `Trace ${trace.trace_id}: latency_ms=${trace.latency_ms}`,
    );
  }
}

/** Run all cluster invariants */
export function validateClusterInvariants(cluster: FailureCluster): void {
  assertClusterNotEmpty(cluster);
  assertClusterSizeConsistent(cluster);
  assertConfidenceRange(cluster);
  assertPriorityRange(cluster);
}

/** Run all fix plan invariants */
export function validateFixPlanInvariants(plan: FixPlan): void {
  assertActionPrioritiesSequential(plan);
}

/** Soft validation — logs warnings instead of throwing */
export function warnOnAnomalies(traces: NormalizedTrace[]): void {
  for (const t of traces) {
    if (t.latency_ms > 30000) {
      logger.warn(
        { trace_id: t.trace_id, latency_ms: t.latency_ms },
        "Unusually high latency — possible data quality issue",
      );
    }
    if (t.cost_usd > 1.0) {
      logger.warn(
        { trace_id: t.trace_id, cost_usd: t.cost_usd },
        "Unusually high cost per trace",
      );
    }
    if (Object.keys(t.scores).length === 0 && t.status === "ok") {
      logger.warn(
        { trace_id: t.trace_id },
        "Trace marked OK but has no scores — evaluation may be missing",
      );
    }
  }
}
