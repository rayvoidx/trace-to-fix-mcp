import { z } from "zod";
import { lfGet } from "./client.js";
import { LfScoreSchema } from "../../validation/schemas.js";

export type LfScore = z.infer<typeof LfScoreSchema>;

const LfScoreListResponseSchema = z.object({
  data: z.array(LfScoreSchema),
  meta: z.object({ totalItems: z.number(), page: z.number(), totalPages: z.number() }),
});

export async function fetchScores(traceId: string): Promise<LfScore[]> {
  const results: LfScore[] = [];
  for (let page = 1; ; page++) {
    const raw = await lfGet<unknown>("/scores", {
      traceId,
      limit: "100",
      page: String(page),
    });
    const res = LfScoreListResponseSchema.parse(raw);
    results.push(...res.data);
    if (res.data.length < 100 || page >= res.meta.totalPages) break;
  }
  return results;
}
