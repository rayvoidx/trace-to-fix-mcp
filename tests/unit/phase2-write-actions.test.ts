/**
 * Phase 2: Write & Actions — 검증 테스트
 *
 * Langfuse 쓰기 API를 실제로 호출하지 않고,
 * actions 레이어의 로직과 guardrails를 검증한다.
 */
import { describe, it, expect } from "vitest";
import {
  sampleCluster, sampleFixPlan,
  sampleTrace, sampleTrace2, sampleTrace3,
} from "../fixtures/traces.js";

// ─── Schemas ───────────────────────────────────────────────────
import {
  PromptFixContextSchema,
  EvalDatasetResultSchema,
  AutofixReportSchema,
} from "../../src/validation/schemas.js";

// ─── Guardrails ────────────────────────────────────────────────
import {
  validatePromptFixContext,
  validateEvalDatasetResult,
  validateAutofixReport,
} from "../../src/validation/guardrails.js";

// ─── Actions ───────────────────────────────────────────────────
import type { PromptFixContext } from "../../src/actions/promptFix.js";
import type { EvalDatasetResult } from "../../src/actions/evalRunner.js";
import type { AutofixReport } from "../../src/actions/autofix.js";

// ─── Model Pricing (no API call) ──────────────────────────────
import { estimateCost } from "../../src/diagnosis/modelPricing.js";

// ════════════════════════════════════════════════════════════════
// PromptFixContext
// ════════════════════════════════════════════════════════════════

describe("PromptFixContext", () => {
  const validContext: PromptFixContext = {
    current_prompt: {
      name: "qa-chat-v2",
      version: 3,
      content: "You are a helpful assistant. Answer based on the provided context.",
      type: "text",
      config: { model: "gpt-4o", temperature: 0.3 },
    },
    diagnosis: {
      cluster_summary: "qa-chat / route=/api/chat / 3건 발생",
      symptoms: ["correctness<0.7", "retrieval_miss"],
      root_causes: ["retrieval_quality_issue (90%)"],
      recommended_actions: ["retrieval filter 완화 및 reranker cutoff 재검토"],
    },
    suggested_changes: [
      "retrieval 결과가 없을 때의 fallback 응답 규칙 추가",
      "context가 부족할 경우 '정보 부족' 명시 지시 추가",
    ],
  };

  it("Zod 스키마를 통과한다", () => {
    const result = PromptFixContextSchema.parse(validContext);
    expect(result.current_prompt.name).toBe("qa-chat-v2");
  });

  it("빈 prompt name을 차단한다", () => {
    const bad = {
      ...validContext,
      current_prompt: { ...validContext.current_prompt, name: "" },
    };
    expect(() => PromptFixContextSchema.parse(bad)).toThrow();
  });

  it("guardrail: 정상 데이터 통과", () => {
    const result = validatePromptFixContext(validContext);
    expect(result.valid).toBe(true);
  });

  it("guardrail: 수정 제안이 없으면 경고", () => {
    const noChanges = { ...validContext, suggested_changes: [] };
    const result = validatePromptFixContext(noChanges);
    expect(result.valid).toBe(true); // valid이지만 warning
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("guardrail: 원인 가설이 없으면 경고", () => {
    const noCauses = {
      ...validContext,
      diagnosis: { ...validContext.diagnosis, root_causes: [] },
    };
    const result = validatePromptFixContext(noCauses);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
// EvalDatasetResult
// ════════════════════════════════════════════════════════════════

describe("EvalDatasetResult", () => {
  const validResult: EvalDatasetResult = {
    dataset_name: "autofix-abc12345-1234567890",
    item_count: 2,
    items: [
      {
        id: "item-1",
        datasetName: "autofix-abc12345-1234567890",
        input: { question: "test question" },
        expectedOutput: null,
        metadata: { trace_id: "trace-001", scores: { correctness: 0.45 } },
        sourceTraceId: "trace-001",
        sourceObservationId: null,
      },
      {
        id: "item-2",
        datasetName: "autofix-abc12345-1234567890",
        input: { question: "another question" },
        expectedOutput: null,
        metadata: { trace_id: "trace-002" },
        sourceTraceId: "trace-002",
        sourceObservationId: null,
      },
    ],
  };

  it("Zod 스키마를 통과한다", () => {
    const result = EvalDatasetResultSchema.parse(validResult);
    expect(result.item_count).toBe(2);
  });

  it("빈 dataset_name을 차단한다", () => {
    const bad = { ...validResult, dataset_name: "" };
    expect(() => EvalDatasetResultSchema.parse(bad)).toThrow();
  });

  it("guardrail: 정상 데이터 통과", () => {
    const result = validateEvalDatasetResult(validResult);
    expect(result.valid).toBe(true);
  });

  it("guardrail: 항목이 없으면 경고", () => {
    const empty = { ...validResult, item_count: 0, items: [] };
    const result = validateEvalDatasetResult(empty);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("항목이 없음"))).toBe(true);
  });

  it("guardrail: item_count 불일치는 에러", () => {
    const mismatch = { ...validResult, item_count: 999 };
    const result = validateEvalDatasetResult(mismatch);
    expect(result.valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// AutofixReport
// ════════════════════════════════════════════════════════════════

describe("AutofixReport", () => {
  const validReport: AutofixReport = {
    trace_count: 20,
    baseline_trace_count: 20,
    regression: null,
    clusters: [sampleCluster],
    top_cluster: sampleCluster,
    chain_analysis: null,
    cost_quality: null,
    fix_plan: sampleFixPlan,
    prompt_fix_context: null,
    eval_dataset: null,
    summary: "자동 분석 완료",
    next_steps: ["프롬프트를 수정하세요"],
  };

  it("guardrail: 정상 데이터 통과", () => {
    const result = validateAutofixReport(validReport);
    expect(result.valid).toBe(true);
  });

  it("guardrail: trace 없으면 경고", () => {
    const noTraces = { ...validReport, trace_count: 0, clusters: [], top_cluster: null };
    const result = validateAutofixReport(noTraces);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("trace가 없음"))).toBe(true);
  });

  it("guardrail: 빈 summary는 에러", () => {
    const noSummary = { ...validReport, summary: "" };
    const result = validateAutofixReport(noSummary);
    expect(result.valid).toBe(false);
  });

  it("guardrail: 빈 next_steps는 에러", () => {
    const noSteps = { ...validReport, next_steps: [] };
    const result = validateAutofixReport(noSteps);
    expect(result.valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Cost estimation for prompt version decisions
// ════════════════════════════════════════════════════════════════

describe("Cost Estimation for Prompt Decisions", () => {
  it("프롬프트 길이 변경에 따른 비용 추정", () => {
    // 현재 프롬프트: 2000 input tokens
    const currentCost = estimateCost("gpt-4o", 2000, 500)!;
    // 최적화 후: 1200 input tokens
    const optimizedCost = estimateCost("gpt-4o", 1200, 500)!;

    expect(optimizedCost).toBeLessThan(currentCost);
    const savingPct = ((currentCost - optimizedCost) / currentCost) * 100;
    expect(savingPct).toBeGreaterThan(0);
  });

  it("모델 다운그레이드 비용 추정", () => {
    const gpt4oCost = estimateCost("gpt-4o", 2000, 500)!;
    const miniCost = estimateCost("gpt-4o-mini", 2000, 500)!;

    expect(miniCost).toBeLessThan(gpt4oCost);
    const savingPct = ((gpt4oCost - miniCost) / gpt4oCost) * 100;
    expect(savingPct).toBeGreaterThan(80); // mini는 gpt-4o 대비 90%+ 저렴
  });
});

// ════════════════════════════════════════════════════════════════
// MCP Tool Registration Count
// ════════════════════════════════════════════════════════════════

describe("MCP Tool Registration", () => {
  it("18개 도구가 등록되어 있다 (12 기존 + 6 Phase 2)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("src/server/mcpServer.ts", "utf-8");
    const matches = content.match(/server\.registerTool\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(18);
  });

  it("Phase 2 쓰기 도구가 모두 등록되어 있다", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("src/server/mcpServer.ts", "utf-8");

    const phase2Tools = [
      "lf_create_prompt_version",
      "lf_promote_prompt",
      "lf_create_eval_dataset",
      "lf_record_score",
      "lf_run_eval",
      "lf_autofix",
    ];

    for (const tool of phase2Tools) {
      expect(content).toContain(`"${tool}"`);
    }
  });
});
