const PII_PATTERNS = [
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, // email
  /\b\d{3}[-.]?\d{3,4}[-.]?\d{4}\b/g, // phone
  /\bsk-[a-zA-Z0-9]{20,}\b/g, // API keys
  /\bghp_[a-zA-Z0-9]{36,}\b/g, // GitHub tokens
];

export function redactString(input: string): string {
  let result = input;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function redactObject<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: string[] = ["input", "output", "body", "prompt"],
): T {
  const clone = { ...obj } as Record<string, unknown>;
  for (const key of sensitiveKeys) {
    if (typeof clone[key] === "string") {
      clone[key] = redactString(clone[key] as string);
    }
  }
  return clone as T;
}
