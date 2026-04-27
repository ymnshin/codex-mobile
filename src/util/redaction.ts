const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(?:proj|live|test)-[A-Za-z0-9_-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40})\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,})\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s"']+/gi,
  /\bX-Api-Key\s*:\s*[^\s"']+/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+["']?/gi,
  /\b[A-Fa-f0-9]{32,}\b/g
];

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gi;
const ENV_ASSIGNMENT_PATTERN = /\b[A-Z][A-Z0-9_]{1,}\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
const AUTH_PATH_PATTERN = /(?:[A-Za-z]:\\|\/)?[^"'`\s]*\.codex[\\/]+auth\.json/gi;
const BASIC_AUTH_PATTERN = /\b[A-Za-z0-9._%+-]+:[^@\s]+@/g;
const COOKIE_HEADER_PATTERN = /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi;
const SENSITIVE_KEY_FRAGMENT =
  "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|session(?:id)?|cookie|authorization|x[_-]?api[_-]?key|client[_-]?secret|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)";
const QUOTED_SECRET_KEY_VALUE_PATTERN =
  new RegExp(
    `((["'])${SENSITIVE_KEY_FRAGMENT}\\2\\s*:\\s*)(["'])([^"'\\\\]*(?:\\\\.[^"'\\\\]*)*)\\3`,
    "gi"
  );
const SENSITIVE_ASSIGNMENT_PATTERN =
  new RegExp(`\\b${SENSITIVE_KEY_FRAGMENT}\\b\\s*[:=]\\s*("[^"]*"|'[^']*'|[^\\s;,\\]}]+)`, "gi");
const STACK_TRACE_PATTERN = /(?:^|\n)\s*at\s+[^\n]+/g;

export function redactSensitiveText(input: string | null | undefined): string {
  if (!input) {
    return "";
  }

  let sanitized = input;

  sanitized = sanitized.replace(PRIVATE_KEY_BLOCK_PATTERN, "[redacted private key block]");
  sanitized = sanitized.replace(AUTH_PATH_PATTERN, "[redacted ~/.codex/auth.json]");
  sanitized = sanitized.replace(BASIC_AUTH_PATTERN, "[redacted credentials]@");
  sanitized = sanitized.replace(COOKIE_HEADER_PATTERN, "[redacted cookie header]");
  sanitized = sanitized.replace(
    QUOTED_SECRET_KEY_VALUE_PATTERN,
    (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
      `${prefix}${valueQuote}[redacted]${valueQuote}`
  );
  sanitized = sanitized.replace(SENSITIVE_ASSIGNMENT_PATTERN, (match) => {
    const separator = match.includes("=") ? "=" : ":";
    const [key] = match.split(separator, 1);
    return `${key}${separator}[redacted]`;
  });
  sanitized = sanitized.replace(ENV_ASSIGNMENT_PATTERN, (match) => {
    const separator = match.includes("=") ? "=" : ":";
    const [key] = match.split(separator, 1);
    return `${key}${separator}[redacted]`;
  });

  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }

  sanitized = sanitized.replace(STACK_TRACE_PATTERN, "\n[redacted stack frame]");

  return sanitized;
}

export function truncateForDiscord(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function escapeDiscordInlineCode(input: string): string {
  return input.replace(/`/g, "'").replace(/\r?\n/g, " ");
}
