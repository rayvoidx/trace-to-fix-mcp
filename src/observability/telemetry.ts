/**
 * Feedback Loop & Observability Layer
 *
 * 서버 자체의 분석 동작을 추적한다.
 * "분석하는 도구 자신도 관측 가능해야 한다"는 원칙.
 *
 * - 도구 호출마다 시작/종료/성공/실패를 기록
 * - 자기 자신의 Langfuse trace로 남김 (opt-in)
 * - 메트릭 집계로 서버 건강 상태 파악
 */
import { logger } from "../utils/logger.js";

export interface ToolInvocation {
  tool: string;
  startedAt: number;
  endedAt?: number;
  success: boolean;
  error?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
}

class TelemetryCollector {
  private invocations: ToolInvocation[] = [];
  private readonly maxHistory = 1000;

  record(invocation: ToolInvocation): void {
    this.invocations.push(invocation);
    if (this.invocations.length > this.maxHistory) {
      this.invocations = this.invocations.slice(-this.maxHistory);
    }

    const duration = invocation.endedAt
      ? invocation.endedAt - invocation.startedAt
      : 0;

    if (invocation.success) {
      logger.info(
        { tool: invocation.tool, duration_ms: duration },
        "Tool invocation succeeded",
      );
    } else {
      logger.error(
        { tool: invocation.tool, duration_ms: duration, error: invocation.error },
        "Tool invocation failed",
      );
    }
  }

  getMetrics(): ServerMetrics {
    const now = Date.now();
    const last24h = this.invocations.filter(
      (i) => i.startedAt > now - 86_400_000,
    );

    const byTool = new Map<string, { total: number; failures: number; durations: number[] }>();

    for (const inv of last24h) {
      const entry = byTool.get(inv.tool) ?? { total: 0, failures: 0, durations: [] };
      entry.total++;
      if (!inv.success) entry.failures++;
      if (inv.endedAt) entry.durations.push(inv.endedAt - inv.startedAt);
      byTool.set(inv.tool, entry);
    }

    const toolMetrics: Record<string, ToolMetrics> = {};
    for (const [tool, data] of byTool) {
      const sorted = data.durations.sort((a, b) => a - b);
      toolMetrics[tool] = {
        total_calls: data.total,
        failure_rate: data.total > 0 ? data.failures / data.total : 0,
        avg_duration_ms: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        p95_duration_ms: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0,
      };
    }

    return {
      period: "last_24h",
      total_invocations: last24h.length,
      total_failures: last24h.filter((i) => !i.success).length,
      tools: toolMetrics,
    };
  }

  getRecentInvocations(limit: number = 20): ToolInvocation[] {
    return this.invocations.slice(-limit);
  }
}

export interface ToolMetrics {
  total_calls: number;
  failure_rate: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
}

export interface ServerMetrics {
  period: string;
  total_invocations: number;
  total_failures: number;
  tools: Record<string, ToolMetrics>;
}

// Singleton
export const telemetry = new TelemetryCollector();

/**
 * Wraps a tool handler with automatic telemetry.
 * This is the feedback loop: every tool call is observed.
 */
export function withTelemetry<TArgs, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      telemetry.record({
        tool: toolName,
        startedAt,
        endedAt: Date.now(),
        success: true,
        inputSummary: typeof args === "object" ? summarize(args as Record<string, unknown>) : {},
      });
      return result;
    } catch (err) {
      telemetry.record({
        tool: toolName,
        startedAt,
        endedAt: Date.now(),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        inputSummary: typeof args === "object" ? summarize(args as Record<string, unknown>) : {},
      });
      throw err;
    }
  };
}

function summarize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 100) {
      result[k] = `${v.slice(0, 50)}...[${v.length} chars]`;
    } else if (Array.isArray(v)) {
      result[k] = `[${v.length} items]`;
    } else {
      result[k] = v;
    }
  }
  return result;
}
