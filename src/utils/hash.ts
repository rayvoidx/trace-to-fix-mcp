import { createHash } from "node:crypto";

export function fingerprint(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => p ?? "?")
    .join("|");
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function clusterId(fp: string): string {
  return `fc_${shortHash(fp)}`;
}
