export interface ParsedCommand {
  command: string;
  args: string[];
}

export function parseCommandString(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("CODEX_COMMAND cannot be empty.");
  }

  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed.charAt(index);

    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }

    if (!quote && /\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new Error(`Unterminated quote in command: ${input}`);
  }

  if (current) {
    parts.push(current);
  }

  const [command, ...args] = parts;
  if (!command) {
    throw new Error("Failed to parse CODEX_COMMAND.");
  }

  return { command, args };
}
