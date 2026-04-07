// ─── Internal Data Models ─────────────────────────────────────────

export interface NormalizedTrace {
  trace_id: string;
  project: string;
  environment: string;
  trace_name: string;
  start_time: string;
  latency_ms: number;
  status: "ok" | "error" | "degraded";
  model_name: string | null;
  prompt_version: string | null;
  route: string | null;
  service: string | null;
  scores: Record<string, number>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
  retrieval: {
    count: number;
    top_k: number;
    hit_signals: string[];
  };
  errors: TraceError[];
  metadata: Record<string, string>;
}

export interface TraceError {
  kind:
    | "timeout"
    | "validation"
    | "hallucination"
    | "retrieval_miss"
    | "tool_error"
    | "unknown";
  message: string;
}

export interface FailureCluster {
  cluster_id: string;
  fingerprint: string;
  size: number;
  trace_ids: string[];
  symptoms: string[];
  feature_summary: Record<string, unknown>;
  root_cause_hypotheses: RootCauseHypothesis[];
  priority_score: number;
  representative_trace_ids: string[];
}

export interface RootCauseHypothesis {
  cause: string;
  confidence: number;
  evidence: string[];
}

export interface FixPlan {
  target_id: string;
  target_type: "trace" | "cluster";
  summary: string;
  hypotheses: RootCauseHypothesis[];
  actions: RecommendedAction[];
  experiment_plan: string[];
  owner_suggestions: string[];
}

export interface RecommendedAction {
  priority: number;
  owner: string;
  action: string;
  expected_impact: string;
}

// ─── Tool Input Types ─────────────────────────────────────────────

export interface ListFailingTracesInput {
  project?: string;
  environment?: string;
  time_from: string;
  time_to: string;
  filters?: {
    trace_name?: string[];
    metadata?: Record<string, string>;
    score_thresholds?: Record<string, number>;
    latency_ms_gt?: number;
    status?: string[];
  };
  limit?: number;
}

export interface GetTraceBundleInput {
  trace_id: string;
  include_observations?: boolean;
  include_scores?: boolean;
  include_prompt_refs?: boolean;
  include_usage_cost?: boolean;
}

export interface GroupFailurePatternsInput {
  trace_ids: string[];
  group_by?: string[];
  max_clusters?: number;
}

export interface SuggestFixPlanInput {
  target_type: "cluster" | "trace";
  target_id: string;
  strategy?: "conservative" | "aggressive";
  include_experiment_plan?: boolean;
}

export interface CreateIssueDraftInput {
  repo: string;
  cluster_id: string;
  title_prefix?: string;
  labels?: string[];
  assignees?: string[];
  dry_run?: boolean;
}

// ─── Config Types ─────────────────────────────────────────────────

export interface PlaybookConfig {
  thresholds: {
    correctness_low: number;
    faithfulness_low: number;
    context_relevance_low: number;
    latency_high_ms: number;
  };
  heuristics: HeuristicRule[];
}

export interface HeuristicRule {
  id: string;
  when: Record<string, number>;
  action: string[];
}
