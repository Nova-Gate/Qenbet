const CREDENTIAL_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]+\b/,
  /\bgh[pousr]_[A-Za-z0-9]+\b/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\bxox[abeprs]-[A-Za-z0-9-]+\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhf_[A-Za-z0-9]{34}\b/,
];

const REDACTIONS = [
  ...CREDENTIAL_PATTERNS.filter((pattern) => !pattern.source.includes("PRIVATE KEY")).map((pattern) => [new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[REDACTED]"]),
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password|credential)["']?\s*[:=]\s*["']?)[^"',\s;}]+/gi, "$1[REDACTED]"],
];

export function looksLikeCredential(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactError(value) {
  let text = typeof value === "string" ? value : String(value ?? "Unknown error");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.slice(0, 16_000);
}
