import { readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

interface ExtractNestedStringOptions {
  allowArrays?: boolean;
  trimResult?: boolean;
}

export function extractNestedString(
  source: Record<string, unknown>,
  pathSegments: string[],
  options: ExtractNestedStringOptions = {}
): string | null {
  const { allowArrays = false, trimResult = true } = options;
  let current: unknown = source;

  for (const segment of pathSegments) {
    if (
      !current ||
      typeof current !== "object" ||
      (!allowArrays && Array.isArray(current))
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== "string") {
    return null;
  }

  const normalized = current.trim();
  if (!normalized) {
    return null;
  }

  return trimResult ? normalized : current;
}

export function findNewestStateDatabasePath(codexHome: string): string | null {
  try {
    const entries = readdirSync(codexHome, { withFileTypes: true }) as Array<{
      isFile: () => boolean;
      name: string;
    }>;
    const candidates = entries
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
      .map((entry) => path.join(codexHome, entry.name))
      .sort((left, right) => right.localeCompare(left));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
