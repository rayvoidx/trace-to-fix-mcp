/**
 * Langfuse Score Write Adapter
 *
 * trace/observation에 평가 점수를 기록.
 * Langfuse API: POST /api/public/scores
 */
import { lfPost } from "./client.js";
import { logger } from "../../utils/logger.js";

export interface CreateScoreInput {
  traceId: string;
  observationId?: string;
  name: string;
  value: number;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  comment?: string;
}

export interface LfScoreCreated {
  id: string;
  traceId: string;
  name: string;
  value: number;
}

/** Record a score on a trace */
export async function recordScore(
  input: CreateScoreInput,
): Promise<LfScoreCreated> {
  logger.info(
    { traceId: input.traceId, name: input.name, value: input.value },
    "Recording score",
  );
  return lfPost<LfScoreCreated>("/scores", input);
}

/** Record multiple scores in batch */
export async function recordScores(
  scores: CreateScoreInput[],
): Promise<LfScoreCreated[]> {
  logger.info({ count: scores.length }, "Recording batch scores");
  const results: LfScoreCreated[] = [];
  for (const score of scores) {
    results.push(await recordScore(score));
  }
  return results;
}
