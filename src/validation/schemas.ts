/**
 * Architecture Constraint Layer
 *
 * 모든 외부 입출력 경계에서 Zod 스키마로 데이터 구조를 강제한다.
 * 에이전트나 외부 API가 잘못된 구조의 데이터를 보내도
 * 시스템 내부로 진입하지 못하게 차단하는 첫 번째 가드레일이다.
 */
import { z } from "zod";

// ─── Langfuse API Response Schemas ──────────────────────────────

export const LfTraceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.unknown()).nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  latency: z.number().nullable(),
  level: z.string(),
  statusMessage: z.string().nullable(),
  release: z.string().nullable(),
  version: z.string().nullable(),
  scores: z.record(z.number()).nullable(),
  totalCost: z.number().nullable(),
  usage: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .nullable(),
  tags: z.array(z.string()).default([]),
});

export const LfTraceListResponseSchema = z.object({
  data: z.array(LfTraceSchema),
  meta: z.object({
    totalItems: z.number(),
    page: z.number(),
    totalPages: z.number(),
  }),
});

export const LfObservationSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  type: z.string(),
  name: z.string().nullable(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.unknown()).nullable(),
  level: z.string(),
  statusMessage: z.string().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  calculatedTotalCost: z.number().nullable(),
});

export const LfScoreSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  observationId: z.string().nullable(),
  name: z.string(),
  value: z.number(),
  dataType: z.string(),
  comment: z.string().nullable(),
  source: z.string(),
});

// ─── Internal Domain Schemas ────────────────────────────────────

export const NormalizedTraceSchema = z.object({
  trace_id: z.string().min(1),
  project: z.string(),
  environment: z.string(),
  trace_name: z.string(),
  start_time: z.string(),
  latency_ms: z.number().min(0),
  status: z.enum(["ok", "error", "degraded"]),
  model_name: z.string().nullable(),
  prompt_version: z.string().nullable(),
  route: z.string().nullable(),
  service: z.string().nullable(),
  scores: z.record(z.number()),
  usage: z.object({
    input_tokens: z.number().min(0),
    output_tokens: z.number().min(0),
    total_tokens: z.number().min(0),
  }),
  cost_usd: z.number().min(0),
  retrieval: z.object({
    count: z.number().min(0),
    top_k: z.number().min(0),
    hit_signals: z.array(z.string()),
  }),
  errors: z.array(
    z.object({
      kind: z.enum([
        "timeout",
        "validation",
        "hallucination",
        "retrieval_miss",
        "tool_error",
        "unknown",
      ]),
      message: z.string(),
    }),
  ),
  metadata: z.record(z.string()),
});

export const FailureClusterSchema = z.object({
  cluster_id: z.string().min(1),
  fingerprint: z.string().min(1),
  size: z.number().int().min(1),
  trace_ids: z.array(z.string()).min(1),
  symptoms: z.array(z.string()),
  feature_summary: z.record(z.unknown()),
  root_cause_hypotheses: z.array(
    z.object({
      cause: z.string(),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()),
    }),
  ),
  priority_score: z.number().min(0).max(1),
  representative_trace_ids: z.array(z.string()),
});

export const FixPlanSchema = z.object({
  target_id: z.string(),
  target_type: z.enum(["trace", "cluster"]),
  summary: z.string(),
  hypotheses: z.array(
    z.object({
      cause: z.string(),
      confidence: z.number(),
      evidence: z.array(z.string()),
    }),
  ),
  actions: z.array(
    z.object({
      priority: z.number().int().min(1),
      owner: z.string(),
      action: z.string(),
      expected_impact: z.string(),
    }),
  ),
  experiment_plan: z.array(z.string()),
  owner_suggestions: z.array(z.string()),
});

// ─── Enhanced Analysis Schemas ─────────────────────────────────

export const MetricRegressionSchema = z.object({
  metric: z.string(),
  baseline_mean: z.number(),
  baseline_stddev: z.number(),
  current_mean: z.number(),
  current_stddev: z.number(),
  delta_pct: z.number(),
  effect_size: z.number(),
  p_value: z.number().min(0).max(1),
  severity: z.enum(["none", "minor", "major", "critical"]),
  direction: z.enum(["improved", "degraded", "unchanged"]),
  sample_sizes: z.object({
    baseline: z.number().int().min(0),
    current: z.number().int().min(0),
  }),
});

export const RegressionReportSchema = z.object({
  baseline_period: z.object({ from: z.string(), to: z.string() }),
  current_period: z.object({ from: z.string(), to: z.string() }),
  regressions: z.array(MetricRegressionSchema),
  top_regressions: z.array(MetricRegressionSchema),
  summary: z.string(),
  has_significant_regression: z.boolean(),
});

export const ChainAnalysisReportSchema = z.object({
  trace_id: z.string(),
  total_steps: z.number().int().min(0),
  total_duration_ms: z.number().min(0),
  steps: z.array(z.object({
    observation_id: z.string(),
    name: z.string(),
    type: z.string(),
    position: z.number().int().min(1),
    duration_ms: z.number().min(0),
    duration_pct: z.number().min(0),
    tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }),
    cost_usd: z.number().min(0),
    has_error: z.boolean(),
    error_message: z.string().nullable(),
    model: z.string().nullable(),
  })),
  bottleneck: z.object({
    step_name: z.string(),
    position: z.number(),
    reason: z.string(),
    contribution_pct: z.number(),
  }).nullable(),
  failure_points: z.array(z.object({
    step_name: z.string(),
    position: z.number(),
    error: z.string(),
  })),
  chain_health: z.number().min(0).max(1),
  recommendations: z.array(z.string()),
});

export const CostQualityReportSchema = z.object({
  models: z.array(z.object({
    model_name: z.string(),
    trace_count: z.number().int().min(0),
    avg_scores: z.record(z.number()),
    avg_latency_ms: z.number().min(0),
    avg_cost_usd: z.number().min(0),
    total_cost_usd: z.number().min(0),
    cost_efficiency: z.number().min(0),
    avg_tokens: z.object({ input: z.number(), output: z.number(), total: z.number() }),
  })),
  tradeoffs: z.array(z.object({
    from_model: z.string(),
    to_model: z.string(),
    cost_change_pct: z.number(),
    quality_changes: z.record(z.number()),
    latency_change_pct: z.number(),
    recommendation: z.enum(["switch", "keep", "investigate"]),
    rationale: z.string(),
  })),
  total_daily_cost_estimate: z.number().min(0),
  potential_savings: z.array(z.object({
    scenario: z.string(),
    savings_pct: z.number(),
    quality_impact: z.string(),
  })),
  summary: z.string(),
  warnings: z.array(z.string()),
});

export const RecurrenceReportSchema = z.object({
  recurrences: z.array(z.object({
    current_cluster_id: z.string(),
    historical_cluster_id: z.string(),
    fingerprint: z.string(),
    match_type: z.enum(["exact", "soft"]),
    historical_resolved_at: z.string(),
    days_since_resolution: z.number().int().min(0),
    severity_comparison: z.enum(["worse", "same", "milder"]),
  })),
  recurrence_rate: z.number().min(0).max(1),
  summary: z.string(),
  priority_adjustments: z.array(z.object({
    cluster_id: z.string(),
    boost: z.number().min(0),
    reason: z.string(),
  })),
});

// ─── Phase 2: Write Operation Schemas ──────────────────────────

export const PromptFixContextSchema = z.object({
  current_prompt: z.object({
    name: z.string().min(1),
    version: z.number().int().min(0),
    content: z.unknown(),
    type: z.enum(["text", "chat"]),
    config: z.record(z.unknown()),
  }),
  diagnosis: z.object({
    cluster_summary: z.string(),
    symptoms: z.array(z.string()),
    root_causes: z.array(z.string()),
    recommended_actions: z.array(z.string()),
  }),
  suggested_changes: z.array(z.string()),
});

export const EvalDatasetResultSchema = z.object({
  dataset_name: z.string().min(1),
  item_count: z.number().int().min(0),
  items: z.array(z.object({
    id: z.string(),
    datasetName: z.string(),
    input: z.unknown(),
    expectedOutput: z.unknown(),
    metadata: z.record(z.unknown()),
    sourceTraceId: z.string().nullable(),
    sourceObservationId: z.string().nullable(),
  })),
});

export const AutofixReportSchema = z.object({
  trace_count: z.number().int().min(0),
  baseline_trace_count: z.number().int().min(0),
  regression: RegressionReportSchema.nullable(),
  clusters: z.array(FailureClusterSchema),
  top_cluster: FailureClusterSchema.nullable(),
  chain_analysis: z.unknown().nullable(),
  cost_quality: CostQualityReportSchema.nullable(),
  fix_plan: FixPlanSchema.nullable(),
  prompt_fix_context: PromptFixContextSchema.nullable(),
  eval_dataset: EvalDatasetResultSchema.nullable(),
  summary: z.string(),
  next_steps: z.array(z.string()),
});

// ─── Domain Invariant Validators ────────────────────────────────

export function assertValidCluster(data: unknown): z.infer<typeof FailureClusterSchema> {
  return FailureClusterSchema.parse(data);
}

export function assertValidTrace(data: unknown): z.infer<typeof NormalizedTraceSchema> {
  return NormalizedTraceSchema.parse(data);
}

export function assertValidFixPlan(data: unknown): z.infer<typeof FixPlanSchema> {
  return FixPlanSchema.parse(data);
}
