import { z } from "zod";
import { lfGet } from "./client.js";
import { LfObservationSchema } from "../../validation/schemas.js";

export type LfObservation = z.infer<typeof LfObservationSchema>;

const LfObservationListResponseSchema = z.object({
  data: z.array(LfObservationSchema),
  meta: z.object({ totalItems: z.number(), page: z.number(), totalPages: z.number() }),
});

export async function fetchObservations(
  traceId: string,
): Promise<LfObservation[]> {
  const results: LfObservation[] = [];
  for (let page = 1; ; page++) {
    const raw = await lfGet<unknown>("/observations", {
      traceId,
      limit: "100",
      page: String(page),
    });
    const res = LfObservationListResponseSchema.parse(raw);
    results.push(...res.data);
    if (res.data.length < 100 || page >= res.meta.totalPages) break;
  }
  return results;
}
