import type { FailureCluster } from "../types.js";

interface PriorityContext {
  totalTraces: number;
  prodEnvironment: boolean;
  coreRoutes?: string[];
}

export function scorePriority(
  cluster: FailureCluster,
  ctx: PriorityContext,
): number {
  const sizeNorm = Math.min(cluster.size / Math.max(ctx.totalTraces, 1), 1);

  let businessImpact = 0;
  const route = cluster.feature_summary.route as string | undefined;
  if (ctx.prodEnvironment) businessImpact += 0.5;
  if (route && ctx.coreRoutes?.includes(route)) businessImpact += 0.5;

  let severity = 0;
  if (cluster.symptoms.includes("error")) severity += 0.4;
  if (cluster.symptoms.includes("correctness<0.7")) severity += 0.3;
  if (cluster.symptoms.includes("retrieval_miss")) severity += 0.2;
  if (cluster.symptoms.includes("high_latency")) severity += 0.1;
  severity = Math.min(severity, 1);

  // Recency: use representative traces' presence as proxy (higher = recent)
  const recency = cluster.size > 0 ? 0.7 : 0;

  return (
    0.35 * sizeNorm +
    0.30 * businessImpact +
    0.20 * severity +
    0.15 * recency
  );
}

export function rankClusters(
  clusters: FailureCluster[],
  ctx: PriorityContext,
): FailureCluster[] {
  return clusters
    .map((c) => ({ ...c, priority_score: scorePriority(c, ctx) }))
    .sort((a, b) => b.priority_score - a.priority_score);
}
