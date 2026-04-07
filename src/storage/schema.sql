CREATE TABLE IF NOT EXISTS analysis_cache (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('trace_list', 'trace_bundle', 'cluster', 'fix_plan', 'issue_draft')),
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  UNIQUE(type, key)
);

CREATE INDEX IF NOT EXISTS idx_cache_type_key ON analysis_cache(type, key);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON analysis_cache(expires_at);

CREATE TABLE IF NOT EXISTS clusters (
  cluster_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clusters_fingerprint ON clusters(fingerprint);

CREATE TABLE IF NOT EXISTS resolved_clusters (
  cluster_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolution_note TEXT,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resolved_fingerprint ON resolved_clusters(fingerprint);
