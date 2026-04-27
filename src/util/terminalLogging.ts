function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTerminalTimestamp(at: Date = new Date()): string {
  return `${padTimePart(at.getHours())}:${padTimePart(at.getMinutes())}:${padTimePart(at.getSeconds())}`;
}

export function withLogScope(scope: string, message: string): string {
  const normalizedScope = scope.trim();
  return normalizedScope.length > 0 ? `[${normalizedScope}] ${message}` : message;
}

export function formatTerminalLogLine(prefix: string, message: string, at: Date = new Date()): string {
  return `[${formatTerminalTimestamp(at)}] [${prefix}] ${message}`;
}
