/**
 * Cluster History Storage
 *
 * 해결된 클러스터를 기록하여 재발 탐지에 사용.
 */
import { getDb, persist } from "./sqlite.js";

export interface ResolvedCluster {
  cluster_id: string;
  fingerprint: string;
  resolved_at: string;
  resolution_note: string | null;
  data: unknown;
}

/** Mark a cluster as resolved */
export async function markClusterResolved(
  clusterId: string,
  fingerprint: string,
  data: unknown,
  note?: string,
): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO resolved_clusters (cluster_id, fingerprint, resolved_at, resolution_note, data)
     VALUES (?, ?, datetime('now'), ?, ?)`,
    [clusterId, fingerprint, note ?? null, JSON.stringify(data)],
  );
  // 해결 이력은 재발 탐지의 근거 데이터 — 즉시 flush
  persist();
}

/** Get all resolved clusters */
export async function getResolvedClusters(): Promise<ResolvedCluster[]> {
  const db = await getDb();
  const results: ResolvedCluster[] = [];
  const stmt = db.prepare("SELECT cluster_id, fingerprint, resolved_at, resolution_note, data FROM resolved_clusters ORDER BY resolved_at DESC");
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    results.push({
      cluster_id: row.cluster_id as string,
      fingerprint: row.fingerprint as string,
      resolved_at: row.resolved_at as string,
      resolution_note: (row.resolution_note as string) ?? null,
      data: JSON.parse(row.data as string),
    });
  }
  stmt.free();
  return results;
}

/** Find resolved clusters that match given fingerprints */
export async function findMatchingResolved(
  fingerprints: string[],
): Promise<Map<string, ResolvedCluster>> {
  const db = await getDb();
  const result = new Map<string, ResolvedCluster>();

  const stmt = db.prepare(
    "SELECT cluster_id, fingerprint, resolved_at, resolution_note, data FROM resolved_clusters WHERE fingerprint = ?",
  );
  for (const fp of fingerprints) {
    stmt.bind([fp]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      result.set(fp, {
        cluster_id: row.cluster_id as string,
        fingerprint: row.fingerprint as string,
        resolved_at: row.resolved_at as string,
        resolution_note: (row.resolution_note as string) ?? null,
        data: JSON.parse(row.data as string),
      });
    }
    stmt.reset();
  }
  stmt.free();

  return result;
}
