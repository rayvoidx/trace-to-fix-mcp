import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PlaybookConfig } from "../types.js";

const DEFAULT_CONFIG: PlaybookConfig = {
  thresholds: {
    correctness_low: 0.7,
    faithfulness_low: 0.75,
    context_relevance_low: 0.65,
    latency_high_ms: 5000,
  },
  heuristics: [],
};

let cached: PlaybookConfig | null = null;

export function loadPlaybookConfig(): PlaybookConfig {
  if (cached) return cached;

  const configPath = resolve("config/playbooks.yaml");
  if (!existsSync(configPath)) {
    cached = DEFAULT_CONFIG;
    return cached;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as PlaybookConfig;

  cached = {
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...parsed.thresholds },
    heuristics: parsed.heuristics ?? [],
  };

  return cached;
}
