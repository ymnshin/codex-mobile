export const LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV = "CODEX_MOBILE_LIVE_E2E_IGNORE_HELPER_COMMANDS";

function envFlagEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function shouldIgnoreLiveE2eHelperCommand(
  commandText: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!envFlagEnabled(env[LIVE_E2E_IGNORE_HELPER_COMMANDS_ENV])) {
    return false;
  }

  const normalized = String(commandText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\bnpm(?:\.cmd)?\s+run\s+e2e-live\b/.test(normalized) ||
    /scripts[\\/]+e2e-live\.cjs/.test(normalized) ||
    isLiveE2eWaitCommand(normalized)
  );
}

function isLiveE2eWaitCommand(normalizedCommand: string): boolean {
  return (
    /^start-sleep(?:\s+(?:-seconds|-s|-milliseconds|-m))?\s+\d+(?:\.\d+)?$/.test(normalizedCommand) ||
    /^sleep\s+\d+(?:\.\d+)?$/.test(normalizedCommand) ||
    /^timeout(?:\.exe)?(?:\s+\/t)?\s+\d+(?:\s+\/nobreak)?$/.test(normalizedCommand)
  );
}
