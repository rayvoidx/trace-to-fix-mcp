/**
 * Langfuse Prompts Write Adapter
 *
 * 프롬프트 버전 생성, 라벨 관리.
 * Langfuse API v2: POST /api/public/v2/prompts
 */
import { lfGet, lfPost } from "./client.js";
import { logger } from "../../utils/logger.js";

export interface LfPromptVersion {
  name: string;
  version: number;
  prompt: string | unknown[];
  type: "text" | "chat";
  labels: string[];
  config: Record<string, unknown>;
}

export interface CreatePromptInput {
  name: string;
  type: "text" | "chat";
  prompt: string | unknown[];
  labels?: string[];
  config?: Record<string, unknown>;
}

export interface ListPromptsResponse {
  data: LfPromptVersion[];
  meta: { page: number; limit: number; totalItems: number; totalPages: number };
}

/** List all prompts */
export async function listPrompts(
  page = 1,
  limit = 50,
): Promise<ListPromptsResponse> {
  return lfGet<ListPromptsResponse>("/v2/prompts", {
    page: String(page),
    limit: String(limit),
  });
}

/** Get a specific prompt by name and optional version/label */
export async function getPrompt(
  name: string,
  opts?: { version?: number; label?: string },
): Promise<LfPromptVersion> {
  const params: Record<string, string> = {};
  if (opts?.version != null) params.version = String(opts.version);
  if (opts?.label) params.label = opts.label;
  return lfGet<LfPromptVersion>(`/v2/prompts/${encodeURIComponent(name)}`, params);
}

/** Create a new prompt version */
export async function createPromptVersion(
  input: CreatePromptInput,
): Promise<LfPromptVersion> {
  logger.info({ name: input.name, type: input.type }, "Creating new prompt version");

  const body: Record<string, unknown> = {
    name: input.name,
    type: input.type,
    prompt: input.prompt,
  };
  if (input.labels) body.labels = input.labels;
  if (input.config) body.config = input.config;

  return lfPost<LfPromptVersion>("/v2/prompts", body);
}

/** Update labels on a specific prompt version */
export async function updatePromptLabels(
  name: string,
  version: number,
  labels: string[],
): Promise<LfPromptVersion> {
  logger.info({ name, version, labels }, "Updating prompt labels");

  const url = `${process.env.LANGFUSE_BASE_URL?.replace(/\/+$/, "")}/api/public/v2/prompts/${encodeURIComponent(name)}/versions/${version}`;
  const pub = process.env.LANGFUSE_PUBLIC_KEY!;
  const sec = process.env.LANGFUSE_SECRET_KEY!;
  const auth = `Basic ${Buffer.from(`${pub}:${sec}`).toString("base64")}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ newLabels: labels }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Langfuse API PATCH ${res.status}: ${text}`);
  }

  return res.json() as Promise<LfPromptVersion>;
}

/** Promote a prompt version to production (add "production" label) */
export async function promoteToProduction(
  name: string,
  version: number,
): Promise<LfPromptVersion> {
  return updatePromptLabels(name, version, ["production"]);
}
