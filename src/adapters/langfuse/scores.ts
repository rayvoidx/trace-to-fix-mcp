import { z } from "zod";
import { lfGet } from "./client.js";
import { LfScoreSchema } from "../../validation/schemas.js";

export type LfScore = z.infer<typeof LfScoreSchema>;

const LfScoreListResponseSchema = z.object({
  data: z.array(LfScoreSchema),
  meta: z.object({ totalItems: z.number(), page: z.number(), totalPages: z.number() }),
});

export async function fetchScores(traceId: string): Promise<LfScore[]> {
  const raw = await lfGet<unknown>("/scores", {
    traceId,
    limit: "100",
  });
  const res = LfScoreListResponseSchema.parse(raw);
  return res.data;
}
