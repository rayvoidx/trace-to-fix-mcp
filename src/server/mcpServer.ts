import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fetchTraces } from "../adapters/langfuse/traces.js";
import { fetchObservations } from "../adapters/langfuse/observations.js";
import { fetchScores } from "../adapters/langfuse/scores.js";
import { clusterTraces } from "../diagnosis/clustering.js";
import { tagCandidateReasons } from "../diagnosis/candidate.js";
import { filterCandidates } from "../diagnosis/normalize.js";
import { rankClusters } from "../diagnosis/priority.js";
import { generateFixPlan } from "../diagnosis/fixPlan.js";
import { createIssueDraft } from "../adapters/github/issues.js";
import { cacheSet, cacheGet, saveCluster, getCluster } from "../storage/sqlite.js";
import { loadPlaybookConfig } from "./config.js";

// ─── Enhanced Analysis Modules ─────────────────────────────────
import { detectRegressions } from "../diagnosis/regression.js";
import { comparePromptVersions } from "../diagnosis/promptComparison.js";
import { analyzeChain, aggregateChains } from "../diagnosis/chainAnalysis.js";
import { analyzeCostQuality } from "../diagnosis/costQuality.js";
import { detectRecurrence } from "../diagnosis/recurrence.js";
import { markClusterResolved } from "../storage/clusterHistory.js";

// ─── Phase 2: Write & Actions ──────────────────────────────────
import { createPromptVersion, promoteToProduction } from "../adapters/langfuse/prompts.js";
import { recordScore } from "../adapters/langfuse/scoring.js";
import { buildPromptFixContext } from "../actions/promptFix.js";
import { createEvalDatasetFromTraces } from "../actions/evalRunner.js";
import { runAutofix } from "../actions/autofix.js";

// ─── Harness Engineering: 피드백 루프 & 관찰 ───────────────────
import { telemetry } from "../observability/telemetry.js";
import { selfTrace } from "../observability/selfTrace.js";

// ─── Harness Engineering: 검증 가드레일 ────────────────────────
import {
  circuitBreaker,
  withGuardrail,
  validateClusterOutput,
  validateFixPlanOutput,
  validateIssueDraft,
  validateRegressionOutput,
  validateChainAnalysisOutput,
  validateCostQualityOutput,
  validateRecurrenceOutput,
} from "../validation/guardrails.js";
import {
  validateClusterInvariants,
  validateFixPlanInvariants,
  warnOnAnomalies,
} from "../validation/invariants.js";

import type {
  NormalizedTrace,
  FailureCluster,
  FixPlan,
  ListFailingTracesInput,
} from "../types.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "trace-to-fix-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "Trace-to-Fix MCP: Langfuse trace 기반 실패 분석 → 수정 계획 → GitHub 이슈 생성 도구",
    },
  );

  const config = loadPlaybookConfig();

  // ─── Tools ────────────────────────────────────────────────────────

  server.registerTool("lf_list_failing_traces", {
    title: "List Failing Traces",
    description:
      "Langfuse에서 주어진 시간 범위와 필터 조건으로 실패 trace 목록을 조회합니다.",
    inputSchema: {
      project: z.string().optional().describe("Langfuse project name"),
      environment: z.string().optional().describe("Environment (prod, staging, dev)"),
      time_from: z.string().describe("ISO 8601 시작 시간"),
      time_to: z.string().describe("ISO 8601 종료 시간"),
      trace_name: z.string().optional().describe("Trace name 필터"),
      metadata_service: z.string().optional().describe("metadata.service 필터"),
      metadata_route: z.string().optional().describe("metadata.route 필터"),
      correctness_lt: z.number().optional().describe("correctness score < 이 값인 trace만"),
      faithfulness_lt: z.number().optional().describe("faithfulness score < 이 값인 trace만"),
      latency_ms_gt: z.number().optional().describe("latency > 이 값(ms)인 trace만"),
      limit: z.number().optional().describe("최대 조회 건수 (기본 100)"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_list_failing_traces";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const input: ListFailingTracesInput = {
          project: args.project,
          environment: args.environment,
          time_from: args.time_from,
          time_to: args.time_to,
          filters: {
            trace_name: args.trace_name ? [args.trace_name] : undefined,
            metadata: {
              ...(args.metadata_service ? { service: args.metadata_service } : {}),
              ...(args.metadata_route ? { route: args.metadata_route } : {}),
            },
            score_thresholds: {
              ...(args.correctness_lt != null ? { correctness_lt: args.correctness_lt } : {}),
              ...(args.faithfulness_lt != null ? { faithfulness_lt: args.faithfulness_lt } : {}),
            },
            latency_ms_gt: args.latency_ms_gt,
          },
          limit: args.limit,
        };

        const traces = await fetchTraces(input);

        // Invariant: 비정상 데이터 경고
        warnOnAnomalies(traces);

        const candidates = filterCandidates(traces, config, input.filters);
        const tagged = tagCandidateReasons(candidates, config.thresholds);

        await cacheSet("trace_list", `${args.time_from}_${args.time_to}`, tagged, 30);

        return tagged.map((t) => ({
          trace_id: t.trace_id,
          trace_name: t.trace_name,
          environment: t.environment,
          start_time: t.start_time,
          latency_ms: t.latency_ms,
          score_summary: t.scores,
          metadata: t.metadata,
          candidate_reasons: t.candidate_reasons,
        }));
      });

      const items = result as Array<Record<string, unknown>>;
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);

      return {
        content: [{ type: "text", text: JSON.stringify({ count: items.length, items }, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_get_trace_bundle", {
    title: "Get Trace Bundle",
    description: "특정 trace의 observations, scores를 포함한 전체 bundle을 조회합니다.",
    inputSchema: {
      trace_id: z.string().describe("Langfuse trace ID"),
      include_observations: z.boolean().optional().default(true),
      include_scores: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_get_trace_bundle";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { trace_id: args.trace_id }, async () => {
        const cached = await cacheGet("trace_bundle", args.trace_id);
        if (cached) return cached;

        const [observations, scores] = await Promise.all([
          args.include_observations ? fetchObservations(args.trace_id) : Promise.resolve([]),
          args.include_scores ? fetchScores(args.trace_id) : Promise.resolve([]),
        ]);

        const bundle = {
          trace_id: args.trace_id,
          observations,
          scores,
          observation_count: observations.length,
          score_count: scores.length,
        };

        await cacheSet("trace_bundle", args.trace_id, bundle, 60);
        return bundle;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_group_failure_patterns", {
    title: "Group Failure Patterns",
    description:
      "여러 trace를 fingerprint 기반으로 failure cluster로 자동 그룹화합니다.",
    inputSchema: {
      trace_ids: z.array(z.string()).optional().describe("분석할 trace ID 목록 (비어있으면 최근 캐시된 목록 사용)"),
      max_clusters: z.number().optional().default(20).describe("최대 클러스터 수"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_group_failure_patterns";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        let traces: NormalizedTrace[];

        if (args.trace_ids?.length) {
          const cachedList = await cacheGet("trace_list", "latest") as NormalizedTrace[] | null;
          if (cachedList) {
            traces = cachedList.filter((t) => args.trace_ids!.includes(t.trace_id));
          } else {
            return { error: "trace_ids 지정 시 먼저 lf_list_failing_traces로 조회해주세요." };
          }
        } else {
          return { error: "먼저 lf_list_failing_traces를 호출하여 분석 대상을 조회해주세요." };
        }

        if (traces.length === 0) {
          return { clusters: [], message: "일치하는 trace가 없습니다." };
        }

        const clusters = clusterTraces(traces, config, args.max_clusters);
        const ranked = rankClusters(clusters, {
          totalTraces: traces.length,
          prodEnvironment: traces[0]?.environment === "prod",
        });

        // Guardrail: 클러스터 불변조건 + 출력 품질 검증
        for (const c of ranked) {
          validateClusterInvariants(c);
          withGuardrail("lf_group_failure_patterns", validateClusterOutput, c);
          await saveCluster(c.cluster_id, c.fingerprint, c);
        }

        return {
          total_traces: traces.length,
          cluster_count: ranked.length,
          clusters: ranked,
        };
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_suggest_fix_plan", {
    title: "Suggest Fix Plan",
    description: "cluster 또는 trace 단위로 수정 계획을 생성합니다.",
    inputSchema: {
      target_type: z.enum(["cluster", "trace"]).describe("분석 대상 유형"),
      target_id: z.string().describe("cluster_id 또는 trace_id"),
      strategy: z.enum(["conservative", "aggressive"]).optional().default("conservative"),
      include_experiment_plan: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_suggest_fix_plan";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        if (args.target_type === "cluster") {
          const clusterData = await getCluster(args.target_id) as FailureCluster | null;
          if (!clusterData) {
            return { error: `Cluster ${args.target_id}를 찾을 수 없습니다. lf_group_failure_patterns를 먼저 실행하세요.` };
          }

          const plan = generateFixPlan(clusterData, args.strategy, args.include_experiment_plan);

          // Guardrail: fix plan 불변조건 + 출력 품질 검증
          validateFixPlanInvariants(plan);
          withGuardrail("lf_suggest_fix_plan", validateFixPlanOutput, plan);

          await cacheSet("fix_plan", args.target_id, plan, 120);
          return plan;
        }

        return { error: "trace 단위 fix plan은 먼저 lf_get_trace_bundle로 bundle을 조회한 뒤 cluster를 생성하세요." };
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("gh_create_issue_draft", {
    title: "Create GitHub Issue Draft",
    description:
      "분석 결과를 GitHub issue 초안으로 생성합니다. dry_run=true(기본)이면 미리보기만 합니다.",
    inputSchema: {
      repo: z.string().describe("GitHub repo (owner/repo 형식)"),
      cluster_id: z.string().describe("대상 cluster ID"),
      title_prefix: z.string().optional().default("[Trace-to-Fix]"),
      labels: z.array(z.string()).optional().describe("GitHub labels"),
      assignees: z.array(z.string()).optional().describe("GitHub assignees"),
      dry_run: z.boolean().optional().default(true).describe("true면 미리보기만 (기본값)"),
    },
  }, async (args) => {
    const toolName = "gh_create_issue_draft";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const clusterData = await getCluster(args.cluster_id) as FailureCluster | null;
        if (!clusterData) {
          return { error: `Cluster ${args.cluster_id}를 찾을 수 없습니다.` };
        }

        const fixPlanData = await cacheGet("fix_plan", args.cluster_id) as FixPlan | null;

        const draft = await createIssueDraft({
          repo: args.repo,
          cluster: clusterData,
          fixPlan: fixPlanData,
          titlePrefix: args.title_prefix,
          labels: args.labels,
          assignees: args.assignees,
          dryRun: args.dry_run,
        });

        // Guardrail: 이슈 초안 필수 섹션 검증
        withGuardrail("gh_create_issue_draft", validateIssueDraft, draft);

        return draft;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("export_markdown_report", {
    title: "Export Markdown Report",
    description: "현재 분석 결과를 Markdown 보고서로 내보냅니다.",
    inputSchema: {
      cluster_ids: z.array(z.string()).optional().describe("포함할 cluster ID 목록 (비어있으면 전체)"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const ids = args.cluster_ids ?? [];
    const lines: string[] = ["# Trace-to-Fix Report", "", `Generated: ${new Date().toISOString()}`, ""];

    if (ids.length === 0) {
      return {
        content: [{ type: "text", text: "cluster_ids를 지정하거나 먼저 lf_group_failure_patterns를 실행하세요." }],
      };
    }

    lines.push("## Top Failure Clusters", "");
    for (let i = 0; i < ids.length; i++) {
      const data = await getCluster(ids[i]) as FailureCluster | null;
      if (!data) continue;

      const fs = data.feature_summary as Record<string, unknown>;
      lines.push(`### Cluster ${i + 1}: ${fs.trace_name ?? "unknown"} ${fs.route ?? ""}`);
      lines.push(`- **ID**: \`${data.cluster_id}\``);
      lines.push(`- **Size**: ${data.size} traces`);
      lines.push(`- **Priority**: ${data.priority_score.toFixed(2)}`);
      lines.push(`- **Symptoms**: ${data.symptoms.join(", ")}`);
      lines.push("");

      if (data.root_cause_hypotheses.length > 0) {
        lines.push("**Root Causes**:");
        for (const h of data.root_cause_hypotheses) {
          lines.push(`- ${h.cause} (confidence: ${(h.confidence * 100).toFixed(0)}%)`);
        }
        lines.push("");
      }

      const plan = await cacheGet("fix_plan", data.cluster_id) as FixPlan | null;
      if (plan) {
        lines.push("**Recommended Actions**:");
        for (const a of plan.actions) {
          lines.push(`${a.priority}. [${a.owner}] ${a.action} — ${a.expected_impact}`);
        }
        lines.push("");
      }

      lines.push("---", "");
    }

    lines.push("*Generated by Trace-to-Fix MCP*");
    const report = lines.join("\n");

    return { content: [{ type: "text", text: report }] };
  });

  // ─── Enhanced Analysis Tools ──────────────────────────────────────

  server.registerTool("lf_detect_regression", {
    title: "Detect Regression",
    description:
      "현재 기간과 베이스라인 기간의 trace를 통계적으로 비교하여 품질/성능 회귀를 탐지합니다. (Cohen's d, Welch's t-test)",
    inputSchema: {
      time_from: z.string().describe("현재 기간 시작 (ISO 8601)"),
      time_to: z.string().describe("현재 기간 종료 (ISO 8601)"),
      baseline_from: z.string().optional().describe("베이스라인 시작 (미입력 시 동일 길이 직전 기간)"),
      baseline_to: z.string().optional().describe("베이스라인 종료"),
      trace_name: z.string().optional().describe("Trace name 필터"),
      limit: z.number().optional().default(200).describe("기간당 최대 조회 건수"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_detect_regression";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        // Auto-compute baseline if not provided
        const currentFrom = new Date(args.time_from);
        const currentTo = new Date(args.time_to);
        const durationMs = currentTo.getTime() - currentFrom.getTime();
        const baselineFrom = args.baseline_from ?? new Date(currentFrom.getTime() - durationMs).toISOString();
        const baselineTo = args.baseline_to ?? args.time_from;

        const baseInput: ListFailingTracesInput = {
          time_from: baselineFrom,
          time_to: baselineTo,
          filters: { trace_name: args.trace_name ? [args.trace_name] : undefined },
          limit: args.limit,
        };
        const currInput: ListFailingTracesInput = {
          time_from: args.time_from,
          time_to: args.time_to,
          filters: { trace_name: args.trace_name ? [args.trace_name] : undefined },
          limit: args.limit,
        };

        const [baselineTraces, currentTraces] = await Promise.all([
          fetchTraces(baseInput),
          fetchTraces(currInput),
        ]);

        const report = detectRegressions(
          baselineTraces, currentTraces,
          { from: baselineFrom, to: baselineTo },
          { from: args.time_from, to: args.time_to },
        );

        withGuardrail(toolName, validateRegressionOutput, report);
        return report;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_compare_prompt_versions", {
    title: "Compare Prompt Versions",
    description:
      "동일 trace에서 프롬프트 버전별 품질·비용·지연을 통계적으로 비교합니다.",
    inputSchema: {
      time_from: z.string().describe("시작 시간 (ISO 8601)"),
      time_to: z.string().describe("종료 시간 (ISO 8601)"),
      trace_name: z.string().optional().describe("Trace name 필터"),
      limit: z.number().optional().default(500).describe("최대 조회 건수"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_compare_prompt_versions";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const traces = await fetchTraces({
          time_from: args.time_from,
          time_to: args.time_to,
          filters: { trace_name: args.trace_name ? [args.trace_name] : undefined },
          limit: args.limit,
        });

        return comparePromptVersions(traces);
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_analyze_chain", {
    title: "Analyze Observation Chain",
    description:
      "trace 내 observation 체인을 분석하여 병목과 실패 지점을 찾습니다. 단일 trace 또는 다수 trace 집계 분석.",
    inputSchema: {
      trace_ids: z.array(z.string()).describe("분석할 trace ID 목록"),
      aggregate: z.boolean().optional().default(false).describe("true면 다수 trace 집계 분석"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_analyze_chain";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const reports = [];
        for (const traceId of args.trace_ids) {
          const observations = await fetchObservations(traceId);
          const report = analyzeChain(traceId, observations);
          withGuardrail(toolName, validateChainAnalysisOutput, report);
          reports.push(report);
        }

        if (args.aggregate && reports.length > 1) {
          return aggregateChains(reports);
        }

        return reports.length === 1 ? reports[0] : reports;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_analyze_cost_quality", {
    title: "Analyze Cost-Quality Tradeoff",
    description:
      "모델별 비용·품질·지연을 비교하여 최적의 모델 조합을 추천합니다.",
    inputSchema: {
      time_from: z.string().describe("시작 시간 (ISO 8601)"),
      time_to: z.string().describe("종료 시간 (ISO 8601)"),
      trace_name: z.string().optional().describe("Trace name 필터"),
      limit: z.number().optional().default(500).describe("최대 조회 건수"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_analyze_cost_quality";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const traces = await fetchTraces({
          time_from: args.time_from,
          time_to: args.time_to,
          filters: { trace_name: args.trace_name ? [args.trace_name] : undefined },
          limit: args.limit,
        });

        const report = analyzeCostQuality(traces);
        withGuardrail(toolName, validateCostQualityOutput, report);
        return report;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_detect_recurrence", {
    title: "Detect Recurrence",
    description:
      "현재 실패 클러스터가 이전에 해결된 패턴의 재발인지 감지합니다.",
    inputSchema: {
      cluster_ids: z.array(z.string()).describe("검사할 cluster ID 목록"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_detect_recurrence";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const clusters: FailureCluster[] = [];
        for (const id of args.cluster_ids) {
          const data = await getCluster(id) as FailureCluster | null;
          if (data) clusters.push(data);
        }

        if (clusters.length === 0) {
          return { error: "지정한 cluster를 찾을 수 없습니다. lf_group_failure_patterns를 먼저 실행하세요." };
        }

        const report = await detectRecurrence(clusters);
        withGuardrail(toolName, validateRecurrenceOutput, report);
        return report;
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_resolve_cluster", {
    title: "Resolve Cluster",
    description:
      "클러스터를 '해결됨'으로 표시합니다. 이후 동일 패턴이 재발하면 lf_detect_recurrence가 감지합니다.",
    inputSchema: {
      cluster_id: z.string().describe("해결된 cluster ID"),
      note: z.string().optional().describe("해결 메모 (어떻게 고쳤는지)"),
    },
  }, async (args) => {
    const toolName = "lf_resolve_cluster";
    const startedAt = Date.now();

    try {
      const clusterData = await getCluster(args.cluster_id) as FailureCluster | null;
      if (!clusterData) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Cluster ${args.cluster_id}를 찾을 수 없습니다.` }) }],
        };
      }

      await markClusterResolved(
        args.cluster_id,
        clusterData.fingerprint,
        clusterData,
        args.note,
      );

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "resolved",
          cluster_id: args.cluster_id,
          fingerprint: clusterData.fingerprint,
          note: args.note ?? null,
        }, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      throw err;
    }
  });

  // ─── Phase 2: Write & Action Tools ────────────────────────────────

  server.registerTool("lf_create_prompt_version", {
    title: "Create Prompt Version",
    description:
      "Langfuse에 프롬프트 새 버전을 생성합니다.",
    inputSchema: {
      name: z.string().describe("프롬프트 이름"),
      type: z.enum(["text", "chat"]).describe("프롬프트 유형"),
      prompt: z.string().describe("프롬프트 내용 (text일 경우 문자열, chat일 경우 JSON 문자열)"),
      labels: z.array(z.string()).optional().describe("라벨 (예: ['staging'])"),
      config: z.string().optional().describe("설정 JSON (model, temperature 등)"),
    },
  }, async (args) => {
    const toolName = "lf_create_prompt_version";
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const promptContent = args.type === "chat" ? JSON.parse(args.prompt) : args.prompt;
        const config = args.config ? JSON.parse(args.config) : undefined;

        return createPromptVersion({
          name: args.name,
          type: args.type,
          prompt: promptContent,
          labels: args.labels,
          config,
        });
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      throw err;
    }
  });

  server.registerTool("lf_promote_prompt", {
    title: "Promote Prompt to Production",
    description:
      "프롬프트 특정 버전을 production 라벨로 승격합니다.",
    inputSchema: {
      name: z.string().describe("프롬프트 이름"),
      version: z.number().int().describe("승격할 버전 번호"),
    },
  }, async (args) => {
    const toolName = "lf_promote_prompt";
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        return promoteToProduction(args.name, args.version);
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      throw err;
    }
  });

  server.registerTool("lf_create_eval_dataset", {
    title: "Create Eval Dataset",
    description:
      "실패 trace에서 평가 데이터셋을 자동 생성합니다. 각 trace의 input/output이 데이터셋 항목이 됩니다.",
    inputSchema: {
      dataset_name: z.string().describe("생성할 데이터셋 이름"),
      cluster_id: z.string().optional().describe("대상 cluster ID (지정 시 해당 클러스터의 trace만)"),
      trace_ids: z.array(z.string()).optional().describe("직접 지정할 trace ID 목록"),
    },
  }, async (args) => {
    const toolName = "lf_create_eval_dataset";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        let traces: NormalizedTrace[] = [];

        if (args.cluster_id) {
          const clusterData = await getCluster(args.cluster_id) as FailureCluster | null;
          if (!clusterData) {
            return { error: `Cluster ${args.cluster_id}를 찾을 수 없습니다.` };
          }
          // Get traces from cache that match cluster trace_ids
          const cachedList = await cacheGet("trace_list", "latest") as NormalizedTrace[] | null;
          if (cachedList) {
            traces = cachedList.filter((t) => clusterData.trace_ids.includes(t.trace_id));
          }
        } else if (args.trace_ids?.length) {
          const cachedList = await cacheGet("trace_list", "latest") as NormalizedTrace[] | null;
          if (cachedList) {
            traces = cachedList.filter((t) => args.trace_ids!.includes(t.trace_id));
          }
        }

        if (traces.length === 0) {
          return { error: "대상 trace를 찾을 수 없습니다. 먼저 lf_list_failing_traces를 실행하세요." };
        }

        const cluster = args.cluster_id
          ? await getCluster(args.cluster_id) as FailureCluster | undefined
          : undefined;

        return createEvalDatasetFromTraces(args.dataset_name, traces, cluster);
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_record_score", {
    title: "Record Score",
    description:
      "trace에 평가 점수를 기록합니다.",
    inputSchema: {
      trace_id: z.string().describe("대상 trace ID"),
      observation_id: z.string().optional().describe("대상 observation ID"),
      name: z.string().describe("점수 이름 (예: correctness, faithfulness)"),
      value: z.number().describe("점수 값"),
      data_type: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]).optional().default("NUMERIC"),
      comment: z.string().optional().describe("코멘트"),
    },
  }, async (args) => {
    const toolName = "lf_record_score";
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        return recordScore({
          traceId: args.trace_id,
          observationId: args.observation_id,
          name: args.name,
          value: args.value,
          dataType: args.data_type,
          comment: args.comment,
        });
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      throw err;
    }
  });

  server.registerTool("lf_run_eval", {
    title: "Run Evaluation",
    description:
      "프롬프트 수정 컨텍스트를 생성합니다. 현재 프롬프트 + 진단 결과를 조합하여 수정 지침을 제공합니다.",
    inputSchema: {
      prompt_name: z.string().describe("Langfuse 프롬프트 이름"),
      cluster_id: z.string().describe("진단 대상 cluster ID"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_run_eval";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        const clusterData = await getCluster(args.cluster_id) as FailureCluster | null;
        if (!clusterData) {
          return { error: `Cluster ${args.cluster_id}를 찾을 수 없습니다.` };
        }

        const fixPlanData = await cacheGet("fix_plan", args.cluster_id) as FixPlan | null;

        return buildPromptFixContext(args.prompt_name, clusterData, fixPlanData);
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  server.registerTool("lf_autofix", {
    title: "Autofix",
    description:
      "진단→클러스터링→회귀탐지→체인분석→비용분석→수정계획→데이터셋 생성까지 전체 파이프라인을 자동 실행합니다.",
    inputSchema: {
      time_from: z.string().describe("분석 시작 시간 (ISO 8601)"),
      time_to: z.string().describe("분석 종료 시간 (ISO 8601)"),
      baseline_from: z.string().optional().describe("베이스라인 시작 (미입력 시 동일 길이 직전 기간)"),
      baseline_to: z.string().optional().describe("베이스라인 종료"),
      trace_name: z.string().optional().describe("Trace name 필터"),
      prompt_name: z.string().optional().describe("프롬프트 이름 (수정 컨텍스트 생성용)"),
      create_dataset: z.boolean().optional().default(false).describe("true면 실패 trace에서 eval 데이터셋 자동 생성"),
      max_traces: z.number().optional().default(200).describe("최대 분석 trace 수"),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const toolName = "lf_autofix";
    circuitBreaker.check(toolName);
    const startedAt = Date.now();

    try {
      const result = await selfTrace(toolName, { args }, async () => {
        return runAutofix({
          time_from: args.time_from,
          time_to: args.time_to,
          baseline_from: args.baseline_from,
          baseline_to: args.baseline_to,
          trace_name: args.trace_name,
          prompt_name: args.prompt_name,
          create_dataset: args.create_dataset,
          max_traces: args.max_traces,
        });
      });

      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: true });
      circuitBreaker.recordSuccess(toolName);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.record({ tool: toolName, startedAt, endedAt: Date.now(), success: false, error: msg });
      circuitBreaker.recordFailure(toolName, msg);
      throw err;
    }
  });

  // ─── Resources ────────────────────────────────────────────────────

  server.registerResource(
    "root-cause-heuristics",
    "resource://playbooks/root-cause-heuristics",
    { description: "실패 원인 추정 규칙 모음 (heuristic rules)" },
    () => {
      const content = readFileSync(resolve("src/resources/playbooks/root-cause-heuristics.md"), "utf-8");
      return { contents: [{ uri: "resource://playbooks/root-cause-heuristics", text: content }] };
    },
  );

  server.registerResource(
    "github-issue-template",
    "resource://templates/github-issue",
    { description: "GitHub issue body 템플릿" },
    () => {
      const content = readFileSync(resolve("src/resources/templates/github-issue.md"), "utf-8");
      return { contents: [{ uri: "resource://templates/github-issue", text: content }] };
    },
  );

  server.registerResource(
    "cluster-detail",
    new ResourceTemplate("resource://clusters/{cluster_id}", {
      list: undefined,
    }),
    { description: "특정 cluster 상세 JSON" },
    async (uri, params) => {
      const cid = params.cluster_id as string;
      const data = await getCluster(cid);
      return {
        contents: [{
          uri: uri.href,
          text: data ? JSON.stringify(data, null, 2) : `Cluster ${cid} not found`,
        }],
      };
    },
  );

  // ─── Prompts ──────────────────────────────────────────────────────

  server.registerPrompt(
    "diagnose-cluster",
    {
      title: "Diagnose Cluster",
      description: "cluster JSON을 넣으면 원인 가설을 도출하는 진단 프롬프트",
      argsSchema: {
        cluster_json: z.string().describe("FailureCluster JSON"),
      },
    },
    (args) => {
      const template = readFileSync(resolve("src/prompts/diagnoseCluster.md"), "utf-8");
      const filled = template.replace("{{cluster_json}}", args.cluster_json);
      return { messages: [{ role: "user", content: { type: "text", text: filled } }] };
    },
  );

  server.registerPrompt(
    "draft-issue",
    {
      title: "Draft Issue",
      description: "분석 결과를 GitHub issue Markdown으로 바꾸는 프롬프트",
      argsSchema: {
        analysis_json: z.string().describe("분석 결과 JSON"),
      },
    },
    (args) => {
      const template = readFileSync(resolve("src/prompts/draftIssue.md"), "utf-8");
      const filled = template.replace("{{analysis_json}}", args.analysis_json);
      return { messages: [{ role: "user", content: { type: "text", text: filled } }] };
    },
  );

  server.registerPrompt(
    "fix-experiment-plan",
    {
      title: "Fix Experiment Plan",
      description: "A/B 및 offline eval 계획 생성용 프롬프트",
      argsSchema: {
        fix_plan_json: z.string().describe("FixPlan JSON"),
      },
    },
    (args) => {
      const template = readFileSync(resolve("src/prompts/fixExperimentPlan.md"), "utf-8");
      const filled = template.replace("{{fix_plan_json}}", args.fix_plan_json);
      return { messages: [{ role: "user", content: { type: "text", text: filled } }] };
    },
  );

  return server;
}
