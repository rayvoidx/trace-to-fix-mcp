import type { NormalizedTrace, FailureCluster, FixPlan } from "../../src/types.js";

export const sampleTrace: NormalizedTrace = {
  trace_id: "trace-001",
  project: "test-project",
  environment: "prod",
  trace_name: "qa-chat",
  start_time: "2026-04-07T00:00:00Z",
  latency_ms: 6200,
  status: "error",
  model_name: "gpt-4o",
  prompt_version: "v2.1",
  route: "/api/chat",
  service: "chat-service",
  scores: { correctness: 0.45, faithfulness: 0.6, context_relevance: 0.3 },
  usage: { input_tokens: 3200, output_tokens: 800, total_tokens: 4000 },
  cost_usd: 0.08,
  retrieval: { count: 0, top_k: 5, hit_signals: [] },
  errors: [
    { kind: "retrieval_miss", message: "retrieval_count=0" },
    { kind: "hallucination", message: "correctness=0.45" },
  ],
  metadata: { service: "chat-service", route: "/api/chat" },
};

export const sampleTrace2: NormalizedTrace = {
  ...sampleTrace,
  trace_id: "trace-002",
  latency_ms: 7100,
  scores: { correctness: 0.42, faithfulness: 0.55, context_relevance: 0.28 },
};

export const sampleTrace3: NormalizedTrace = {
  ...sampleTrace,
  trace_id: "trace-003",
  latency_ms: 5800,
  scores: { correctness: 0.5, faithfulness: 0.58, context_relevance: 0.35 },
};

export const sampleCluster: FailureCluster = {
  cluster_id: "cluster-001",
  fingerprint: "qa-chat|/api/chat|v2.1|retrieval_miss|very_low|retrieval_miss",
  size: 3,
  trace_ids: ["trace-001", "trace-002", "trace-003"],
  symptoms: ["correctness<0.7", "faithfulness<0.75", "context_relevance<0.65", "retrieval_miss", "high_latency", "error"],
  feature_summary: {
    avg_latency_ms: 6366,
    avg_correctness: 0.456,
    avg_faithfulness: 0.576,
    trace_name: "qa-chat",
    route: "/api/chat",
    prompt_version: "v2.1",
  },
  root_cause_hypotheses: [
    { cause: "retrieval_quality_issue", confidence: 0.9, evidence: ["avg context_relevance=0.31", "retrieval_miss_rate=100%"] },
    { cause: "answer_grounding_issue", confidence: 0.75, evidence: ["avg faithfulness=0.58 (low)"] },
  ],
  priority_score: 0.85,
  representative_trace_ids: ["trace-001", "trace-002", "trace-003"],
};

export const sampleFixPlan: FixPlan = {
  target_id: "cluster-001",
  target_type: "cluster",
  summary: "qa-chat / route=/api/chat / symptoms: correctness<0.7, retrieval_miss / 3건 발생",
  hypotheses: sampleCluster.root_cause_hypotheses,
  actions: [
    { priority: 1, owner: "backend_or_retrieval", action: "retrieval filter 완화 및 reranker cutoff 재검토", expected_impact: "correctness +0.08~0.15" },
    { priority: 2, owner: "prompt_owner", action: "answer grounding 규칙 강화 — 출처 인용 필수화", expected_impact: "faithfulness +0.10~0.15" },
  ],
  experiment_plan: ["baseline dataset 3건 추출", "retrieval cutoff A/B 실험", "prompt v(current) vs v(next) offline eval", "성공 기준 달성 여부 확인 후 배포 결정"],
  owner_suggestions: ["backend_or_retrieval", "prompt_owner"],
};

/** Langfuse API 응답 형태의 raw trace 데이터 */
export const rawLangfuseTraceResponse = {
  data: [
    {
      id: "trace-raw-001",
      name: "qa-chat",
      input: { question: "test" },
      output: { answer: "test answer" },
      metadata: { service: "chat-service", route: "/api/chat" },
      startTime: "2026-04-07T00:00:00Z",
      endTime: "2026-04-07T00:00:06Z",
      latency: 6.2,
      level: "ERROR",
      statusMessage: "retrieval failed",
      release: "v1.0.0",
      version: "1",
      scores: { correctness: 0.45, faithfulness: 0.6 },
      totalCost: 0.08,
      usage: { input: 3200, output: 800, total: 4000 },
      tags: ["failure"],
    },
  ],
  meta: { totalItems: 1, page: 1, totalPages: 1 },
};
