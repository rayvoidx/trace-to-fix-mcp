import { lfGet } from "./client.js";

export interface DailyMetrics {
  date: string;
  countTraces: number;
  totalCost: number;
  countObservations: number;
  usage: { input: number; output: number; total: number }[];
}

export async function fetchDailyMetrics(
  traceName?: string,
  fromTimestamp?: string,
  toTimestamp?: string,
): Promise<DailyMetrics[]> {
  const params: Record<string, string> = {};
  if (traceName) params.traceName = traceName;
  if (fromTimestamp) params.fromTimestamp = fromTimestamp;
  if (toTimestamp) params.toTimestamp = toTimestamp;

  const res = await lfGet<{ data: DailyMetrics[] }>("/metrics/daily", params);
  return res.data;
}
