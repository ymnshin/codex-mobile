import type { SessionBackfillEvent } from "../codex/CodexSessionEventTailer.js";
import { isConversationUserAnchorText, parseUserEnvelope } from "../util/userEnvelopes.js";

export interface StartupMirrorCandidate {
  turnId: string | null;
  turnCursor: string | null;
  turnOrder: number;
  kind: "user" | "agentCommentary" | "agentAnswer" | "command" | "fileChange";
}

export interface StartupBackfillDisplayBudgetConfig {
  leadingEventBudget: number;
  trailingEventBudget: number;
}

export interface StartupBackfillGapNotice {
  turnId: string | null;
  turnCursor: string | null;
  skippedCount: number;
  hasTrailingRetainedEvents: boolean;
}

export type StartupSessionBackfillDisplayEntry =
  | { kind: "event"; event: SessionBackfillEvent }
  | { kind: "notice"; notice: StartupBackfillGapNotice };

export type StartupCandidateDisplayEntry<T extends StartupMirrorCandidate = StartupMirrorCandidate> =
  | { kind: "candidate"; candidate: T }
  | { kind: "notice"; notice: StartupBackfillGapNotice };

interface StartupSelectionDependencies {
  extractTurnBaseTimestampMs(turn: unknown): number | null;
  extractTurnItems(turn: unknown): unknown[];
  extractTurnStatus(turn: unknown): string | null;
  countUserMessagesInTurn(threadId: string, turn: unknown): number;
  isSyntheticOnlyConversationTurn(threadId: string, turn: unknown): boolean;
  compareChronology(
    leftTimestampMs: number | null,
    leftIndex: number,
    rightTimestampMs: number | null,
    rightIndex: number
  ): number;
  mirroredTurnKey(turnId: string | null, turnCursor: string | null): string | null;
  buildTurnCursor(turn: unknown, turnOrder: number): string | null;
  resolveChannelKind(threadId: string): "conversation" | "subagent";
}

export function selectRecentCompletedTurns(
  turns: unknown[] | undefined,
  dependencies: StartupSelectionDependencies
): unknown[] {
  const entries = Array.isArray(turns) ? turns : [];
  const completed = entries
    .map((turn, index) => ({
      turn,
      index,
      timestampMs: dependencies.extractTurnBaseTimestampMs(turn)
    }))
    .filter(
      ({ turn }) =>
        dependencies.extractTurnItems(turn).length > 0 &&
        dependencies.extractTurnStatus(turn) !== "inProgress"
    )
    .sort((left, right) =>
      dependencies.compareChronology(left.timestampMs, left.index, right.timestampMs, right.index)
    );

  return completed.map((entry) => entry.turn);
}

export function selectRecentConversationTurns(
  threadId: string,
  turns: unknown[] | undefined,
  dependencies: StartupSelectionDependencies
): unknown[] {
  return selectRecentSyncableTurns(threadId, turns, dependencies).filter(
    (turn) => dependencies.countUserMessagesInTurn(threadId, turn) > 0
  );
}

export function selectRecentSyncableTurns(
  threadId: string,
  turns: unknown[] | undefined,
  dependencies: StartupSelectionDependencies
): unknown[] {
  const entries = Array.isArray(turns) ? turns : [];
  return entries
    .map((turn, index) => ({
      turn,
      index,
      timestampMs: dependencies.extractTurnBaseTimestampMs(turn)
    }))
    .filter(({ turn }) => !dependencies.isSyntheticOnlyConversationTurn(threadId, turn))
    .filter(({ turn }) => dependencies.extractTurnItems(turn).length > 0)
    .sort((left, right) =>
      dependencies.compareChronology(left.timestampMs, left.index, right.timestampMs, right.index)
    )
    .map((entry) => entry.turn);
}

export function selectInitialContextTurns(
  threadId: string,
  turns: unknown[] | undefined,
  keepCount: number,
  dependencies: StartupSelectionDependencies
): unknown[] {
  const effectiveKeepCount = Math.max(1, keepCount);
  const recentConversationTurns = selectRecentConversationTurns(threadId, turns, dependencies);
  if (recentConversationTurns.length > 0) {
    return recentConversationTurns.slice(-effectiveKeepCount);
  }
  return [];
}

export function buildStartupSessionBackfillDisplayEntries(
  events: SessionBackfillEvent[],
  budgets: StartupBackfillDisplayBudgetConfig
): StartupSessionBackfillDisplayEntry[] {
  const groups = groupEntriesByTurn(events, (event, index) => event.turnId ?? `event:${index}`, (event) => ({
    turnId: event.turnId ?? null,
    turnCursor: null
  }));
  const displayEntries: StartupSessionBackfillDisplayEntry[] = [];
  for (const group of groups) {
    const truncated = buildBudgetedTurnItems(group.items, budgets, {
      isAnchor: isSessionBackfillConversationAnchor,
      alwaysKeep: isStructuralSessionBackfillEvent,
      weightUnits: sessionBackfillEventWeightUnits
    });
    for (const entry of truncated) {
      if (entry.kind === "item") {
        displayEntries.push({ kind: "event", event: entry.item });
      } else {
        displayEntries.push({
          kind: "notice",
          notice: {
            turnId: group.turnId,
            turnCursor: group.turnCursor,
            skippedCount: entry.skippedCount,
            hasTrailingRetainedEvents: entry.hasTrailingRetainedItems
          }
        });
      }
    }
  }
  return displayEntries;
}

export function buildStartupCandidateDisplayEntries<T extends StartupMirrorCandidate>(
  candidates: T[],
  budgets: StartupBackfillDisplayBudgetConfig
): StartupCandidateDisplayEntry<T>[] {
  const groups = groupEntriesByTurn(
    candidates,
    (candidate, index) =>
      candidate.turnCursor ??
      candidate.turnId ??
      `turn-order:${candidate.turnOrder}:${index}`,
    (candidate) => ({
      turnId: candidate.turnId ?? null,
      turnCursor: candidate.turnCursor ?? null
    })
  );
  const displayEntries: StartupCandidateDisplayEntry<T>[] = [];
  for (const group of groups) {
    const truncated = buildBudgetedTurnItems<T>(group.items, budgets, {
      isAnchor: (candidate) => candidate.kind === "user",
      weightUnits: startupCandidateWeightUnits
    });
    for (const entry of truncated) {
      if (entry.kind === "item") {
        displayEntries.push({ kind: "candidate", candidate: entry.item });
      } else {
        displayEntries.push({
          kind: "notice",
          notice: {
            turnId: group.turnId,
            turnCursor: group.turnCursor,
            skippedCount: entry.skippedCount,
            hasTrailingRetainedEvents: entry.hasTrailingRetainedItems
          }
        });
      }
    }
  }
  return displayEntries;
}

export function trimInitialContextCandidatesToConversationAnchor(
  threadId: string,
  candidates: StartupMirrorCandidate[],
  dependencies: StartupSelectionDependencies
): StartupMirrorCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }

  const isSubagent = dependencies.resolveChannelKind(threadId) === "subagent";
  if (isSubagent) {
    const firstCodexIndex = candidates.findIndex((candidate) => candidate.kind !== "user");
    const anchorIndex =
      firstCodexIndex >= 0
        ? findLastUserCandidateBeforeIndex(candidates, null, firstCodexIndex, dependencies)
        : findLastUserCandidateBeforeIndex(candidates, null, candidates.length, dependencies);
    if (anchorIndex <= 0) {
      return candidates;
    }
    return candidates.slice(anchorIndex);
  }

  const firstCandidate = candidates[0];
  const oldestTurnKey = firstCandidate
    ? dependencies.mirroredTurnKey(
        firstCandidate.turnId ?? null,
        firstCandidate.turnCursor ??
          dependencies.buildTurnCursor({ id: firstCandidate.turnId }, firstCandidate.turnOrder)
      )
    : null;
  if (!oldestTurnKey) {
    return candidates;
  }

  const anchorIndices = candidates
    .map((candidate, index) => {
      const candidateTurnKey = dependencies.mirroredTurnKey(
        candidate.turnId,
        candidate.turnCursor ?? dependencies.buildTurnCursor({ id: candidate.turnId }, candidate.turnOrder)
      );
      return candidateTurnKey === oldestTurnKey && candidate.kind === "user" ? index : -1;
    })
    .filter((index) => index >= 0);
  const anchorIndex = anchorIndices.length === 0 ? -1 : anchorIndices[0]!;
  if (anchorIndex <= 0) {
    return candidates;
  }

  return candidates.slice(anchorIndex);
}

export function trimSessionBackfillEventsToConversationAnchor(
  threadId: string,
  events: SessionBackfillEvent[],
  dependencies: StartupSelectionDependencies
): SessionBackfillEvent[] {
  if (events.length === 0) {
    return events;
  }

  const isSubagent = dependencies.resolveChannelKind(threadId) === "subagent";
  const filteredEvents = isSubagent
    ? events
    : filterSyntheticSessionBackfillEvents(threadId, events);
  if (isSubagent) {
    const firstCodexIndex = filteredEvents.findIndex((event) => event.type !== "sessionUserMessage");
    const anchorIndex =
      firstCodexIndex >= 0
        ? findLastUserBackfillEventBeforeIndex(filteredEvents, null, firstCodexIndex)
        : findLastUserBackfillEventBeforeIndex(filteredEvents, null, filteredEvents.length);
    if (anchorIndex <= 0) {
      return filteredEvents;
    }
    return filteredEvents.slice(anchorIndex);
  }

  const oldestTurnId = filteredEvents[0]?.turnId ?? null;
  if (!oldestTurnId) {
    return filteredEvents;
  }

  const anchorIndices = filteredEvents
    .map((event, index) =>
      event.turnId === oldestTurnId &&
      isSessionBackfillConversationAnchor(event)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  const anchorIndex = anchorIndices.length === 0 ? -1 : anchorIndices[0]!;
  if (anchorIndex <= 0) {
    return filteredEvents;
  }

  return filteredEvents.slice(anchorIndex);
}

export function filterSyntheticSessionBackfillEvents(
  threadId: string,
  events: SessionBackfillEvent[]
): SessionBackfillEvent[] {
  const turnFlags = new Map<string, { hasSyntheticUser: boolean; hasRealUser: boolean }>();

  for (const event of events) {
    if (event.type !== "sessionUserMessage") {
      continue;
    }
    const turnKey = event.turnId ?? `session-turn:${threadId}`;
    const current = turnFlags.get(turnKey) ?? { hasSyntheticUser: false, hasRealUser: false };
    const envelope = parseUserEnvelope(event.text);
    if (event.isSyntheticSubagentInstruction || envelope?.kind === "subagentNotification") {
      current.hasSyntheticUser = true;
    } else if (isConversationUserAnchorText(event.text)) {
      current.hasRealUser = true;
    }
    turnFlags.set(turnKey, current);
  }

  const suppressedTurnKeys = new Set(
    [...turnFlags.entries()]
      .filter(([, flags]) => flags.hasSyntheticUser && !flags.hasRealUser)
      .map(([turnKey]) => turnKey)
  );

  if (suppressedTurnKeys.size === 0) {
    return events;
  }

  return events.filter((event) => !suppressedTurnKeys.has(event.turnId ?? `session-turn:${threadId}`));
}

export function findLastUserCandidateBeforeIndex(
  candidates: StartupMirrorCandidate[],
  turnKey: string | null,
  exclusiveUpperBound: number,
  dependencies: StartupSelectionDependencies
): number {
  let lastUserIndex = -1;
  for (let index = 0; index < Math.min(candidates.length, exclusiveUpperBound); index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const candidateTurnKey = dependencies.mirroredTurnKey(
      candidate.turnId,
      candidate.turnCursor ?? dependencies.buildTurnCursor({ id: candidate.turnId }, candidate.turnOrder)
    );
    if ((turnKey === null || candidateTurnKey === turnKey) && candidate.kind === "user") {
      lastUserIndex = index;
    }
  }
  return lastUserIndex;
}

export function findLastUserBackfillEventBeforeIndex(
  events: SessionBackfillEvent[],
  turnId: string | null,
  exclusiveUpperBound: number
): number {
  let lastUserIndex = -1;
  for (let index = 0; index < Math.min(events.length, exclusiveUpperBound); index += 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (
      (turnId === null || event.turnId === turnId) &&
      isSessionBackfillConversationAnchor(event)
    ) {
      lastUserIndex = index;
    }
  }
  return lastUserIndex;
}

function isSessionBackfillConversationAnchor(event: SessionBackfillEvent): boolean {
  return (
    event.type === "sessionUserMessage" &&
    !event.isSyntheticSubagentInstruction &&
    isConversationUserAnchorText(event.text)
  );
}

function isStructuralSessionBackfillEvent(event: SessionBackfillEvent): boolean {
  return event.type === "shellApprovalRequested" || event.type === "sessionSubagentSpawned";
}

function sessionBackfillEventWeightUnits(event: SessionBackfillEvent): number {
  return (
    event.type === "shellApprovalRequested" ||
    event.type === "shellCommandCompleted" ||
    event.type === "sessionApplyPatchCompleted"
  )
    ? 1
    : 2;
}

function startupCandidateWeightUnits(candidate: StartupMirrorCandidate): number {
  return candidate.kind === "command" || candidate.kind === "fileChange" ? 1 : 2;
}

function toBudgetUnits(value: number): number {
  return Math.max(0, Math.trunc(value)) * 2;
}

function buildBudgetedTurnItems<T>(
  items: T[],
  budgets: StartupBackfillDisplayBudgetConfig,
  options: {
    isAnchor(item: T): boolean;
    alwaysKeep?(item: T): boolean;
    weightUnits(item: T): number;
  }
): Array<{ kind: "item"; item: T } | { kind: "notice"; skippedCount: number; hasTrailingRetainedItems: boolean }> {
  if (items.length === 0) {
    return [];
  }

  const leadingBudgetUnits = toBudgetUnits(budgets.leadingEventBudget);
  const trailingBudgetUnits = toBudgetUnits(budgets.trailingEventBudget);
  const firstItem = items[0];
  const leadingAnchor = firstItem && options.isAnchor(firstItem) ? firstItem : null;
  const remainder = leadingAnchor ? items.slice(1) : items;
  if (remainder.length === 0) {
    return leadingAnchor ? [{ kind: "item", item: leadingAnchor }] : [];
  }

  const headCount = takeBudgetedHeadCount(remainder, leadingBudgetUnits, options.weightUnits);
  const tailStart = takeBudgetedTailStart(remainder, headCount, trailingBudgetUnits, options.weightUnits);
  const skippedCount = tailStart - headCount;
  if (skippedCount <= 0) {
    return [
      ...(leadingAnchor ? [{ kind: "item", item: leadingAnchor } as const] : []),
      ...remainder.map((item) => ({ kind: "item", item } as const))
    ];
  }

  const shouldAlwaysKeep = options.alwaysKeep ?? (() => false);
  const retainedEntries: Array<
    { kind: "item"; item: T } | { kind: "notice"; skippedCount: number; hasTrailingRetainedItems: boolean }
  > = [...(leadingAnchor ? [{ kind: "item" as const, item: leadingAnchor }] : [])];
  const keepFlags = remainder.map(
    (item, index) => index < headCount || index >= tailStart || shouldAlwaysKeep(item)
  );
  let skippedRangeCount = 0;
  const flushSkippedRange = (hasTrailingRetainedItems: boolean): void => {
    if (skippedRangeCount <= 0) {
      return;
    }
    retainedEntries.push({
      kind: "notice",
      skippedCount: skippedRangeCount,
      hasTrailingRetainedItems
    });
    skippedRangeCount = 0;
  };

  for (const [index, item] of remainder.entries()) {
    if (keepFlags[index]) {
      flushSkippedRange(true);
      retainedEntries.push({ kind: "item", item });
      continue;
    }
    skippedRangeCount += 1;
  }
  flushSkippedRange(false);
  return retainedEntries;
}

function takeBudgetedHeadCount<T>(
  items: T[],
  budgetUnits: number,
  weightUnits: (item: T) => number
): number {
  if (budgetUnits <= 0) {
    return 0;
  }
  let consumedUnits = 0;
  let count = 0;
  while (count < items.length) {
    const nextWeightUnits = weightUnits(items[count]!);
    if (consumedUnits + nextWeightUnits > budgetUnits) {
      break;
    }
    consumedUnits += nextWeightUnits;
    count += 1;
  }
  return count;
}

function takeBudgetedTailStart<T>(
  items: T[],
  headCount: number,
  budgetUnits: number,
  weightUnits: (item: T) => number
): number {
  if (budgetUnits <= 0) {
    return items.length;
  }
  let consumedUnits = 0;
  let start = items.length;
  while (start > headCount) {
    const nextWeightUnits = weightUnits(items[start - 1]!);
    if (consumedUnits + nextWeightUnits > budgetUnits) {
      break;
    }
    consumedUnits += nextWeightUnits;
    start -= 1;
  }
  return start;
}

function groupEntriesByTurn<T>(
  items: T[],
  resolveTurnKey: (item: T, index: number) => string,
  resolveTurnMeta: (item: T) => { turnId: string | null; turnCursor: string | null }
): Array<{ turnId: string | null; turnCursor: string | null; items: T[] }> {
  const groups: Array<{ key: string; turnId: string | null; turnCursor: string | null; items: T[] }> = [];
  for (const [index, item] of items.entries()) {
    const key = resolveTurnKey(item, index);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      const meta = resolveTurnMeta(item);
      groups.push({
        key,
        turnId: meta.turnId,
        turnCursor: meta.turnCursor,
        items: [item]
      });
      continue;
    }
    current.items.push(item);
  }
  return groups.map(({ turnId, turnCursor, items: groupedItems }) => ({
    turnId,
    turnCursor,
    items: groupedItems
  }));
}
