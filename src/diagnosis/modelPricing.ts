/**
 * Model Pricing Lookup
 *
 * Langfuse에 totalCost가 없을 때 토큰 수 + 모델명으로 비용 추정.
 * $ per 1M tokens 기준. 2026-04 기준 가격.
 */

interface ModelPrice {
  input_per_1m: number;
  output_per_1m: number;
}

const PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { input_per_1m: 2.5, output_per_1m: 10 },
  "gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 },
  "gpt-4-turbo": { input_per_1m: 10, output_per_1m: 30 },
  "gpt-4": { input_per_1m: 30, output_per_1m: 60 },
  "gpt-3.5-turbo": { input_per_1m: 0.5, output_per_1m: 1.5 },
  "o1": { input_per_1m: 15, output_per_1m: 60 },
  "o1-mini": { input_per_1m: 3, output_per_1m: 12 },
  "o3-mini": { input_per_1m: 1.1, output_per_1m: 4.4 },
  // Anthropic
  "claude-opus-4-20250514": { input_per_1m: 15, output_per_1m: 75 },
  "claude-sonnet-4-20250514": { input_per_1m: 3, output_per_1m: 15 },
  "claude-3-5-sonnet-20241022": { input_per_1m: 3, output_per_1m: 15 },
  "claude-3-5-haiku-20241022": { input_per_1m: 0.8, output_per_1m: 4 },
  "claude-3-opus-20240229": { input_per_1m: 15, output_per_1m: 75 },
  "claude-3-haiku-20240307": { input_per_1m: 0.25, output_per_1m: 1.25 },
  // Google
  "gemini-2.0-flash": { input_per_1m: 0.1, output_per_1m: 0.4 },
  "gemini-2.5-pro": { input_per_1m: 1.25, output_per_1m: 10 },
  "gemini-1.5-pro": { input_per_1m: 1.25, output_per_1m: 5 },
  "gemini-1.5-flash": { input_per_1m: 0.075, output_per_1m: 0.3 },
};

/** Fuzzy match: "gpt-4o-2024-08-06" → "gpt-4o" */
function findModel(modelName: string): ModelPrice | null {
  const lower = modelName.toLowerCase();
  // Exact match first
  if (PRICING[lower]) return PRICING[lower];
  // Prefix match
  for (const [key, price] of Object.entries(PRICING)) {
    if (lower.startsWith(key) || lower.includes(key)) return price;
  }
  return null;
}

/** Estimate cost from model name and token counts */
export function estimateCost(
  modelName: string | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!modelName) return null;
  const price = findModel(modelName);
  if (!price) return null;
  return (
    (inputTokens / 1_000_000) * price.input_per_1m +
    (outputTokens / 1_000_000) * price.output_per_1m
  );
}

/** Get all known model names (for display) */
export function getKnownModels(): string[] {
  return Object.keys(PRICING);
}

/** Check if a model name is recognized */
export function isKnownModel(modelName: string): boolean {
  return findModel(modelName) !== null;
}
