/**
 * Recurrence Detection
 *
 * 이전에 해결된 실패 패턴이 다시 나타나는지 감지.
 *
 * Langfuse 대시보드와의 차별점:
 * - "이 패턴은 14일 전에 고쳤는데 다시 발생" 자동 감지
 * - 재발 클러스터의 우선순위를 자동으로 상향
 * - soft match로 프롬프트 버전만 바뀐 유사 패턴도 탐지
 */
import type { FailureCluster } from "../types.js";
import { findMatchingResolved, type ResolvedCluster } from "../storage/clusterHistory.js";

export interface RecurrenceMatch {
  current_cluster_id: string;
  historical_cluster_id: string;
  fingerprint: string;
  match_type: "exact" | "soft";
  historical_resolved_at: string;
  days_since_resolution: number;
  severity_comparison: "worse" | "same" | "milder";
}

export interface RecurrenceReport {
  recurrences: RecurrenceMatch[];
  recurrence_rate: number;
  summary: string;
  priority_adjustments: { cluster_id: string; boost: number; reason: string }[];
}

function daysBetween(dateStr: string, now: Date): number {
  const date = new Date(dateStr);
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function compareSeverity(
  current: FailureCluster,
  historical: unknown,
): "worse" | "same" | "milder" {
  const hist = historical as FailureCluster;
  if (!hist?.priority_score) return "same";

  const diff = current.priority_score - hist.priority_score;
  if (diff > 0.1) return "worse";
  if (diff < -0.1) return "milder";
  return "same";
}

/** Extract the "soft fingerprint" — fingerprint without prompt_version component */
function softFingerprint(fp: string): string {
  // Fingerprint format: trace_name|route|prompt_version|error_kind|score_bucket|retrieval_status
  const parts = fp.split("|");
  if (parts.length >= 3) {
    // Remove the prompt_version part (index 2)
    return [...parts.slice(0, 2), ...parts.slice(3)].join("|");
  }
  return fp;
}

export async function detectRecurrence(
  currentClusters: FailureCluster[],
): Promise<RecurrenceReport> {
  const now = new Date();

  if (currentClusters.length === 0) {
    return {
      recurrences: [],
      recurrence_rate: 0,
      summary: "분석할 클러스터가 없습니다.",
      priority_adjustments: [],
    };
  }

  // Exact fingerprint matching
  const fingerprints = currentClusters.map((c) => c.fingerprint);
  const exactMatches = await findMatchingResolved(fingerprints);

  const recurrences: RecurrenceMatch[] = [];
  const matchedClusterIds = new Set<string>();

  // Exact matches
  for (const cluster of currentClusters) {
    const match = exactMatches.get(cluster.fingerprint);
    if (match) {
      matchedClusterIds.add(cluster.cluster_id);
      recurrences.push({
        current_cluster_id: cluster.cluster_id,
        historical_cluster_id: match.cluster_id,
        fingerprint: cluster.fingerprint,
        match_type: "exact",
        historical_resolved_at: match.resolved_at,
        days_since_resolution: daysBetween(match.resolved_at, now),
        severity_comparison: compareSeverity(cluster, match.data),
      });
    }
  }

  // Soft matches (same pattern, different prompt version)
  const unmatchedClusters = currentClusters.filter(
    (c) => !matchedClusterIds.has(c.cluster_id),
  );

  if (unmatchedClusters.length > 0) {
    const softFps = unmatchedClusters.map((c) => softFingerprint(c.fingerprint));
    // Query all resolved and check soft match
    const allResolved = await findMatchingResolved(
      [...new Set(softFps)],
    );

    // Also try with original fingerprints modified
    for (const cluster of unmatchedClusters) {
      const sfp = softFingerprint(cluster.fingerprint);
      const match = allResolved.get(sfp);
      if (match) {
        recurrences.push({
          current_cluster_id: cluster.cluster_id,
          historical_cluster_id: match.cluster_id,
          fingerprint: cluster.fingerprint,
          match_type: "soft",
          historical_resolved_at: match.resolved_at,
          days_since_resolution: daysBetween(match.resolved_at, now),
          severity_comparison: compareSeverity(cluster, match.data),
        });
      }
    }
  }

  const recurrenceRate =
    currentClusters.length > 0
      ? recurrences.length / currentClusters.length
      : 0;

  // Priority adjustments for recurring clusters
  const adjustments = recurrences.map((r) => {
    // Recent recurrences get higher boost
    let boost: number;
    if (r.days_since_resolution < 7) boost = 0.3;
    else if (r.days_since_resolution < 30) boost = 0.2;
    else boost = 0.1;

    if (r.severity_comparison === "worse") boost += 0.1;
    if (r.match_type === "exact") boost += 0.05;

    return {
      cluster_id: r.current_cluster_id,
      boost: Number(boost.toFixed(2)),
      reason: `${r.match_type} 재발 (${r.days_since_resolution}일 전 해결, ${r.severity_comparison})`,
    };
  });

  const summary = buildSummary(recurrences, recurrenceRate, currentClusters.length);

  return {
    recurrences,
    recurrence_rate: Number(recurrenceRate.toFixed(4)),
    summary,
    priority_adjustments: adjustments,
  };
}

function buildSummary(
  recurrences: RecurrenceMatch[],
  rate: number,
  totalClusters: number,
): string {
  if (recurrences.length === 0) {
    return `${totalClusters}개 클러스터 중 재발 패턴 없음`;
  }

  const exact = recurrences.filter((r) => r.match_type === "exact").length;
  const soft = recurrences.filter((r) => r.match_type === "soft").length;
  const worse = recurrences.filter((r) => r.severity_comparison === "worse").length;

  const lines = [
    `${totalClusters}개 클러스터 중 ${recurrences.length}개 재발 감지 (${(rate * 100).toFixed(0)}%):`,
    `  - exact match: ${exact}건, soft match: ${soft}건`,
  ];

  if (worse > 0) {
    lines.push(`  ⚠ ${worse}건은 이전보다 심각도 증가`);
  }

  for (const r of recurrences) {
    lines.push(
      `  - ${r.current_cluster_id}: ${r.days_since_resolution}일 전 해결된 패턴 재발 (${r.match_type}, ${r.severity_comparison})`,
    );
  }

  return lines.join("\n");
}
