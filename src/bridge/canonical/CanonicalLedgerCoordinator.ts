import type {
  CanonicalThreadEventRecord,
  CanonicalEventKind,
  CanonicalEventSource,
  ChildThreadAnchorRecord,
  RetainedTurnRecord
} from "../../domain.js";
import { compareTurnCursor } from "../mirrorCursors.js";
import type { BridgeRuntimeContext } from "../runtime/BridgeRuntimeContext.js";
import type { BridgeRuntimeState } from "../runtime/BridgeRuntimeState.js";

interface RememberRetainedTurnInput {
  threadId: string;
  turnId: string | null;
  turnCursor: string | null;
  anchorItemId: string | null;
  anchorText: string | null;
  source: RetainedTurnRecord["source"];
}

export class CanonicalLedgerCoordinator {
  constructor(
    private readonly context: BridgeRuntimeContext,
    private readonly runtime: BridgeRuntimeState
  ) {}

  listRetainedTurns(threadId: string): RetainedTurnRecord[] {
    this.ensureRetainedTurnsHydrated(threadId);
    const byKey = this.runtime.retainedTurnsByThread.get(threadId);
    if (!byKey) {
      return [];
    }
    return [...byKey.values()].sort((left, right) => this.compareRetainedTurns(left, right));
  }

  hasRetainedTurn(threadId: string): boolean {
    return this.listRetainedTurns(threadId).length > 0;
  }

  rememberRetainedTurn(input: RememberRetainedTurnInput): void {
    const turnKey = this.buildTurnKey(input.turnId, input.turnCursor);
    if (!turnKey) {
      return;
    }
    this.ensureRetainedTurnsHydrated(input.threadId);
    const incomingAliases = this.buildTurnAliases(input.turnId, input.turnCursor);
    const byKey = this.runtime.retainedTurnsByThread.get(input.threadId) ?? new Map<string, RetainedTurnRecord>();
    const existing = [...byKey.values()].find((record) =>
      this.turnAliasesOverlap(this.buildTurnAliases(record.turnId, record.turnCursor), incomingAliases)
    );
    const record: RetainedTurnRecord = {
      threadId: input.threadId,
      turnKey: existing?.turnKey ?? turnKey,
      turnId: input.turnId?.trim() || null,
      turnCursor: input.turnCursor?.trim() || null,
      anchorItemId: input.anchorItemId?.trim() || null,
      anchorText: input.anchorText?.trim() || null,
      source: input.source,
      updatedAt: new Date().toISOString()
    };
    this.context.stateStore.upsertRetainedTurn(record);
    byKey.set(record.turnKey, record);
    this.runtime.retainedTurnsByThread.set(input.threadId, byKey);
    this.pruneRetainedTurns(input.threadId);
  }

  getChildThreadAnchor(childThreadId: string): ChildThreadAnchorRecord | null {
    const normalizedThreadId = childThreadId.trim();
    if (!normalizedThreadId) {
      return null;
    }
    const cached = this.runtime.childThreadAnchors.get(normalizedThreadId);
    if (cached) {
      return cached;
    }
    const persisted = this.context.stateStore.getChildThreadAnchor(normalizedThreadId) ?? null;
    if (persisted) {
      this.runtime.childThreadAnchors.set(normalizedThreadId, persisted);
      return persisted;
    }
    return null;
  }

  listChildThreadAnchorsForParent(parentThreadId: string): ChildThreadAnchorRecord[] {
    const anchors = this.context.stateStore.listChildThreadAnchorsForParent(parentThreadId);
    for (const anchor of anchors) {
      this.runtime.childThreadAnchors.set(anchor.childThreadId, anchor);
    }
    return anchors;
  }

  upsertChildThreadAnchor(record: Omit<ChildThreadAnchorRecord, "updatedAt">): ChildThreadAnchorRecord {
    const normalized: ChildThreadAnchorRecord = {
      ...record,
      childThreadId: record.childThreadId.trim(),
      parentThreadId: record.parentThreadId.trim(),
      parentTurnId: record.parentTurnId?.trim() || null,
      parentTurnCursor: record.parentTurnCursor?.trim() || null,
      updatedAt: new Date().toISOString()
    };
    if (!normalized.childThreadId || !normalized.parentThreadId) {
      throw new Error("Child thread anchors require both child and parent thread ids.");
    }
    this.context.stateStore.upsertChildThreadAnchor(normalized);
    this.runtime.childThreadAnchors.set(normalized.childThreadId, normalized);
    return normalized;
  }

  deleteChildThreadAnchor(childThreadId: string): void {
    const normalizedThreadId = childThreadId.trim();
    if (!normalizedThreadId) {
      return;
    }
    this.context.stateStore.deleteChildThreadAnchor(normalizedThreadId);
    this.runtime.childThreadAnchors.delete(normalizedThreadId);
    this.runtime.childThreadAnchorHints.delete(normalizedThreadId);
  }

  appendCanonicalEvent(input: {
    threadId: string;
    source: CanonicalEventSource;
    eventKind: CanonicalEventKind;
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    requestId?: string | null;
    summary?: string | null;
    detail?: string | null;
    createdAt?: string | null;
  }): void {
    const record: Omit<CanonicalThreadEventRecord, "id"> = {
      threadId: input.threadId,
      source: input.source,
      eventKind: input.eventKind,
      itemKind: input.itemKind ?? null,
      turnId: input.turnId ?? null,
      turnCursor: input.turnCursor ?? null,
      itemId: input.itemId ?? null,
      requestId: input.requestId ?? null,
      summary: input.summary ?? null,
      detail: input.detail ?? null,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    if (this.shouldDedupeStableCanonicalEvent(record)) {
      this.context.stateStore.appendCanonicalThreadEventIfNew(record);
      return;
    }
    this.context.stateStore.appendCanonicalThreadEvent(record);
  }

  recordIgnoredHint(input: {
    threadId: string;
    source: Exclude<CanonicalEventSource, "session" | "desktop-ipc">;
    itemKind?: string | null;
    turnId?: string | null;
    turnCursor?: string | null;
    itemId?: string | null;
    summary: string;
    reason: string;
  }): void {
    this.appendCanonicalEvent({
      threadId: input.threadId,
      source: input.source,
      eventKind: "ignoredHint",
      itemKind: input.itemKind ?? null,
      turnId: input.turnId ?? null,
      turnCursor: input.turnCursor ?? null,
      itemId: input.itemId ?? null,
      summary: input.summary,
      detail: input.reason
    });
  }

  private ensureRetainedTurnsHydrated(threadId: string): void {
    if (this.runtime.retainedTurnsByThread.has(threadId)) {
      return;
    }
    const persisted = this.context.stateStore.listRetainedTurns(threadId);
    const byKey = new Map<string, RetainedTurnRecord>();
    for (const record of persisted) {
      byKey.set(record.turnKey, record);
    }
    this.runtime.retainedTurnsByThread.set(threadId, byKey);
  }

  private pruneRetainedTurns(threadId: string): void {
    const maxTurns = Math.max(1, this.context.runtimeConfig.retention.maxTurnsPerThread);
    const records = this.listRetainedTurns(threadId);
    if (records.length <= maxTurns) {
      return;
    }
    const remove = records.slice(0, Math.max(0, records.length - maxTurns));
    const byKey = this.runtime.retainedTurnsByThread.get(threadId);
    for (const record of remove) {
      this.context.stateStore.deleteRetainedTurn(threadId, record.turnKey);
      byKey?.delete(record.turnKey);
    }
  }

  private compareRetainedTurns(left: RetainedTurnRecord, right: RetainedTurnRecord): number {
    if (left.turnCursor && right.turnCursor) {
      return compareTurnCursor(left.turnCursor, right.turnCursor, {
        extractUuidV7TimestampMs: () => null
      });
    }
    if (left.turnCursor && !right.turnCursor) {
      return 1;
    }
    if (!left.turnCursor && right.turnCursor) {
      return -1;
    }
    return left.turnKey.localeCompare(right.turnKey);
  }

  private buildTurnKey(turnId: string | null, turnCursor: string | null): string | null {
    const normalizedTurnId = turnId?.trim() || null;
    if (normalizedTurnId) {
      return `turn:${normalizedTurnId.toLowerCase()}`;
    }
    const normalizedCursor = turnCursor?.trim() || null;
    if (normalizedCursor) {
      return `cursor:${normalizedCursor}`;
    }
    return null;
  }

  private buildTurnAliases(turnId: string | null, turnCursor: string | null): Set<string> {
    const aliases = new Set<string>();
    const turnKey = this.buildTurnKey(turnId, turnCursor);
    if (turnKey) {
      aliases.add(turnKey);
    }
    const normalizedTurnId = turnId?.trim() || null;
    if (normalizedTurnId) {
      aliases.add(`turn:${normalizedTurnId.toLowerCase()}`);
    }
    const normalizedTurnCursor = turnCursor?.trim() || null;
    if (normalizedTurnCursor) {
      aliases.add(`cursor:${normalizedTurnCursor}`);
    }
    return aliases;
  }

  private turnAliasesOverlap(left: Set<string>, right: Set<string>): boolean {
    for (const alias of left) {
      if (right.has(alias)) {
        return true;
      }
    }
    return false;
  }

  private shouldDedupeStableCanonicalEvent(
    record: Omit<CanonicalThreadEventRecord, "id">
  ): boolean {
    if (record.source !== "session") {
      return false;
    }
    return Boolean(record.itemId?.trim() || record.requestId?.trim());
  }
}
