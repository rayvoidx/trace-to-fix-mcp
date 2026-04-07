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
  const raw = await lfGet<unknown>("/observations", {
    traceId,
    limit: "100",
  });
  const res = LfObservationListResponseSchema.parse(raw);
  return res.data;
}
