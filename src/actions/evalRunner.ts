/**
 * Evaluation Runner Action
 *
 * 실패 trace에서 평가 데이터셋을 자동 생성하고,
 * trace에 점수를 기록한다.
 */
import type { NormalizedTrace, FailureCluster } from "../types.js";
import { createDataset, addDatasetItems, type LfDatasetItem } from "../adapters/langfuse/datasets.js";
import { recordScore, type CreateScoreInput } from "../adapters/langfuse/scoring.js";
import { fetchObservations } from "../adapters/langfuse/observations.js";
import { logger } from "../utils/logger.js";

export interface EvalDatasetResult {
  dataset_name: string;
  item_count: number;
  items: LfDatasetItem[];
}

export interface ScoreRecordResult {
  recorded: number;
  failed: number;
  errors: string[];
}

/**
 * 실패 trace에서 평가 데이터셋을 자동 생성.
 * 각 trace의 input/output을 데이터셋 항목으로 변환.
 */
export async function createEvalDatasetFromTraces(
  name: string,
  traces: NormalizedTrace[],
  cluster?: FailureCluster,
): Promise<EvalDatasetResult> {
  const description = cluster
    ? `Auto-generated from cluster ${cluster.cluster_id} (${cluster.size} traces, symptoms: ${cluster.symptoms.join(", ")})`
    : `Auto-generated from ${traces.length} traces`;

  // Create dataset
  await createDataset({
    name,
    description,
    metadata: {
      source: "trace-to-fix-mcp",
      cluster_id: cluster?.cluster_id ?? null,
      generated_at: new Date().toISOString(),
    },
  });

  // Build items from traces — fetch observations to get input/output
  const items: Array<{
    input: unknown;
    expectedOutput?: unknown;
    metadata?: Record<string, unknown>;
    sourceTraceId?: string;
  }> = [];

  for (const trace of traces.slice(0, 50)) { // cap at 50 items
    try {
      const observations = await fetchObservations(trace.trace_id);
      // Find the main generation (first GENERATION type, or last one)
      const generation = observations.find((o) => o.type === "GENERATION")
        ?? observations[observations.length - 1];

      if (generation) {
        items.push({
          input: generation.input ?? { trace_name: trace.trace_name, metadata: trace.metadata },
          expectedOutput: undefined, // user fills this in later
          metadata: {
            trace_id: trace.trace_id,
            scores: trace.scores,
            status: trace.status,
            latency_ms: trace.latency_ms,
          },
          sourceTraceId: trace.trace_id,
        });
      }
    } catch (err) {
      logger.warn({ trace_id: trace.trace_id, err }, "Failed to fetch observations for dataset item");
    }
  }

  const created = await addDatasetItems(name, items);

  logger.info({ dataset: name, items: created.length }, "Eval dataset created");

  return {
    dataset_name: name,
    item_count: created.length,
    items: created,
  };
}

/**
 * 여러 trace에 점수를 일괄 기록.
 */
export async function batchRecordScores(
  scores: CreateScoreInput[],
): Promise<ScoreRecordResult> {
  let recorded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const score of scores) {
    try {
      await recordScore(score);
      recorded++;
    } catch (err) {
      failed++;
      errors.push(`${score.traceId}/${score.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { recorded, failed, errors };
}
