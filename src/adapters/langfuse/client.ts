import Langfuse from "langfuse";
import { logger } from "../../utils/logger.js";

let instance: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (instance) return instance;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set",
    );
  }

  instance = new Langfuse({ publicKey, secretKey, baseUrl });
  logger.info({ baseUrl }, "Langfuse client initialized");
  return instance;
}

// ─── REST helpers (Langfuse Public API) ────────────────────────────

function authHeader(): string {
  const pub = process.env.LANGFUSE_PUBLIC_KEY!;
  const sec = process.env.LANGFUSE_SECRET_KEY!;
  return `Basic ${Buffer.from(`${pub}:${sec}`).toString("base64")}`;
}

function baseUrl(): string {
  return (
    process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
}

export async function lfGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${baseUrl()}/api/public${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Langfuse API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export async function lfPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}/api/public${path}`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Langfuse API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
