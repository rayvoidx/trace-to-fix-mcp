/**
 * 하네스 엔지니어링 4대 원칙 통합 검증 테스트
 *
 * 1. 아키텍처 제약: Zod 스키마 검증이 잘못된 데이터를 차단하는가
 * 2. 피드백 루프: telemetry, circuit breaker가 동작하는가
 * 3. 검증 가드레일: Generator 출력을 Evaluator가 검증하는가
 * 4. 지속적 문서화: 설정 파일 로딩이 정상 동작하는가
 */
import { describe, it, expect } from "vitest";

// ─── Fixtures ──────────────────────────────────────────────────
import {
  sampleTrace, sampleTrace2, sampleTrace3,
  sampleCluster, sampleFixPlan,
  rawLangfuseTraceResponse,
} from "../fixtures/traces.js";

// ─── 1. 아키텍처 제약 ──────────────────────────────────────────
import {
  LfTraceListResponseSchema,
  LfTraceSchema,
  LfObservationSchema,
  LfScoreSchema,
  NormalizedTraceSchema,
  FailureClusterSchema,
  FixPlanSchema,
  assertValidCluster,
  assertValidTrace,
  assertValidFixPlan,
} from "../../src/validation/schemas.js";

// ─── 2. 피드백 루프 ────────────────────────────────────────────
import { telemetry } from "../../src/observability/telemetry.js";
import { circuitBreaker } from "../../src/validation/guardrails.js";

// ─── 3. 검증 가드레일 ──────────────────────────────────────────
import {
  validateClusterOutput,
  validateFixPlanOutput,
  validateIssueDraft,
  withGuardrail,
} from "../../src/validation/guardrails.js";
import {
  validateClusterInvariants,
  validateFixPlanInvariants,
  warnOnAnomalies,
  InvariantViolation,
} from "../../src/validation/invariants.js";

// ─── 4. 지속적 문서화 ──────────────────────────────────────────
import { loadPlaybookConfig } from "../../src/server/config.js";

// ─── 핵심 분석 로직 ────────────────────────────────────────────
import { clusterTraces, buildFingerprint } from "../../src/diagnosis/clustering.js";
import { applyHeuristics } from "../../src/diagnosis/heuristics.js";
import { generateFixPlan } from "../../src/diagnosis/fixPlan.js";
import { rankClusters } from "../../src/diagnosis/priority.js";
import { tagCandidateReasons } from "../../src/diagnosis/candidate.js";
import { filterCandidates } from "../../src/diagnosis/normalize.js";
import { renderIssueBody } from "../../src/adapters/github/issues.js";

// ════════════════════════════════════════════════════════════════
// 기둥 1: 아키텍처 제약 — Zod 스키마가 경계를 지키는가
// ════════════════════════════════════════════════════════════════

describe("기둥 1: 아키텍처 제약", () => {
  describe("Zod 스키마 — 정상 데이터 통과", () => {
    it("Langfuse trace list 응답이 스키마를 통과한다", () => {
      const result = LfTraceListResponseSchema.parse(rawLangfuseTraceResponse);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("trace-raw-001");
      expect(result.meta.totalItems).toBe(1);
    });

    it("NormalizedTrace가 스키마를 통과한다", () => {
      const result = assertValidTrace(sampleTrace);
      expect(result.trace_id).toBe("trace-001");
    });

    it("FailureCluster가 스키마를 통과한다", () => {
      const result = assertValidCluster(sampleCluster);
      expect(result.cluster_id).toBe("cluster-001");
    });

    it("FixPlan이 스키마를 통과한다", () => {
      const result = assertValidFixPlan(sampleFixPlan);
      expect(result.target_id).toBe("cluster-001");
    });
  });

  describe("Zod 스키마 — 잘못된 데이터 차단", () => {
    it("빈 trace_id를 차단한다", () => {
      expect(() => NormalizedTraceSchema.parse({ ...sampleTrace, trace_id: "" }))
        .toThrow();
    });

    it("잘못된 status enum을 차단한다", () => {
      expect(() => NormalizedTraceSchema.parse({ ...sampleTrace, status: "invalid" }))
        .toThrow();
    });

    it("음수 latency를 차단한다", () => {
      expect(() => NormalizedTraceSchema.parse({ ...sampleTrace, latency_ms: -100 }))
        .toThrow();
    });

    it("빈 cluster_id를 차단한다", () => {
      expect(() => FailureClusterSchema.parse({ ...sampleCluster, cluster_id: "" }))
        .toThrow();
    });

    it("범위 밖 confidence를 차단한다", () => {
      const bad = {
        ...sampleCluster,
        root_cause_hypotheses: [{ cause: "test", confidence: 1.5, evidence: [] }],
      };
      expect(() => FailureClusterSchema.parse(bad)).toThrow();
    });

    it("Langfuse 응답에 data 필드가 없으면 차단한다", () => {
      expect(() => LfTraceListResponseSchema.parse({ meta: {} })).toThrow();
    });

    it("Langfuse 응답에 meta 필드가 없으면 차단한다", () => {
      expect(() => LfTraceListResponseSchema.parse({ data: [] })).toThrow();
    });
  });

  describe("모듈 의존 방향 — adapters → diagnosis → server", () => {
    it("clustering이 adapter를 직접 import하지 않는다 (단방향 의존)", async () => {
      // clustering.ts의 import 목록에 adapters가 없어야 한다
      const fs = await import("node:fs");
      const content = fs.readFileSync("src/diagnosis/clustering.ts", "utf-8");
      expect(content).not.toContain("from \"../adapters/");
    });

    it("heuristics가 adapter를 직접 import하지 않는다", async () => {
      const fs = await import("node:fs");
      const content = fs.readFileSync("src/diagnosis/heuristics.ts", "utf-8");
      expect(content).not.toContain("from \"../adapters/");
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 기둥 2: 피드백 루프 — 관찰 가능성과 자동 차단
// ════════════════════════════════════════════════════════════════

describe("기둥 2: 피드백 루프", () => {
  describe("Telemetry — 도구 호출 기록", () => {
    it("성공 호출을 기록한다", () => {
      telemetry.record({
        tool: "test_tool",
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        success: true,
      });

      const recent = telemetry.getRecentInvocations(1);
      expect(recent).toHaveLength(1);
      expect(recent[0].tool).toBe("test_tool");
      expect(recent[0].success).toBe(true);
    });

    it("실패 호출을 기록한다", () => {
      telemetry.record({
        tool: "test_tool_fail",
        startedAt: Date.now() - 200,
        endedAt: Date.now(),
        success: false,
        error: "test error",
      });

      const metrics = telemetry.getMetrics();
      expect(metrics.total_invocations).toBeGreaterThan(0);
      expect(metrics.tools["test_tool_fail"]).toBeDefined();
      expect(metrics.tools["test_tool_fail"].failure_rate).toBe(1);
    });

    it("메트릭 집계가 정확하다", () => {
      const metrics = telemetry.getMetrics();
      expect(metrics.period).toBe("last_24h");
      expect(metrics.total_failures).toBeGreaterThan(0);
      expect(metrics.tools["test_tool"]?.total_calls).toBeGreaterThan(0);
    });
  });

  describe("Circuit Breaker — 반복 실패 차단", () => {
    it("첫 실패는 통과시킨다", () => {
      circuitBreaker.recordFailure("cb_test", "error 1");
      expect(() => circuitBreaker.check("cb_test")).not.toThrow();
    });

    it("3회 반복 실패 후 차단한다", () => {
      circuitBreaker.recordFailure("cb_test", "error 2");
      circuitBreaker.recordFailure("cb_test", "error 3");
      expect(() => circuitBreaker.check("cb_test")).toThrow(/Circuit breaker open/);
    });

    it("성공 기록 후 차단을 해제한다", () => {
      circuitBreaker.recordSuccess("cb_test");
      expect(() => circuitBreaker.check("cb_test")).not.toThrow();
    });

    it("상태 조회가 가능하다", () => {
      circuitBreaker.recordFailure("cb_status_test", "err");
      const status = circuitBreaker.getStatus();
      expect(status["cb_status_test"]).toBeDefined();
      expect(status["cb_status_test"].count).toBe(1);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 기둥 3: 검증 가드레일 — Generator/Evaluator 분리
// ════════════════════════════════════════════════════════════════

describe("기둥 3: 검증 가드레일", () => {
  describe("Invariants — 도메인 불변조건", () => {
    it("정상 클러스터의 불변조건을 통과한다", () => {
      expect(() => validateClusterInvariants(sampleCluster)).not.toThrow();
    });

    it("size와 trace_ids가 불일치하면 InvariantViolation", () => {
      const bad = { ...sampleCluster, size: 999 };
      expect(() => validateClusterInvariants(bad)).toThrow(InvariantViolation);
    });

    it("빈 클러스터는 InvariantViolation", () => {
      const bad = { ...sampleCluster, size: 0, trace_ids: [] };
      expect(() => validateClusterInvariants(bad)).toThrow(InvariantViolation);
    });

    it("범위 밖 confidence는 InvariantViolation", () => {
      const bad = {
        ...sampleCluster,
        root_cause_hypotheses: [{ cause: "test", confidence: -0.1, evidence: [] }],
      };
      expect(() => validateClusterInvariants(bad)).toThrow(InvariantViolation);
    });

    it("범위 밖 priority_score는 InvariantViolation", () => {
      const bad = { ...sampleCluster, priority_score: 1.5 };
      expect(() => validateClusterInvariants(bad)).toThrow(InvariantViolation);
    });

    it("정상 fix plan의 불변조건을 통과한다", () => {
      expect(() => validateFixPlanInvariants(sampleFixPlan)).not.toThrow();
    });

    it("비순차적 priority는 InvariantViolation", () => {
      const bad = {
        ...sampleFixPlan,
        actions: [
          { priority: 1, owner: "a", action: "x", expected_impact: "y" },
          { priority: 5, owner: "b", action: "z", expected_impact: "w" },
        ],
      };
      expect(() => validateFixPlanInvariants(bad)).toThrow(InvariantViolation);
    });

    it("warnOnAnomalies는 예외를 던지지 않고 경고만 한다", () => {
      const highLatency = { ...sampleTrace, latency_ms: 50000, cost_usd: 2.0 };
      expect(() => warnOnAnomalies([highLatency])).not.toThrow();
    });
  });

  describe("Guardrails — 출력 품질 검증", () => {
    it("정상 클러스터 출력이 valid", () => {
      const result = validateClusterOutput(sampleCluster);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("중복 trace_id가 있으면 error", () => {
      const bad = { ...sampleCluster, trace_ids: ["a", "a", "b"], size: 3 };
      const result = validateClusterOutput(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
    });

    it("정상 fix plan 출력이 valid", () => {
      const result = validateFixPlanOutput(sampleFixPlan);
      expect(result.valid).toBe(true);
    });

    it("빈 actions는 error", () => {
      const bad = { ...sampleFixPlan, actions: [] };
      const result = validateFixPlanOutput(bad);
      expect(result.valid).toBe(false);
    });

    it("정상 이슈 초안 출력이 valid", () => {
      const body = renderIssueBody(sampleCluster, sampleFixPlan);
      const result = validateIssueDraft({ issue_title: "[Trace-to-Fix] qa-chat failure cluster", issue_body_markdown: body });
      expect(result.valid).toBe(true);
    });

    it("필수 섹션 누락 시 error", () => {
      const result = validateIssueDraft({
        issue_title: "[Trace-to-Fix] test",
        issue_body_markdown: "짧은 본문",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Summary"))).toBe(true);
    });

    it("withGuardrail이 정상 데이터를 통과시킨다", () => {
      const result = withGuardrail("test", validateClusterOutput, sampleCluster);
      expect(result).toBe(sampleCluster);
    });

    it("withGuardrail이 잘못된 데이터에 throw한다", () => {
      const bad = { ...sampleCluster, size: 0, trace_ids: [] };
      expect(() => withGuardrail("test", validateClusterOutput, bad)).toThrow(/validation failed/);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 기둥 4: 지속적 문서화 — 설정 파일 로딩
// ════════════════════════════════════════════════════════════════

describe("기둥 4: 지속적 문서화", () => {
  it("playbook config가 정상 로딩된다", () => {
    const config = loadPlaybookConfig();
    expect(config.thresholds).toBeDefined();
    expect(config.thresholds.correctness_low).toBe(0.7);
    expect(config.thresholds.faithfulness_low).toBe(0.75);
    expect(config.thresholds.context_relevance_low).toBe(0.65);
    expect(config.thresholds.latency_high_ms).toBe(5000);
  });

  it("heuristic rules이 로딩된다", () => {
    const config = loadPlaybookConfig();
    expect(config.heuristics.length).toBeGreaterThan(0);
    expect(config.heuristics[0].id).toBe("retrieval_quality_issue");
  });
});

// ════════════════════════════════════════════════════════════════
// End-to-end 파이프라인: 전체 흐름 통합 검증
// ════════════════════════════════════════════════════════════════

describe("E2E: 전체 파이프라인 통합 검증", () => {
  const traces = [sampleTrace, sampleTrace2, sampleTrace3];

  it("1단계: 후보 태깅 → 필터링", () => {
    const config = loadPlaybookConfig();
    const candidates = filterCandidates(traces, config);
    expect(candidates.length).toBeGreaterThan(0);

    const tagged = tagCandidateReasons(candidates, config.thresholds);
    expect(tagged.every((t) => t.candidate_reasons.length > 0)).toBe(true);
    expect(tagged[0].candidate_reasons).toContain("low_correctness");
    expect(tagged[0].candidate_reasons).toContain("retrieval_miss");
  });

  it("2단계: 클러스터링 → 불변조건 검증 → 가드레일 통과", () => {
    const config = loadPlaybookConfig();
    const clusters = clusterTraces(traces, config);
    expect(clusters.length).toBeGreaterThan(0);

    const ranked = rankClusters(clusters, { totalTraces: traces.length, prodEnvironment: true });

    for (const c of ranked) {
      // 불변조건 검증
      validateClusterInvariants(c);
      // 가드레일 검증
      const check = validateClusterOutput(c);
      expect(check.valid).toBe(true);
    }
  });

  it("3단계: 휴리스틱 적용 → 원인 가설 생성", () => {
    const config = loadPlaybookConfig();
    const hypotheses = applyHeuristics(traces, config);
    expect(hypotheses.length).toBeGreaterThan(0);

    // retrieval 문제가 감지되어야 함
    const retrievalHyp = hypotheses.find((h) => h.cause === "retrieval_quality_issue");
    expect(retrievalHyp).toBeDefined();
    expect(retrievalHyp!.confidence).toBeGreaterThan(0.5);
  });

  it("4단계: Fix Plan 생성 → 불변조건 검증 → 가드레일 통과", () => {
    const config = loadPlaybookConfig();
    const clusters = clusterTraces(traces, config);
    const ranked = rankClusters(clusters, { totalTraces: traces.length, prodEnvironment: true });

    const plan = generateFixPlan(ranked[0], "conservative", true);

    // 불변조건
    validateFixPlanInvariants(plan);

    // 가드레일
    const check = validateFixPlanOutput(plan);
    expect(check.valid).toBe(true);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.experiment_plan.length).toBeGreaterThan(0);
  });

  it("5단계: 이슈 초안 생성 → 가드레일 통과", () => {
    const config = loadPlaybookConfig();
    const clusters = clusterTraces(traces, config);
    const ranked = rankClusters(clusters, { totalTraces: traces.length, prodEnvironment: true });
    const plan = generateFixPlan(ranked[0], "conservative", true);

    const body = renderIssueBody(ranked[0], plan);
    const draft = { issue_title: "[Trace-to-Fix] qa-chat failure", issue_body_markdown: body };

    const check = validateIssueDraft(draft);
    expect(check.valid).toBe(true);

    // 필수 섹션 존재 확인
    expect(body).toContain("## Summary");
    expect(body).toContain("## Impact");
    expect(body).toContain("## Evidence");
    expect(body).toContain("## Recommended Actions");
    expect(body).toContain("## Done Criteria");
  });

  it("전체 파이프라인에서 fingerprint가 일관적이다", () => {
    const fp1 = buildFingerprint(sampleTrace);
    const fp2 = buildFingerprint(sampleTrace2);
    // 같은 패턴의 trace는 같은 fingerprint
    expect(fp1).toBe(fp2);
  });
});
