import { z } from "zod";
import { lfGet } from "./client.js";
import type { ListFailingTracesInput, NormalizedTrace } from "../../types.js";
import { LfTraceListResponseSchema, LfTraceSchema } from "../../validation/schemas.js";
import { logger } from "../../utils/logger.js";

type LfTrace = z.infer<typeof LfTraceSchema>;

export async function fetchTraces(
  input: ListFailingTracesInput,
): Promise<NormalizedTrace[]> {
  const params: Record<string, string> = {
    page: "1",
    limit: String(input.limit ?? 100),
  };

  if (input.filters?.trace_name?.length) {
    params.name = input.filters.trace_name[0];
  }
  if (input.time_from) params.fromTimestamp = input.time_from;
  if (input.time_to) params.toTimestamp = input.time_to;

  logger.info({ params }, "Fetching traces from Langfuse");

  const raw = await lfGet<unknown>("/traces", params);
  const res = LfTraceListResponseSchema.parse(raw);

  return res.data.map((t) => toNormalized(t, input));
}

function toNormalized(t: LfTrace, input: ListFailingTracesInput): NormalizedTrace {
  const meta = (t.metadata ?? {}) as Record<string, string>;
  const scores = t.scores ?? {};
  const latencyMs = t.latency != null ? Math.round(t.latency * 1000) : 0;

  let status: NormalizedTrace["status"] = "ok";
  if (t.level === "ERROR" || t.statusMessage) status = "error";
  else if (latencyMs > (input.filters?.latency_ms_gt ?? 999999)) status = "degraded";

  return {
    trace_id: t.id,
    project: input.project ?? process.env.DEFAULT_PROJECT ?? "",
    environment: input.environment ?? process.env.DEFAULT_ENV ?? "prod",
    trace_name: t.name ?? "unknown",
    start_time: t.startTime,
    latency_ms: latencyMs,
    status,
    model_name: (meta.model as string) ?? null,
    prompt_version: (meta.prompt_version as string) ?? null,
    route: (meta.route as string) ?? null,
    service: (meta.service as string) ?? null,
    scores,
    usage: {
      input_tokens: t.usage?.input ?? 0,
      output_tokens: t.usage?.output ?? 0,
      total_tokens: t.usage?.total ?? 0,
    },
    cost_usd: t.totalCost ?? 0,
    retrieval: {
      count: Number(meta.retrieval_count ?? 0),
      top_k: Number(meta.retrieval_top_k ?? 0),
      hit_signals: [],
    },
    errors: detectErrors(t, scores),
    metadata: meta,
  };
}

function detectErrors(
  t: LfTrace,
  scores: Record<string, number>,
): NormalizedTrace["errors"] {
  const errors: NormalizedTrace["errors"] = [];

  if (t.level === "ERROR") {
    errors.push({ kind: "unknown", message: t.statusMessage ?? "Trace-level error" });
  }
  if (scores.correctness != null && scores.correctness < 0.5) {
    errors.push({ kind: "hallucination", message: `correctness=${scores.correctness}` });
  }
  if (Number((t.metadata as Record<string, unknown>)?.retrieval_count ?? 1) === 0) {
    errors.push({ kind: "retrieval_miss", message: "retrieval_count=0" });
  }

  return errors;
}
