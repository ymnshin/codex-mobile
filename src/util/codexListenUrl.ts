export type CodexListenUrlMode = "bridge-service" | "local-control";
export const DEFAULT_LOCAL_APP_SERVER_LISTEN_URL = "ws://127.0.0.1:8837";

export function resolveCodexListenUrl(
  configuredListenUrl: string,
  mode: CodexListenUrlMode
): string {
  return mode === "bridge-service" ? configuredListenUrl : "stdio://";
}
