/**
 * Self-Tracing via Langfuse (opt-in)
 *
 * Trace-to-Fix MCP 서버 자체의 분석 호출을
 * Langfuse에 trace로 기록한다.
 * "관측하는 도구 자체가 관측 가능해야 한다"
 *
 * 환경 변수 SELF_TRACE_ENABLED=true 로 활성화
 */
import { logger } from "../utils/logger.js";

let langfuseInstance: { trace: (opts: Record<string, unknown>) => { end: () => void; update: (opts: Record<string, unknown>) => void } } | null = null;

function isSelfTraceEnabled(): boolean {
  return process.env.SELF_TRACE_ENABLED === "true";
}

async function ensureLangfuse() {
  if (langfuseInstance) return langfuseInstance;
  if (!isSelfTraceEnabled()) return null;

  try {
    const { getLangfuse } = await import("../adapters/langfuse/client.js");
    langfuseInstance = getLangfuse() as unknown as typeof langfuseInstance;
    return langfuseInstance;
  } catch {
    logger.warn("Self-tracing: could not initialize Langfuse client");
    return null;
  }
}

export async function selfTrace(
  name: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  const lf = await ensureLangfuse();
  if (!lf) return fn();

  const trace = lf.trace({
    name: `trace-to-fix/${name}`,
    metadata: { ...metadata, source: "trace-to-fix-mcp-self" },
  });

  try {
    const result = await fn();
    trace.update({ metadata: { ...metadata, status: "success" } });
    trace.end();
    return result;
  } catch (err) {
    trace.update({
      metadata: { ...metadata, status: "error", error: err instanceof Error ? err.message : String(err) },
    });
    trace.end();
    throw err;
  }
}
