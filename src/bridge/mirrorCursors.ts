export interface ParsedMirrorCursor {
  raw: string;
  timestampMs: number | null;
  orderKey: number | null;
  kindRank: number;
  sourceOrder: string | null;
  sourceEventKey: string | null;
}

export interface ParsedTurnCursor {
  raw: string;
  timestampMs: number | null;
  kindRank: number;
}

interface CursorDependencies {
  extractUuidV7TimestampMs(value: string): number | null;
}

export function parseItemCursor(
  cursor: string,
  dependencies: CursorDependencies
): ParsedMirrorCursor {
  const sessionMatch = cursor.match(/^session:([0-9]{16}:[0-9]{4}):(.+)$/);
  if (sessionMatch) {
    return {
      raw: cursor,
      timestampMs: null,
      orderKey: null,
      kindRank: 5,
      sourceOrder: sessionMatch[1] ?? null,
      sourceEventKey: sessionMatch[2] ?? null
    };
  }

  const numericMatch = cursor.match(/^(\d{16}):(\d{1,16})(?::|$)/);
  if (numericMatch) {
    return {
      raw: cursor,
      timestampMs: Number.parseInt(numericMatch[1] ?? "", 10),
      orderKey: Number.parseInt(numericMatch[2] ?? "", 10),
      kindRank: 4,
      sourceOrder: null,
      sourceEventKey: null
    };
  }

  const turnMatch = cursor.match(/^turn:([^:]+)(?::(\d{1,16}))?/);
  if (turnMatch) {
    const turnId = turnMatch[1] ?? "";
    const turnTimestampMs = dependencies.extractUuidV7TimestampMs(turnId);
    const orderKey = turnMatch[2] ? Number.parseInt(turnMatch[2], 10) : null;
    return {
      raw: cursor,
      timestampMs: turnTimestampMs,
      orderKey,
      kindRank: turnTimestampMs !== null ? 3 : 1,
      sourceOrder: null,
      sourceEventKey: null
    };
  }

  const itemMatch = cursor.match(/^item:(\d{1,16})/);
  if (itemMatch) {
    return {
      raw: cursor,
      timestampMs: null,
      orderKey: Number.parseInt(itemMatch[1] ?? "", 10),
      kindRank: 2,
      sourceOrder: null,
      sourceEventKey: null
    };
  }

  const itemOrderMatch = cursor.match(/^item-order:(\d{1,16})/);
  if (itemOrderMatch) {
    return {
      raw: cursor,
      timestampMs: null,
      orderKey: Number.parseInt(itemOrderMatch[1] ?? "", 10),
      kindRank: 0,
      sourceOrder: null,
      sourceEventKey: null
    };
  }

  return {
    raw: cursor,
    timestampMs: null,
    orderKey: null,
    kindRank: 0,
    sourceOrder: null,
    sourceEventKey: null
  };
}

export function parseTurnCursor(
  cursor: string,
  dependencies: CursorDependencies
): ParsedTurnCursor {
  const numericMatch = cursor.match(/^(\d{16}):/);
  if (numericMatch) {
    return {
      raw: cursor,
      timestampMs: Number.parseInt(numericMatch[1] ?? "", 10),
      kindRank: 3
    };
  }

  const turnMatch = cursor.match(/^turn:([^:]+)/);
  if (turnMatch) {
    const turnTimestampMs = dependencies.extractUuidV7TimestampMs(turnMatch[1] ?? "");
    return {
      raw: cursor,
      timestampMs: turnTimestampMs,
      kindRank: turnTimestampMs !== null ? 2 : 1
    };
  }

  const turnOrderMatch = cursor.match(/^turn-order:(\d{1,16})/);
  if (turnOrderMatch) {
    return {
      raw: cursor,
      timestampMs: Number.parseInt(turnOrderMatch[1] ?? "", 10),
      kindRank: 0
    };
  }

  return {
    raw: cursor,
    timestampMs: null,
    kindRank: 0
  };
}

export function compareItemCursor(
  left: string,
  right: string,
  dependencies: CursorDependencies
): number {
  if (left === right) {
    return 0;
  }

  const parsedLeft = parseItemCursor(left, dependencies);
  const parsedRight = parseItemCursor(right, dependencies);

  if (parsedLeft.sourceOrder !== null || parsedRight.sourceOrder !== null) {
    if (parsedLeft.sourceOrder !== null && parsedRight.sourceOrder === null) {
      return 1;
    }
    if (parsedLeft.sourceOrder === null && parsedRight.sourceOrder !== null) {
      return -1;
    }
    if (parsedLeft.sourceOrder !== parsedRight.sourceOrder) {
      return (parsedLeft.sourceOrder ?? "").localeCompare(parsedRight.sourceOrder ?? "");
    }
    if (parsedLeft.sourceEventKey !== parsedRight.sourceEventKey) {
      return (parsedLeft.sourceEventKey ?? "").localeCompare(parsedRight.sourceEventKey ?? "");
    }
    return parsedLeft.raw.localeCompare(parsedRight.raw);
  }

  if (parsedLeft.timestampMs !== null || parsedRight.timestampMs !== null) {
    if (parsedLeft.timestampMs !== null && parsedRight.timestampMs === null) {
      return 1;
    }
    if (parsedLeft.timestampMs === null && parsedRight.timestampMs !== null) {
      return -1;
    }
    if (parsedLeft.timestampMs !== parsedRight.timestampMs) {
      return (parsedLeft.timestampMs ?? 0) - (parsedRight.timestampMs ?? 0);
    }
    if (parsedLeft.orderKey !== null || parsedRight.orderKey !== null) {
      if (parsedLeft.orderKey !== null && parsedRight.orderKey === null) {
        return 1;
      }
      if (parsedLeft.orderKey === null && parsedRight.orderKey !== null) {
        return -1;
      }
      if (parsedLeft.orderKey !== parsedRight.orderKey) {
        return (parsedLeft.orderKey ?? 0) - (parsedRight.orderKey ?? 0);
      }
    }
    return parsedLeft.raw.localeCompare(parsedRight.raw);
  }

  if (parsedLeft.kindRank !== parsedRight.kindRank) {
    return parsedLeft.kindRank - parsedRight.kindRank;
  }
  if (parsedLeft.orderKey !== null || parsedRight.orderKey !== null) {
    if (parsedLeft.orderKey !== null && parsedRight.orderKey === null) {
      return 1;
    }
    if (parsedLeft.orderKey === null && parsedRight.orderKey !== null) {
      return -1;
    }
    if (parsedLeft.orderKey !== parsedRight.orderKey) {
      return (parsedLeft.orderKey ?? 0) - (parsedRight.orderKey ?? 0);
    }
  }
  return parsedLeft.raw.localeCompare(parsedRight.raw);
}

export function compareTurnCursor(
  left: string,
  right: string,
  dependencies: CursorDependencies
): number {
  if (left === right) {
    return 0;
  }

  const parsedLeft = parseTurnCursor(left, dependencies);
  const parsedRight = parseTurnCursor(right, dependencies);

  if (parsedLeft.timestampMs !== null || parsedRight.timestampMs !== null) {
    if (parsedLeft.timestampMs !== null && parsedRight.timestampMs === null) {
      return 1;
    }
    if (parsedLeft.timestampMs === null && parsedRight.timestampMs !== null) {
      return -1;
    }
    if (parsedLeft.timestampMs !== parsedRight.timestampMs) {
      return (parsedLeft.timestampMs ?? 0) - (parsedRight.timestampMs ?? 0);
    }
    return parsedLeft.raw.localeCompare(parsedRight.raw);
  }

  if (parsedLeft.kindRank !== parsedRight.kindRank) {
    return parsedLeft.kindRank - parsedRight.kindRank;
  }
  return parsedLeft.raw.localeCompare(parsedRight.raw);
}
