import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ThreadBridgeRecord } from "../domain.js";
import type { Logger } from "../logger.js";
import { resolveDesktopLogPaths } from "../platform.js";
import { StateStore } from "../store/StateStore.js";
import {
  formatStartupTimingMs,
  isStartupTimingEnabled,
  startupTimingNow
} from "../util/startupTiming.js";
import { isConversationUserAnchorText } from "../util/userEnvelopes.js";
import {
  extractNestedString
} from "./codexFsHelpers.js";
import {
  parseDiscoveredSessionThread
} from "./CodexSessionDiscoveryParser.js";
import { CodexSessionLogLocator } from "./CodexSessionLogLocator.js";

interface SessionEventSourceMeta {
  eventKey?: string;
  sourceFilePath?: string;
  sourceOffset?: number;
  sourceOrder?: string;
}

export interface SessionCommandApprovalEvent extends SessionEventSourceMeta {
  type: "shellApprovalRequested";
  threadId: string;
  callId: string;
  turnId?: string | null;
  streamOrder?: number;
  timestampMs: number | null;
  command: string | null;
  cwd: string | null;
  justification: string | null;
  prefixRule: string[] | null;
  details: string;
}

export interface SessionCommandCompletedEvent extends SessionEventSourceMeta {
  type: "shellCommandCompleted";
  threadId: string;
  callId: string;
  turnId?: string | null;
  streamOrder?: number;
  timestampMs: number | null;
  command: string | null;
  cwd: string | null;
  output: string;
  status: string | null;
}

export interface SessionUserMessageEvent extends SessionEventSourceMeta {
  type: "sessionUserMessage";
  threadId: string;
  turnId: string | null;
  streamOrder?: number;
  timestampMs: number | null;
  text: string;
  isSyntheticSubagentInstruction?: boolean;
}

export interface SessionAgentMessageEvent extends SessionEventSourceMeta {
  type: "sessionAgentMessage";
  threadId: string;
  turnId: string | null;
  streamOrder?: number;
  timestampMs: number | null;
  text: string;
  phase: string | null;
}

export interface SessionSubagentSpawnedEvent extends SessionEventSourceMeta {
  type: "sessionSubagentSpawned";
  threadId: string;
  turnId: string | null;
  childThreadId: string;
  childAgentName: string | null;
  prompt: string | null;
  timestampMs: number | null;
}

export interface SessionApplyPatchCompletedEvent extends SessionEventSourceMeta {
  type: "sessionApplyPatchCompleted";
  threadId: string;
  turnId: string | null;
  callId: string;
  streamOrder?: number;
  timestampMs: number | null;
  summary: string;
  fileCounts: {
    created: number;
    edited: number;
    deleted: number;
    createdPaths: string[];
    editedPaths: string[];
    deletedPaths: string[];
  };
  details: string;
}

export interface NativeCommandApprovalRequestedEvent extends SessionEventSourceMeta {
  type: "nativeCommandApprovalRequested";
  threadId: string;
  requestId: string;
  timestampMs: number | null;
}

export interface NativeQuestionRequestedEvent extends SessionEventSourceMeta {
  type: "nativeQuestionRequested";
  threadId: string;
  requestId: string;
  questionCount: number;
  timestampMs: number | null;
}

export interface NativeApprovalResolvedEvent extends SessionEventSourceMeta {
  type: "nativeApprovalResolved";
  threadId: string | null;
  requestId: string;
  method: string;
  timestampMs: number | null;
  response: unknown;
}

export type CodexSessionEvent =
  | SessionCommandApprovalEvent
  | SessionCommandCompletedEvent
  | SessionUserMessageEvent
  | SessionAgentMessageEvent
  | SessionSubagentSpawnedEvent
  | SessionApplyPatchCompletedEvent
  | NativeCommandApprovalRequestedEvent
  | NativeQuestionRequestedEvent
  | NativeApprovalResolvedEvent;

export type SessionBackfillEvent =
  | SessionCommandApprovalEvent
  | SessionUserMessageEvent
  | SessionAgentMessageEvent
  | SessionCommandCompletedEvent
  | SessionSubagentSpawnedEvent
  | SessionApplyPatchCompletedEvent;

export interface SessionThreadFrontier {
  filePath: string;
  offset: number;
}

export interface DiscoveredCliSessionThread {
  threadId: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  repoName: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  status: "active" | "idle";
  filePath: string;
}

export interface DiscoveredLocalSessionThread extends DiscoveredCliSessionThread {
  sourceKind: "app-server" | "cli-session";
  parentThreadId: string | null;
  actorName: string | null;
  sourceSubagentOther?: string | null;
  originator?: string | null;
  source?: string | null;
}

interface SessionToolCallContext {
  toolName: string;
  command: string | null;
  cwd: string | null;
  justification: string | null;
  prefixRule: string[] | null;
  timestampMs: number | null;
  requiresApproval: boolean;
  spawnAgentPrompt: string | null;
}

interface ResponseItemEnvelope {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

interface CachedDiscoveredSessionThread {
  mtimeMs: number;
  snapshot: DiscoveredLocalSessionThread | null;
}

interface CachedSessionThreadContext {
  filePath: string;
  mtimeMs: number;
  parentThreadId: string | null;
}

interface SessionFileCandidate {
  filePath: string;
  mtimeMs: number;
}

const INITIAL_THREAD_POLL_TAIL_BYTES = 1024 * 1024;
const MIN_DISCOVERY_CANDIDATE_FILES = 40;
const DISCOVERY_CANDIDATE_MULTIPLIER = 4;
const RECENT_TURN_BACKFILL_LOCATOR_CHUNK_BYTES = 4 * 1024 * 1024;
const RECENT_TURN_BACKFILL_MAX_USERLESS_SCAN_BYTES = 32 * 1024 * 1024;
interface LocatedRecentBackfillTurn {
  startOffset: number;
  turnId: string;
  hasUserMessage: boolean;
  hasBackfill: boolean;
}

type BackfillLineClassification =
  | "turnContext"
  | "eventUserMessage"
  | "responseUserMessage"
  | "responseAssistantMessage"
  | "relevantFunctionCall"
  | "functionCallOutput"
  | "completedApplyPatch"
  | "irrelevant";

interface ParsedBackfillLine {
  classification: BackfillLineClassification;
  payload: Record<string, unknown> | null;
  timestampMs: number | null;
  turnId: string | null;
}

interface SessionThreadParseState {
  currentTurnId: string | null;
  openToolCalls: Map<string, SessionToolCallContext>;
}

interface CodexSessionEventTailerOptions {
  desktopLogRootOverride?: string | null;
}

export class CodexSessionEventTailer {
  private readonly sessionLogLocator: CodexSessionLogLocator;
  private readonly partialLineByThread = new Map<string, string>();
  private readonly desktopPartialLineByFile = new Map<string, string>();
  private readonly openToolCallsByThread = new Map<string, Map<string, SessionToolCallContext>>();
  private readonly discoveredSessionCache = new Map<string, CachedDiscoveredSessionThread>();
  private readonly sessionThreadContextCache = new Map<string, CachedSessionThreadContext>();
  private readonly currentTurnIdByThread = new Map<string, string>();
  private readonly advisoryTurnHintByThread = new Map<string, string>();
  private desktopLogNoticePrinted = false;

  constructor(
    private readonly codexHome: string,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
    private readonly options: CodexSessionEventTailerOptions = {}
  ) {
    this.sessionLogLocator = new CodexSessionLogLocator(codexHome, logger);
  }

  rememberTurnHint(threadId: string, turnId: string | null | undefined): void {
    const normalizedThreadId = threadId.trim();
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    if (!normalizedThreadId) {
      return;
    }
    if (!normalizedTurnId) {
      this.advisoryTurnHintByThread.delete(normalizedThreadId);
      return;
    }
    this.advisoryTurnHintByThread.set(normalizedThreadId, normalizedTurnId);
  }

  async pollThread(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<CodexSessionEvent[]> {
    const filePath = await this.resolveSessionLogPath(threadId, options);
    if (!filePath) {
      return [];
    }

    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      this.logger.debug({ error, threadId, filePath }, "Failed to stat session log file.");
      this.sessionLogLocator.forget(threadId);
      return [];
    }

    const currentCursor = this.stateStore.getSessionLogCursor(threadId);
    if (!currentCursor || currentCursor.filePath !== filePath || currentCursor.byteOffset > stats.size) {
      this.partialLineByThread.delete(threadId);
      this.openToolCallsByThread.delete(threadId);
      const existingBridge = this.stateStore.getThreadBridge(threadId);
      const hasMirroredHistory = Boolean(
        existingBridge?.latestMirroredCursor?.trim() ||
          existingBridge?.latestMirroredTurnCursor?.trim() ||
          existingBridge?.latestMirroredSourceFilePath?.trim()
      );
      const resumeOffset = await this.resolveResumeOffsetFromMirroredSourceFrontier(
        existingBridge,
        filePath,
        stats.size
      );

      if (resumeOffset !== null) {
        this.seedLiveParseStateFromExistingBridge(threadId, existingBridge);
        if (resumeOffset >= stats.size) {
          this.stateStore.upsertSessionLogCursor({
            threadId,
            filePath,
            byteOffset: stats.size,
            updatedAt: new Date().toISOString()
          });
          return [];
        }

        const handle = await open(filePath, "r");
        try {
          const byteLength = stats.size - resumeOffset;
          const buffer = Buffer.alloc(byteLength);
          await handle.read(buffer, 0, byteLength, resumeOffset);
          this.stateStore.upsertSessionLogCursor({
            threadId,
            filePath,
            byteOffset: stats.size,
            updatedAt: new Date().toISOString()
          });
          return this.parseChunk(threadId, filePath, buffer.toString("utf8"), resumeOffset);
        } finally {
          await handle.close();
        }
      }

      const initialOffset = Math.max(0, stats.size - INITIAL_THREAD_POLL_TAIL_BYTES);
      this.stateStore.upsertSessionLogCursor({
        threadId,
        filePath,
        byteOffset: stats.size,
        updatedAt: new Date().toISOString()
      });

      if (hasMirroredHistory || initialOffset >= stats.size) {
        return [];
      }

      const handle = await open(filePath, "r");
      try {
        const byteLength = stats.size - initialOffset;
        const buffer = Buffer.alloc(byteLength);
        await handle.read(buffer, 0, byteLength, initialOffset);
        return this.parseChunk(threadId, filePath, buffer.toString("utf8"), initialOffset);
      } finally {
        await handle.close();
      }
    }

    if (currentCursor.byteOffset === stats.size) {
      return [];
    }

    const handle = await open(filePath, "r");
    try {
      const byteLength = stats.size - currentCursor.byteOffset;
      const buffer = Buffer.alloc(byteLength);
      await handle.read(buffer, 0, byteLength, currentCursor.byteOffset);
      this.stateStore.upsertSessionLogCursor({
        threadId,
        filePath,
        byteOffset: stats.size,
        updatedAt: new Date().toISOString()
      });
      return this.parseChunk(threadId, filePath, buffer.toString("utf8"), currentCursor.byteOffset);
    } finally {
      await handle.close();
    }
  }

  async pollDesktop(): Promise<CodexSessionEvent[]> {
    const files = await this.listDesktopLogFiles();
    const events: CodexSessionEvent[] = [];

    for (const filePath of files) {
      let stats;
      try {
        stats = await stat(filePath);
      } catch (error) {
        this.logger.debug({ error, filePath }, "Failed to stat desktop log file.");
        this.stateStore.deleteDesktopLogCursor(filePath);
        this.desktopPartialLineByFile.delete(filePath);
        continue;
      }

      const currentCursor = this.stateStore.getDesktopLogCursor(filePath);
      if (!currentCursor || currentCursor.byteOffset > stats.size) {
        this.desktopPartialLineByFile.delete(filePath);
        this.stateStore.upsertDesktopLogCursor({
          filePath,
          byteOffset: stats.size,
          updatedAt: new Date().toISOString()
        });
        continue;
      }

      if (currentCursor.byteOffset === stats.size) {
        continue;
      }

      const handle = await open(filePath, "r");
      try {
        const byteLength = stats.size - currentCursor.byteOffset;
        const buffer = Buffer.alloc(byteLength);
        await handle.read(buffer, 0, byteLength, currentCursor.byteOffset);
        this.stateStore.upsertDesktopLogCursor({
          filePath,
          byteOffset: stats.size,
          updatedAt: new Date().toISOString()
        });
        const parsed = this.parseDesktopChunk(
          filePath,
          buffer.toString("utf8"),
          currentCursor.byteOffset
        );
        for (const event of parsed) {
          events.push(event);
        }
      } finally {
        await handle.close();
      }
    }

    return events;
  }

  async fastForwardThread(threadId: string): Promise<boolean> {
    const filePath = await this.resolveSessionLogPath(threadId);
    if (!filePath) {
      return false;
    }

    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      this.logger.debug({ error, threadId, filePath }, "Failed to stat session log file during fast-forward.");
      this.sessionLogLocator.forget(threadId);
      return false;
    }

    this.partialLineByThread.delete(threadId);
    this.openToolCallsByThread.delete(threadId);
    this.seedLiveParseStateFromExistingBridge(threadId, this.stateStore.getThreadBridge(threadId));
    this.stateStore.upsertSessionLogCursor({
      threadId,
      filePath,
      byteOffset: stats.size,
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  async captureThreadFrontier(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<SessionThreadFrontier | null> {
    const filePath = await this.resolveSessionLogPath(threadId, options);
    if (!filePath) {
      return null;
    }

    try {
      const fileStats = await stat(filePath);
      return {
        filePath,
        offset: fileStats.size
      };
    } catch (error) {
      this.logger.debug({ error, threadId, filePath }, "Failed to stat session log file while capturing frontier.");
      this.sessionLogLocator.forget(threadId);
      return null;
    }
  }

  async markThreadFrontier(
    threadId: string,
    sourceFrontier: SessionThreadFrontier | null
  ): Promise<boolean> {
    if (!sourceFrontier) {
      return false;
    }

    const filePath = await this.resolveSessionLogPath(threadId, { allowFilesystemScan: false });
    if (!filePath || filePath !== sourceFrontier.filePath) {
      return false;
    }

    const existingCursor = this.stateStore.getSessionLogCursor(threadId);
    if (existingCursor && existingCursor.filePath === sourceFrontier.filePath) {
      return true;
    }

    try {
      const fileStats = await stat(filePath);
      this.stateStore.upsertSessionLogCursor({
        threadId,
        filePath,
        byteOffset: Math.max(0, Math.min(fileStats.size, Math.trunc(sourceFrontier.offset))),
        updatedAt: new Date().toISOString()
      });
      return true;
    } catch (error) {
      this.logger.debug({ error, threadId, filePath }, "Failed to mark session log frontier.");
      this.sessionLogLocator.forget(threadId);
      return false;
    }
  }

  async replayThreadFromFrontier(
    threadId: string,
    sourceFrontier: SessionThreadFrontier | null,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<CodexSessionEvent[]> {
    if (!sourceFrontier) {
      return [];
    }

    const filePath = await this.resolveSessionLogPath(threadId, options);
    if (!filePath) {
      return [];
    }

    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      this.logger.debug(
        { error, threadId, filePath },
        "Failed to stat session log file while replaying from a captured frontier."
      );
      this.sessionLogLocator.forget(threadId);
      return [];
    }

    const normalizedOffset =
      filePath === sourceFrontier.filePath
        ? Math.max(0, Math.min(stats.size, Math.trunc(sourceFrontier.offset)))
        : stats.size;

    this.partialLineByThread.delete(threadId);
    this.openToolCallsByThread.delete(threadId);
    this.seedLiveParseStateFromExistingBridge(threadId, this.stateStore.getThreadBridge(threadId));

    if (normalizedOffset >= stats.size) {
      this.stateStore.upsertSessionLogCursor({
        threadId,
        filePath,
        byteOffset: stats.size,
        updatedAt: new Date().toISOString()
      });
      return [];
    }

    const handle = await open(filePath, "r");
    try {
      const byteLength = stats.size - normalizedOffset;
      const buffer = Buffer.alloc(byteLength);
      await handle.read(buffer, 0, byteLength, normalizedOffset);
      this.stateStore.upsertSessionLogCursor({
        threadId,
        filePath,
        byteOffset: stats.size,
        updatedAt: new Date().toISOString()
      });
      return this.parseChunk(threadId, filePath, buffer.toString("utf8"), normalizedOffset);
    } finally {
      await handle.close();
    }
  }

  async fastForwardDesktop(): Promise<number> {
    const files = await this.listDesktopLogFiles();
    let advanced = 0;

    for (const filePath of files) {
      let stats;
      try {
        stats = await stat(filePath);
      } catch (error) {
        this.logger.debug({ error, filePath }, "Failed to stat desktop log file during fast-forward.");
        continue;
      }

      this.desktopPartialLineByFile.delete(filePath);
      this.stateStore.upsertDesktopLogCursor({
        filePath,
        byteOffset: stats.size,
        updatedAt: new Date().toISOString()
      });
      advanced += 1;
    }

    return advanced;
  }

  async listRecentLocalThreads(limit: number, maxAgeMs: number): Promise<DiscoveredLocalSessionThread[]> {
    const maxCandidateFiles = Math.max(
      MIN_DISCOVERY_CANDIDATE_FILES,
      Math.max(1, limit) * DISCOVERY_CANDIDATE_MULTIPLIER
    );
    const candidates = await this.listSessionFileCandidates(
      path.join(this.codexHome, "sessions"),
      maxAgeMs,
      maxCandidateFiles
    );
    const snapshots = new Map<
      string,
      { snapshot: DiscoveredLocalSessionThread; fileMtimeMs: number }
    >();

    for (const candidate of candidates) {
      const discovered = await this.readDiscoveredLocalSessionThread(candidate);
      if (!discovered) {
        continue;
      }

      const existing = snapshots.get(discovered.threadId);
      if (
        !existing ||
        this.shouldReplaceDiscoveredSnapshot(existing.snapshot, discovered, existing.fileMtimeMs, candidate.mtimeMs)
      ) {
        snapshots.set(discovered.threadId, {
          snapshot: discovered,
          fileMtimeMs: candidate.mtimeMs
        });
      }
    }

    const selected = [...snapshots.values()]
      .sort((left, right) => this.compareDiscoveredSnapshots(left.snapshot, right.snapshot, left.fileMtimeMs, right.fileMtimeMs))
      .slice(0, Math.max(1, limit));

    for (const entry of selected) {
      this.sessionLogLocator.remember(entry.snapshot.threadId, entry.snapshot.filePath);
    }

    return selected.map((entry) => entry.snapshot);
  }

  async listRecentCliThreads(limit: number, maxAgeMs: number): Promise<DiscoveredCliSessionThread[]> {
    const threads = await this.listRecentLocalThreads(limit * 2, maxAgeMs);
    return threads
      .filter((thread) => thread.sourceKind === "cli-session")
      .slice(0, limit);
  }

  async readLatestTurnBackfillEvents(threadId: string): Promise<SessionBackfillEvent[]> {
    return this.readRecentTurnBackfillEvents(threadId, 1);
  }

  async readRecentTurnBackfillEvents(
    threadId: string,
    turnCount: number
  ): Promise<SessionBackfillEvent[]> {
    const startedAt = startupTimingNow();
    const filePath = await this.resolveSessionLogPath(threadId);
    if (!filePath) {
      return [];
    }

    const normalizedTurnCount = Math.max(1, Math.trunc(turnCount));
    const parseState = this.createIsolatedThreadParseState();

    const fileStats = await stat(filePath);
    const fileSize = fileStats.size;
    if (fileSize <= 0) {
      return [];
    }
    const locateStartedAt = startupTimingNow();
    const startOffset = await this.locateRecentTurnBackfillStartOffset(
      filePath,
      fileSize,
      normalizedTurnCount
    );
    const locateDurationMs = startupTimingNow() - locateStartedAt;

    const scanStartedAt = startupTimingNow();
    const { recentTurns, recentUserTurns } = await this.scanRecentTurnBackfillGroups(
      threadId,
      filePath,
      startOffset,
      normalizedTurnCount,
      parseState
    );
    const scanDurationMs = startupTimingNow() - scanStartedAt;
    this.commitBackfillParseState(threadId, filePath, fileSize, parseState);
    const selectedGroups = recentUserTurns.length > 0 ? recentUserTurns : recentTurns;
    this.logStartupTiming(
      `session-backfill ${threadId} fileSize=${fileSize}B startOffset=${startOffset} turns=${normalizedTurnCount} recentTurns=${recentTurns.length} recentUserTurns=${recentUserTurns.length} locate=${formatStartupTimingMs(locateDurationMs)} scan=${formatStartupTimingMs(scanDurationMs)} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return selectedGroups.flatMap((group) => group.events);
  }

  async readBackfillEventsSince(
    threadId: string,
    sourceFrontier: { filePath: string; offset: number } | null
  ): Promise<SessionBackfillEvent[]> {
    const startedAt = startupTimingNow();
    if (!sourceFrontier) {
      return [];
    }

    const filePath = await this.resolveSessionLogPath(threadId);
    if (!filePath || filePath !== sourceFrontier.filePath) {
      return [];
    }

    const fileStats = await stat(filePath);
    const fileSize = fileStats.size;
    if (fileSize <= 0) {
      return [];
    }

    const normalizedStartOffset = Math.max(
      0,
      Math.min(fileSize, Math.trunc(sourceFrontier.offset))
    );

    const parseState = this.createIsolatedThreadParseState();
    const events = await this.readBackfillEventsFromOffset(
      threadId,
      filePath,
      normalizedStartOffset,
      parseState
    );
    this.commitBackfillParseState(threadId, filePath, fileSize, parseState);
    this.logStartupTiming(
      `session-frontier ${threadId} fileSize=${fileSize}B startOffset=${normalizedStartOffset} events=${events.length} total=${formatStartupTimingMs(startupTimingNow() - startedAt)}`
    );
    return events;
  }

  private logStartupTiming(message: string): void {
    if (!isStartupTimingEnabled()) {
      return;
    }
    this.logger.info({ startupTiming: true }, message);
  }

  private async locateRecentTurnBackfillStartOffset(
    filePath: string,
    fileSize: number,
    turnCount: number
  ): Promise<number> {
    if (fileSize <= 0) {
      return 0;
    }

    const handle = await open(filePath, "r");
    const recentTurns: LocatedRecentBackfillTurn[] = [];
    const recentUserTurns: LocatedRecentBackfillTurn[] = [];
    const pendingState = {
      hasBackfill: false,
      hasUserMessage: false
    };
    let trailingRemainder = Buffer.alloc(0);
    let position = fileSize;

    const rememberTurn = (turn: LocatedRecentBackfillTurn): void => {
      if (!turn.hasBackfill) {
        return;
      }

      if (recentTurns.length < turnCount) {
        recentTurns.push(turn);
      }
      if (turn.hasUserMessage && recentUserTurns.length < turnCount) {
        recentUserTurns.push(turn);
      }
    };

    const processReverseLine = (line: string, sourceOffset: number): void => {
      const parsedLine = this.parseBackfillLineMetadata(line);
      if (!parsedLine) {
        return;
      }

      if (parsedLine.classification === "turnContext") {
        if (parsedLine.turnId) {
          rememberTurn({
            startOffset: sourceOffset,
            turnId: parsedLine.turnId,
            hasBackfill: pendingState.hasBackfill,
            hasUserMessage: pendingState.hasUserMessage
          });
        }
        pendingState.hasBackfill = false;
        pendingState.hasUserMessage = false;
        return;
      }

      switch (parsedLine.classification) {
        case "eventUserMessage":
        case "responseUserMessage":
          pendingState.hasBackfill = true;
          pendingState.hasUserMessage =
            pendingState.hasUserMessage || this.isBackfillLineConversationUserAnchor(parsedLine);
          return;
        case "responseAssistantMessage":
        case "functionCallOutput":
        case "completedApplyPatch":
          pendingState.hasBackfill = true;
          return;
        default:
          return;
      }
    };

    try {
      while (position > 0 && recentUserTurns.length < turnCount) {
        const start = Math.max(0, position - RECENT_TURN_BACKFILL_LOCATOR_CHUNK_BYTES);
        const byteLength = position - start;
        const buffer = Buffer.alloc(byteLength);
        await handle.read(buffer, 0, byteLength, start);
        const combined = trailingRemainder.length > 0 ? Buffer.concat([buffer, trailingRemainder]) : buffer;

        let lineEnd = combined.length;
        for (let index = combined.length - 1; index >= 0; index -= 1) {
          if (combined[index] !== 0x0a) {
            continue;
          }

          const lineStart = index + 1;
          const lineBuffer = combined.subarray(lineStart, lineEnd);
          const trimmedLineBuffer =
            lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
              ? lineBuffer.subarray(0, lineBuffer.length - 1)
              : lineBuffer;
          processReverseLine(trimmedLineBuffer.toString("utf8"), start + lineStart);
          lineEnd = index;

          if (recentUserTurns.length >= turnCount) {
            break;
          }
        }

        trailingRemainder = combined.subarray(0, lineEnd);
        position = start;
        if (
          recentUserTurns.length === 0 &&
          recentTurns.length >= turnCount &&
          fileSize - position >= RECENT_TURN_BACKFILL_MAX_USERLESS_SCAN_BYTES
        ) {
          break;
        }
      }

      if (position === 0 && trailingRemainder.length > 0 && recentUserTurns.length < turnCount) {
        const trimmedLineBuffer =
          trailingRemainder.length > 0 && trailingRemainder[trailingRemainder.length - 1] === 0x0d
            ? trailingRemainder.subarray(0, trailingRemainder.length - 1)
            : trailingRemainder;
        processReverseLine(trimmedLineBuffer.toString("utf8"), 0);
      }
    } finally {
      await handle.close();
    }

    const selectedTurns = recentUserTurns.length > 0 ? recentUserTurns : recentTurns;
    return selectedTurns.at(-1)?.startOffset ?? 0;
  }

  private async scanRecentTurnBackfillGroups(
    threadId: string,
    filePath: string,
    startOffset: number,
    turnCount: number,
    parseState: SessionThreadParseState
  ): Promise<{
    recentTurns: Array<{
      turnId: string;
      events: SessionBackfillEvent[];
      hasUserMessage: boolean;
    }>;
    recentUserTurns: Array<{
      turnId: string;
      events: SessionBackfillEvent[];
      hasUserMessage: boolean;
    }>;
  }> {
    const recentTurns: Array<{
      turnId: string;
      events: SessionBackfillEvent[];
      hasUserMessage: boolean;
    }> = [];
    const recentUserTurns: Array<{
      turnId: string;
      events: SessionBackfillEvent[];
      hasUserMessage: boolean;
    }> = [];
    let currentGroup:
      | {
          turnId: string;
          events: SessionBackfillEvent[];
          hasUserMessage: boolean;
        }
      | null = null;

    const finalizeCurrentGroup = (): void => {
      if (!currentGroup) {
        return;
      }
      recentTurns.push(currentGroup);
      if (recentTurns.length > turnCount) {
        recentTurns.shift();
      }
      if (currentGroup.hasUserMessage) {
        recentUserTurns.push(currentGroup);
        if (recentUserTurns.length > turnCount) {
          recentUserTurns.shift();
        }
      }
      currentGroup = null;
    };

    await this.readBackfillLinesFromOffset(filePath, startOffset, (line, sourceOffset) => {
      for (const event of this.parseBackfillLine(threadId, line, filePath, sourceOffset, parseState)) {
        const eventTurnId = event.turnId ?? null;
        if (!eventTurnId) {
          continue;
        }

        if (!currentGroup || currentGroup.turnId !== eventTurnId) {
          finalizeCurrentGroup();
          currentGroup = {
            turnId: eventTurnId,
            events: [event],
            hasUserMessage: this.isSessionConversationUserAnchor(event)
          };
          continue;
        }

        currentGroup.events.push(event);
        if (this.isSessionConversationUserAnchor(event)) {
          currentGroup.hasUserMessage = true;
        }
      }
    });

    finalizeCurrentGroup();
    return { recentTurns, recentUserTurns };
  }

  private async readBackfillEventsFromOffset(
    threadId: string,
    filePath: string,
    startOffset: number,
    parseState: SessionThreadParseState
  ): Promise<SessionBackfillEvent[]> {
    const events: SessionBackfillEvent[] = [];
    await this.readBackfillLinesFromOffset(filePath, startOffset, (line, sourceOffset) => {
      events.push(...this.parseBackfillLine(threadId, line, filePath, sourceOffset, parseState));
    });
    return events;
  }

  private async readBackfillLinesFromOffset(
    filePath: string,
    startOffset: number,
    onLine: (line: string, sourceOffset: number) => void
  ): Promise<void> {
    const stream = createReadStream(filePath, {
      ...(startOffset > 0 ? { start: startOffset } : {})
    });
    const pendingLineSegments: Buffer[] = [];
    let pendingLineBytes = 0;
    let currentLineStartOffset = startOffset;
    let chunkStartOffset = startOffset;

    const flushLine = (lineBuffer: Buffer, sourceOffset: number): void => {
      const normalizedLineBuffer =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
          ? lineBuffer.subarray(0, lineBuffer.length - 1)
          : lineBuffer;
      const line = normalizedLineBuffer.toString("utf8");
      onLine(line, sourceOffset);
    };

    const flushPendingSegments = (tailSegment: Buffer, sourceOffset: number): void => {
      let lineBuffer = tailSegment;
      if (pendingLineSegments.length > 0) {
        pendingLineSegments.push(tailSegment);
        pendingLineBytes += tailSegment.length;
        lineBuffer =
          pendingLineSegments.length === 1
            ? pendingLineSegments[0]!
            : Buffer.concat(pendingLineSegments, pendingLineBytes);
        pendingLineSegments.length = 0;
        pendingLineBytes = 0;
      }

      flushLine(lineBuffer, sourceOffset);
    };

    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let lineStart = 0;

        for (let index = 0; index < buffer.length; index += 1) {
          if (buffer[index] !== 0x0a) {
            continue;
          }

          flushPendingSegments(buffer.subarray(lineStart, index), currentLineStartOffset);
          lineStart = index + 1;
          currentLineStartOffset = chunkStartOffset + lineStart;
        }

        if (lineStart < buffer.length) {
          const remainder = buffer.subarray(lineStart);
          pendingLineSegments.push(remainder);
          pendingLineBytes += remainder.length;
        }

        chunkStartOffset += buffer.length;
      }
    } finally {
      stream.close();
    }

    if (pendingLineSegments.length > 0) {
      const lineBuffer =
        pendingLineSegments.length === 1
          ? pendingLineSegments[0]!
          : Buffer.concat(pendingLineSegments, pendingLineBytes);
      pendingLineSegments.length = 0;
      pendingLineBytes = 0;
      flushLine(lineBuffer, currentLineStartOffset);
    }
  }

  async resolveParentThreadId(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<string | null> {
    const filePath = await this.resolveSessionLogPath(threadId, options);
    if (!filePath) {
      return null;
    }

    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch {
      this.sessionLogLocator.forget(threadId);
      this.sessionThreadContextCache.delete(threadId);
      return null;
    }

    const cached = this.sessionThreadContextCache.get(threadId);
    if (
      cached &&
      cached.filePath === filePath &&
      cached.mtimeMs === fileStats.mtimeMs
    ) {
      return cached.parentThreadId;
    }

    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let parentThreadId: string | null = null;

    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: { type?: unknown; payload?: Record<string, unknown> };
        try {
          parsed = JSON.parse(trimmed) as { type?: unknown; payload?: Record<string, unknown> };
        } catch {
          continue;
        }

        const payload =
          parsed.payload && typeof parsed.payload === "object"
            ? (parsed.payload as Record<string, unknown>)
            : null;
        if (parsed.type !== "session_meta" || !payload || payload.id !== threadId) {
          continue;
        }

        parentThreadId =
          extractNestedString(payload, [
            "source",
            "subagent",
            "thread_spawn",
            "parent_thread_id"
          ]) ??
          extractNestedString(payload, [
            "source",
            "subagent",
            "threadSpawn",
            "parentThreadId"
          ]) ??
          null;
        break;
      }
    } finally {
      lines.close();
      stream.close();
    }

    this.sessionThreadContextCache.set(threadId, {
      filePath,
      mtimeMs: fileStats.mtimeMs,
      parentThreadId
    });
    return parentThreadId;
  }

  private isBackfillEvent(event: CodexSessionEvent): event is SessionBackfillEvent {
    return (
      event.type === "shellApprovalRequested" ||
      event.type === "sessionUserMessage" ||
      event.type === "sessionAgentMessage" ||
      event.type === "shellCommandCompleted" ||
      event.type === "sessionSubagentSpawned" ||
      event.type === "sessionApplyPatchCompleted"
    );
  }

  private async resolveSessionLogPath(
    threadId: string,
    options: {
      allowFilesystemScan?: boolean;
    } = {}
  ): Promise<string | null> {
    return this.sessionLogLocator.resolve(threadId, {
      ...options,
      validateSessionMeta: true
    });
  }

  private async readDiscoveredLocalSessionThread(
    candidate: SessionFileCandidate
  ): Promise<DiscoveredLocalSessionThread | null> {
    const cached = this.discoveredSessionCache.get(candidate.filePath);
    if (cached && cached.mtimeMs === candidate.mtimeMs) {
      return cached.snapshot;
    }

    const parsed = await parseDiscoveredSessionThread(candidate.filePath, candidate.mtimeMs);
    const snapshot =
      parsed &&
      parsed.threadId
        ? {
            threadId: parsed.threadId,
            name: parsed.name,
            preview: parsed.preview,
            cwd: parsed.cwd,
            repoName: parsed.repoName,
            createdAtMs: parsed.createdAtMs,
            updatedAtMs: parsed.updatedAtMs,
            status: parsed.status,
            filePath: candidate.filePath,
            sourceKind:
              parsed.source === "cli" || parsed.originator === "codex-tui"
                ? ("cli-session" as const)
                : ("app-server" as const),
            parentThreadId: parsed.parentThreadId,
            actorName: parsed.actorName,
            sourceSubagentOther: parsed.sourceSubagentOther,
            originator: parsed.originator,
            source: parsed.source
          }
        : null;

    this.discoveredSessionCache.set(candidate.filePath, {
      mtimeMs: candidate.mtimeMs,
      snapshot
    });
    return snapshot;
  }

  private async listSessionFileCandidates(
    directory: string,
    maxAgeMs: number,
    maxCandidates: number
  ): Promise<SessionFileCandidate[]> {
    try {
      await access(directory);
    } catch {
      return [];
    }

    const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
    const files: SessionFileCandidate[] = [];
    await this.collectSessionFileCandidates(directory, cutoffMs, files, Math.max(1, maxCandidates));
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  private async collectSessionFileCandidates(
    directory: string,
    cutoffMs: number,
    files: SessionFileCandidate[],
    maxCandidates: number
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectSessionFileCandidates(fullPath, cutoffMs, files, maxCandidates);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        continue;
      }

      if (stats.mtimeMs < cutoffMs) {
        continue;
      }

      this.pushCandidateWithCap(files, {
        filePath: fullPath,
        mtimeMs: stats.mtimeMs
      }, maxCandidates);
    }
  }

  private pushCandidateWithCap(
    files: SessionFileCandidate[],
    next: SessionFileCandidate,
    maxCandidates: number
  ): void {
    if (files.length < maxCandidates) {
      files.push(next);
      return;
    }

    let oldestIndex = 0;
    let oldestMtime = files[0]?.mtimeMs ?? Number.POSITIVE_INFINITY;
    for (let index = 1; index < files.length; index += 1) {
      const candidate = files[index];
      if (!candidate) {
        continue;
      }
      if (candidate.mtimeMs < oldestMtime) {
        oldestMtime = candidate.mtimeMs;
        oldestIndex = index;
      }
    }

    if (next.mtimeMs <= oldestMtime) {
      return;
    }

    files[oldestIndex] = next;
  }

  private shouldReplaceDiscoveredSnapshot(
    existing: DiscoveredLocalSessionThread,
    next: DiscoveredLocalSessionThread,
    existingFileMtimeMs: number,
    nextFileMtimeMs: number
  ): boolean {
    const activityComparison = this.compareNullableNumbers(next.updatedAtMs, existing.updatedAtMs);
    if (activityComparison !== 0) {
      return activityComparison > 0;
    }

    if (next.status !== existing.status) {
      return next.status === "active";
    }

    const createdComparison = this.compareNullableNumbers(next.createdAtMs, existing.createdAtMs);
    if (createdComparison !== 0) {
      return createdComparison > 0;
    }

    return nextFileMtimeMs > existingFileMtimeMs;
  }

  private compareDiscoveredSnapshots(
    left: DiscoveredLocalSessionThread,
    right: DiscoveredLocalSessionThread,
    leftFileMtimeMs: number,
    rightFileMtimeMs: number
  ): number {
    const activityComparison = this.compareNullableNumbers(right.updatedAtMs, left.updatedAtMs);
    if (activityComparison !== 0) {
      return activityComparison;
    }

    if (left.status !== right.status) {
      return left.status === "active" ? -1 : 1;
    }

    const createdComparison = this.compareNullableNumbers(right.createdAtMs, left.createdAtMs);
    if (createdComparison !== 0) {
      return createdComparison;
    }

    return rightFileMtimeMs - leftFileMtimeMs;
  }

  private compareNullableNumbers(left: number | null, right: number | null): number {
    const normalizedLeft = typeof left === "number" && Number.isFinite(left) ? left : -1;
    const normalizedRight = typeof right === "number" && Number.isFinite(right) ? right : -1;
    return normalizedLeft - normalizedRight;
  }

  private async listDesktopLogFiles(): Promise<string[]> {
    const resolution = resolveDesktopLogPaths(new Date(), {
      overrideRoot: this.options.desktopLogRootOverride ?? null
    });

    if (resolution.directories.length === 0) {
      this.logDesktopNoticeOnce(resolution.reason);
      return [];
    }

    for (const directory of resolution.directories) {
      try {
        await access(directory);
      } catch {
        continue;
      }

      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(directory, entry.name))
        .sort();
    }

    if (resolution.source === "mac-default" && !this.options.desktopLogRootOverride) {
      this.logDesktopNoticeOnce(
        "Codex Desktop log discovery is best-effort on macOS. No logs were found in the default macOS locations. Set CODEX_DESKTOP_LOG_ROOT if Desktop inspection stays empty."
      );
    }

    return [];
  }

  private logDesktopNoticeOnce(message: string | null): void {
    if (!message || this.desktopLogNoticePrinted) {
      return;
    }

    this.desktopLogNoticePrinted = true;
    this.logger.info(message);
  }

  private parseChunk(
    threadId: string,
    filePath: string,
    chunk: string,
    chunkStartOffset: number
  ): CodexSessionEvent[] {
    const priorRemainder = this.partialLineByThread.get(threadId) ?? "";
    const priorRemainderBytes = Buffer.byteLength(priorRemainder, "utf8");
    const effectiveStartOffset = Math.max(0, chunkStartOffset - priorRemainderBytes);
    const combinedBuffer = Buffer.from(`${priorRemainder}${chunk}`, "utf8");
    const events: CodexSessionEvent[] = [];

    let lineStart = 0;
    for (let index = 0; index < combinedBuffer.length; index += 1) {
      if (combinedBuffer[index] !== 0x0a) {
        continue;
      }

      let lineEnd = index;
      if (lineEnd > lineStart && combinedBuffer[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }

      const line = combinedBuffer.subarray(lineStart, lineEnd).toString("utf8");
      const sourceOffset = effectiveStartOffset + lineStart;
      const parsedEvents = this.parseLine(threadId, line, filePath, sourceOffset);
      events.push(...parsedEvents);
      lineStart = index + 1;
    }

    if (lineStart < combinedBuffer.length) {
      const remainder = combinedBuffer.subarray(lineStart).toString("utf8");
      this.partialLineByThread.set(threadId, remainder);
    } else {
      this.partialLineByThread.delete(threadId);
    }

    return events;
  }

  private parseDesktopChunk(filePath: string, chunk: string, chunkStartOffset: number): CodexSessionEvent[] {
    const priorRemainder = this.desktopPartialLineByFile.get(filePath) ?? "";
    const priorRemainderBytes = Buffer.byteLength(priorRemainder, "utf8");
    const effectiveStartOffset = Math.max(0, chunkStartOffset - priorRemainderBytes);
    const combinedBuffer = Buffer.from(`${priorRemainder}${chunk}`, "utf8");
    const events: CodexSessionEvent[] = [];

    let lineStart = 0;
    for (let index = 0; index < combinedBuffer.length; index += 1) {
      if (combinedBuffer[index] !== 0x0a) {
        continue;
      }

      let lineEnd = index;
      if (lineEnd > lineStart && combinedBuffer[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      const line = combinedBuffer.subarray(lineStart, lineEnd).toString("utf8");
      const sourceOffset = effectiveStartOffset + lineStart;
      events.push(...this.parseDesktopLine(line, filePath, sourceOffset));
      lineStart = index + 1;
    }

    if (lineStart < combinedBuffer.length) {
      const remainder = combinedBuffer.subarray(lineStart).toString("utf8");
      this.desktopPartialLineByFile.set(filePath, remainder);
    } else {
      this.desktopPartialLineByFile.delete(filePath);
    }

    return events;
  }

  private parseLine(
    threadId: string,
    line: string,
    sourceFilePath: string,
    sourceOffset: number,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    let envelope: ResponseItemEnvelope;
    try {
      envelope = JSON.parse(trimmed) as ResponseItemEnvelope;
    } catch (error) {
      this.logger.debug({ error, threadId, line: trimmed }, "Failed to parse session log JSON line.");
      return [];
    }

    const envelopeType = typeof envelope.type === "string" ? envelope.type : null;
    const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : null;
    const timestampMs = this.parseTimestampMs(envelope.timestamp);

    if (envelopeType === "turn_context") {
      const turnId = this.extractTurnId(payload);
      if (turnId) {
        this.setCurrentTurnId(threadId, turnId, parseState);
      }
      return [];
    }

    if (envelopeType === "event_msg") {
      return this.withSourceMeta(
        this.parseEventMessage(threadId, payload, timestampMs, parseState),
        sourceFilePath,
        sourceOffset
      );
    }

    if (envelopeType !== "response_item" || !payload) {
      return [];
    }

    if (payload.type === "function_call") {
      return this.withSourceMeta(
        this.parseFunctionCall(threadId, payload, timestampMs, parseState),
        sourceFilePath,
        sourceOffset
      );
    }
    if (payload.type === "function_call_output") {
      return this.withSourceMeta(
        this.parseFunctionCallOutput(threadId, payload, timestampMs, parseState),
        sourceFilePath,
        sourceOffset
      );
    }
    if (payload.type === "custom_tool_call") {
      return this.withSourceMeta(
        this.parseCustomToolCall(threadId, payload, timestampMs, parseState),
        sourceFilePath,
        sourceOffset
      );
    }
    if (payload.type === "message") {
      return this.withSourceMeta(
        this.parseResponseMessage(threadId, payload, timestampMs, parseState),
        sourceFilePath,
        sourceOffset
      );
    }
    return [];
  }

  private parseBackfillLine(
    threadId: string,
    line: string,
    sourceFilePath: string,
    sourceOffset: number,
    parseState?: SessionThreadParseState
  ): SessionBackfillEvent[] {
    const parsedLine = this.parseBackfillLineMetadata(line, threadId);
    if (!parsedLine) {
      return [];
    }

    if (parsedLine.classification === "turnContext") {
      if (parsedLine.turnId) {
        this.setCurrentTurnId(threadId, parsedLine.turnId, parseState);
      }
      return [];
    }

    if (!parsedLine.payload) {
      return [];
    }

    const parsedEvents =
      parsedLine.classification === "eventUserMessage"
        ? this.parseEventMessage(threadId, parsedLine.payload, parsedLine.timestampMs, parseState)
        : parsedLine.classification === "responseUserMessage" ||
            parsedLine.classification === "responseAssistantMessage"
          ? this.parseResponseMessage(threadId, parsedLine.payload, parsedLine.timestampMs, parseState)
          : parsedLine.classification === "relevantFunctionCall"
            ? this.parseFunctionCall(threadId, parsedLine.payload, parsedLine.timestampMs, parseState)
            : parsedLine.classification === "functionCallOutput"
              ? this.parseFunctionCallOutput(threadId, parsedLine.payload, parsedLine.timestampMs, parseState)
              : parsedLine.classification === "completedApplyPatch"
                ? this.parseCustomToolCall(threadId, parsedLine.payload, parsedLine.timestampMs, parseState)
                : [];
    return this.withSourceMeta(
      parsedEvents.filter((event): event is SessionBackfillEvent => this.isBackfillEvent(event)),
      sourceFilePath,
      sourceOffset
    ) as SessionBackfillEvent[];
  }

  private parseBackfillLineMetadata(line: string, threadId?: string): ParsedBackfillLine | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    let envelope: ResponseItemEnvelope;
    try {
      envelope = JSON.parse(trimmed) as ResponseItemEnvelope;
    } catch (error) {
      this.logger.debug({ error, threadId, line: trimmed }, "Failed to parse session log JSON line.");
      return null;
    }

    const envelopeType = typeof envelope.type === "string" ? envelope.type : null;
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as Record<string, unknown>)
        : null;
    const timestampMs = this.parseTimestampMs(envelope.timestamp);
    const turnId = this.extractTurnId(payload);

    if (envelopeType === "turn_context") {
      return {
        classification: "turnContext",
        payload,
        timestampMs,
        turnId
      };
    }

    if (!payload) {
      return {
        classification: "irrelevant",
        payload: null,
        timestampMs,
        turnId: null
      };
    }

    if (envelopeType === "event_msg") {
      const eventType = typeof payload.type === "string" ? payload.type : null;
      const message = typeof payload.message === "string" ? payload.message.trim() : "";
      return {
        classification:
          eventType === "user_message" && message && !this.isInjectedInstructionBlock(message)
            ? "eventUserMessage"
            : "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    if (envelopeType !== "response_item") {
      return {
        classification: "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    const payloadType = typeof payload.type === "string" ? payload.type : null;
    if (payloadType === "message") {
      const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
      const textInfo = this.extractResponsePayloadTextInfo(payload);
      return {
        classification:
          textInfo && !this.isInjectedInstructionBlock(textInfo.text)
            ? role === "user"
              ? "responseUserMessage"
              : role === "assistant"
                ? "responseAssistantMessage"
                : "irrelevant"
            : "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    if (payloadType === "function_call") {
      const toolName = typeof payload.name === "string" ? payload.name : null;
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      return {
        classification:
          callId && (toolName === "shell_command" || toolName === "spawn_agent")
            ? "relevantFunctionCall"
            : "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    if (payloadType === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const output = typeof payload.output === "string" ? payload.output : null;
      return {
        classification: callId && output !== null ? "functionCallOutput" : "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    if (payloadType === "custom_tool_call") {
      const toolName = typeof payload.name === "string" ? payload.name : null;
      const status = typeof payload.status === "string" ? payload.status : null;
      const input = typeof payload.input === "string" ? payload.input : null;
      return {
        classification:
          toolName === "apply_patch" && status === "completed" && input && this.summarizeApplyPatchInput(input)
            ? "completedApplyPatch"
            : "irrelevant",
        payload,
        timestampMs,
        turnId
      };
    }

    return {
      classification: "irrelevant",
      payload,
      timestampMs,
      turnId
    };
  }

  private isBackfillLineConversationUserAnchor(parsedLine: ParsedBackfillLine): boolean {
    const payload = parsedLine.payload;
    if (!payload) {
      return false;
    }
    if (parsedLine.classification === "eventUserMessage") {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      return Boolean(text && isConversationUserAnchorText(text));
    }
    if (parsedLine.classification !== "responseUserMessage") {
      return false;
    }
    const textInfo = this.extractResponsePayloadTextInfo(payload);
    return Boolean(
      textInfo &&
      !textInfo.hasInputText &&
      isConversationUserAnchorText(textInfo.text)
    );
  }

  private isSessionConversationUserAnchor(event: SessionBackfillEvent): boolean {
    return (
      event.type === "sessionUserMessage" &&
      !event.isSyntheticSubagentInstruction &&
      isConversationUserAnchorText(event.text)
    );
  }

  private withSourceMeta(
    events: CodexSessionEvent[],
    sourceFilePath: string,
    sourceOffset: number
  ): CodexSessionEvent[] {
    if (events.length === 0) {
      return events;
    }

    return events.map((event, index) => ({
      ...event,
      sourceFilePath,
      sourceOffset,
      sourceOrder: this.formatSourceOrder(sourceOffset, index),
      eventKey: event.eventKey ?? `line:${sourceOffset}:${index}`
    }));
  }

  private formatSourceOrder(sourceOffset: number, lineEventIndex: number): string {
    const normalizedOffset = Number.isFinite(sourceOffset) ? Math.max(0, Math.trunc(sourceOffset)) : 0;
    const normalizedIndex = Number.isFinite(lineEventIndex)
      ? Math.max(0, Math.trunc(lineEventIndex))
      : 0;
    return `${String(normalizedOffset).padStart(16, "0")}:${String(normalizedIndex).padStart(4, "0")}`;
  }

  private parseFunctionCall(
    threadId: string,
    payload: Record<string, unknown>,
    timestampMs: number | null,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    const toolName = typeof payload.name === "string" ? payload.name : null;
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (!toolName || !callId) {
      return [];
    }

    const turnId = this.resolveEffectiveTurnId(threadId, payload, parseState);

    const argumentsPayload = this.parseArgumentsPayload(payload.arguments);
    const context: SessionToolCallContext = {
      toolName,
      command: typeof argumentsPayload.command === "string" ? argumentsPayload.command : null,
      cwd: typeof argumentsPayload.workdir === "string" ? argumentsPayload.workdir : null,
      justification: typeof argumentsPayload.justification === "string" ? argumentsPayload.justification : null,
      prefixRule: this.parsePrefixRule(argumentsPayload.prefix_rule),
      timestampMs,
      requiresApproval: argumentsPayload.sandbox_permissions === "require_escalated",
      spawnAgentPrompt: typeof argumentsPayload.message === "string" ? argumentsPayload.message : null
    };

    const calls = this.getOpenToolCalls(threadId, parseState);
    calls.set(callId, context);
    this.setOpenToolCalls(threadId, calls, parseState);

    if (toolName !== "shell_command" || !context.requiresApproval) {
      return [];
    }

    return [
      {
        type: "shellApprovalRequested",
        eventKey: `shell-approval:${callId}`,
        threadId,
        callId,
        turnId,
        timestampMs,
        command: context.command,
        cwd: context.cwd,
        justification: context.justification,
        prefixRule: context.prefixRule,
        details: JSON.stringify(argumentsPayload, null, 2)
      }
    ];
  }

  private parseFunctionCallOutput(
    threadId: string,
    payload: Record<string, unknown>,
    timestampMs: number | null,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const output = typeof payload.output === "string" ? payload.output : null;
    if (!callId || output === null) {
      return [];
    }

    const turnId = this.resolveEffectiveTurnId(threadId, payload, parseState);
    const calls = this.peekOpenToolCalls(threadId, parseState);
    const context = calls?.get(callId) ?? null;
    if (!context) {
      this.logger.debug(
        { threadId, callId, turnId },
        "Dropping function_call_output without a matching tool-call context."
      );
      return [];
    }

    calls?.delete(callId);
    if (context.toolName === "spawn_agent") {
      const outputPayload = this.parseArgumentsPayload(output);
      const childThreadId =
        typeof outputPayload.agent_id === "string" && outputPayload.agent_id.trim().length > 0
          ? outputPayload.agent_id.trim()
          : null;
      if (!childThreadId) {
        return [];
      }

      return [
        {
          type: "sessionSubagentSpawned",
          eventKey: `subagent-spawn:${childThreadId}`,
          threadId,
          turnId,
          childThreadId,
          childAgentName:
            typeof outputPayload.nickname === "string" && outputPayload.nickname.trim().length > 0
              ? outputPayload.nickname.trim()
              : null,
          prompt: context.spawnAgentPrompt,
          timestampMs
        }
      ];
    }
    if (context.toolName !== "shell_command") {
      return [];
    }

    return [
      {
        type: "shellCommandCompleted",
        eventKey: `shell-command:${callId}`,
        threadId,
        callId,
        turnId,
        timestampMs,
        command: context?.command ?? null,
        cwd: context?.cwd ?? null,
        output,
        status: this.parseShellCommandStatus(output)
      }
    ];
  }

  private parseEventMessage(
    threadId: string,
    payload: Record<string, unknown> | null,
    timestampMs: number | null,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    if (!payload) {
      return [];
    }

    const eventType = typeof payload.type === "string" ? payload.type : null;
    if (eventType === "turn_context") {
      const turnId = this.extractTurnId(payload);
      if (turnId) {
        this.setCurrentTurnId(threadId, turnId, parseState);
      }
      return [];
    }

    const turnId = this.resolveEffectiveTurnId(threadId, payload, parseState);
    if (eventType === "user_message") {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (!text || this.isInjectedInstructionBlock(text)) {
        return [];
      }
      return [
        {
          type: "sessionUserMessage",
          threadId,
          turnId,
          timestampMs,
          text,
          isSyntheticSubagentInstruction: false
        }
      ];
    }

    if (eventType === "collab_agent_spawn_end") {
      const childThreadId =
        typeof payload.new_thread_id === "string" && payload.new_thread_id.trim().length > 0
          ? payload.new_thread_id.trim()
          : null;
      if (!childThreadId) {
        return [];
      }

      const parentThreadId =
        typeof payload.sender_thread_id === "string" && payload.sender_thread_id.trim().length > 0
          ? payload.sender_thread_id.trim()
          : threadId;
      const childAgentName =
        typeof payload.new_agent_nickname === "string" && payload.new_agent_nickname.trim().length > 0
          ? payload.new_agent_nickname.trim()
          : null;
      const prompt =
        typeof payload.prompt === "string" && payload.prompt.trim().length > 0
          ? payload.prompt.trim()
          : null;

      return [
        {
          type: "sessionSubagentSpawned",
          eventKey: `subagent-spawn:${childThreadId}`,
          threadId: parentThreadId,
          turnId,
          childThreadId,
          childAgentName,
          prompt,
          timestampMs
        }
      ];
    }

    return [];
  }

  private parseResponseMessage(
    threadId: string,
    payload: Record<string, unknown>,
    timestampMs: number | null,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
    if (role !== "assistant" && role !== "user") {
      return [];
    }

    const textInfo = this.extractResponsePayloadTextInfo(payload);
    if (!textInfo || this.isInjectedInstructionBlock(textInfo.text)) {
      return [];
    }

    const turnId = this.resolveEffectiveTurnId(threadId, payload, parseState);
    const payloadItemId = typeof payload.id === "string" && payload.id.trim().length > 0
      ? payload.id.trim()
      : null;
    const eventKey = payloadItemId ? `response-message:${payloadItemId}` : null;

    if (role === "user") {
      return [
        {
          type: "sessionUserMessage",
          ...(eventKey ? { eventKey } : {}),
          threadId,
          turnId,
          timestampMs,
          text: textInfo.text,
          isSyntheticSubagentInstruction: textInfo.hasInputText
        }
      ];
    }

    return [
      {
        type: "sessionAgentMessage",
        ...(eventKey ? { eventKey } : {}),
        threadId,
        turnId,
        timestampMs,
        text: textInfo.text,
        phase: typeof payload.phase === "string" ? payload.phase : null
      }
    ];
  }

  private extractResponsePayloadTextInfo(
    payload: Record<string, unknown>
  ): { text: string; hasInputText: boolean } | null {
    const directText = typeof payload.text === "string" ? payload.text.trim() : "";
    if (directText) {
      return {
        text: directText,
        hasInputText: false
      };
    }

    const content = Array.isArray(payload.content)
      ? payload.content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
      : [];
    if (content.length === 0) {
      return null;
    }

    const fragments: string[] = [];
    let hasInputText = false;
    for (const part of content) {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (text) {
        fragments.push(text);
        continue;
      }
      const inputText = typeof part.input_text === "string" ? part.input_text.trim() : "";
      if (inputText) {
        hasInputText = true;
        fragments.push(inputText);
      }
    }

    const combined = fragments.join("\n").trim();
    if (!combined) {
      return null;
    }

    return {
      text: combined,
      hasInputText
    };
  }

  private parseCustomToolCall(
    threadId: string,
    payload: Record<string, unknown>,
    timestampMs: number | null,
    parseState?: SessionThreadParseState
  ): CodexSessionEvent[] {
    const toolName = typeof payload.name === "string" ? payload.name : null;
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const status = typeof payload.status === "string" ? payload.status : null;
    if (!toolName || !callId) {
      return [];
    }

    const turnId = this.resolveEffectiveTurnId(threadId, payload, parseState);
    if (toolName !== "apply_patch" || status !== "completed") {
      return [];
    }

    const input = typeof payload.input === "string" ? payload.input : null;
    if (!input) {
      return [];
    }

    const summary = this.summarizeApplyPatchInput(input);
    if (!summary) {
      return [];
    }

    return [
      {
        type: "sessionApplyPatchCompleted",
        eventKey: `apply-patch:${callId}`,
        threadId,
        turnId,
        callId,
        timestampMs,
        summary: summary.text,
        fileCounts: summary.fileCounts,
        details: input
      }
    ];
  }

  private summarizeApplyPatchInput(input: string): {
    text: string;
    fileCounts: {
      created: number;
      edited: number;
      deleted: number;
      createdPaths: string[];
      editedPaths: string[];
      deletedPaths: string[];
    };
  } | null {
    const lines = input.split(/\r?\n/);
    const collected: Array<{
      kind: "added" | "edited" | "deleted";
      path: string;
      added: number;
      deleted: number;
    }> = [];
    let current:
      | {
          kind: "added" | "edited" | "deleted";
          path: string;
          added: number;
          deleted: number;
        }
      | null = null;

    const flushCurrent = () => {
      if (!current || !current.path) {
        return;
      }
      collected.push(current);
      current = null;
    };

    for (const line of lines) {
      const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
      if (addMatch?.[1]) {
        flushCurrent();
        current = {
          kind: "added",
          path: addMatch[1].trim(),
          added: 0,
          deleted: 0
        };
        continue;
      }
      const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
      if (updateMatch?.[1]) {
        flushCurrent();
        current = {
          kind: "edited",
          path: updateMatch[1].trim(),
          added: 0,
          deleted: 0
        };
        continue;
      }
      const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
      if (deleteMatch?.[1]) {
        flushCurrent();
        current = {
          kind: "deleted",
          path: deleteMatch[1].trim(),
          added: 0,
          deleted: 0
        };
        continue;
      }

      const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
      if (moveMatch?.[1] && current) {
        current.path = moveMatch[1].trim();
        continue;
      }

      if (!current) {
        continue;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.added += 1;
        continue;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        current.deleted += 1;
      }
    }

    flushCurrent();
    if (collected.length === 0) {
      return null;
    }

    const changes = collected.map(
      (change) => `${change.kind} \`${change.path}\` +${change.added} -${change.deleted}`
    );
    const uniqueChanges = [...new Set(changes)];
    const visible = uniqueChanges.slice(0, 6);
    const remainder = uniqueChanges.length - visible.length;
    const fileCounts = collected.reduce(
      (counts, change) => {
        if (change.kind === "added") {
          counts.created += 1;
          counts.createdPaths.push(change.path);
        } else if (change.kind === "deleted") {
          counts.deleted += 1;
          counts.deletedPaths.push(change.path);
        } else {
          counts.edited += 1;
          counts.editedPaths.push(change.path);
        }
        return counts;
      },
      {
        created: 0,
        edited: 0,
        deleted: 0,
        createdPaths: [] as string[],
        editedPaths: [] as string[],
        deletedPaths: [] as string[]
      }
    );
    return {
      text: remainder > 0 ? `${visible.join(", ")} (+${remainder} more)` : visible.join(", "),
      fileCounts
    };
  }

  private extractTurnId(payload: Record<string, unknown> | null): string | null {
    if (!payload) {
      return null;
    }

    const candidates = [payload.turn_id, payload.turnId];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }

  private createIsolatedThreadParseState(): SessionThreadParseState {
    return {
      currentTurnId: null,
      openToolCalls: new Map<string, SessionToolCallContext>()
    };
  }

  private async resolveResumeOffsetFromMirroredSourceFrontier(
    existingBridge: ThreadBridgeRecord | undefined,
    filePath: string,
    fileSize: number
  ): Promise<number | null> {
    if (
      !existingBridge?.latestMirroredSourceFilePath ||
      existingBridge.latestMirroredSourceFilePath !== filePath ||
      typeof existingBridge.latestMirroredSourceOffset !== "number" ||
      !Number.isFinite(existingBridge.latestMirroredSourceOffset)
    ) {
      return null;
    }

    const sourceOffset = Math.max(0, Math.trunc(existingBridge.latestMirroredSourceOffset));
    if (sourceOffset >= fileSize) {
      return fileSize;
    }

    const handle = await open(filePath, "r");
    try {
      let position = sourceOffset;
      const chunkSize = 4096;
      const buffer = Buffer.alloc(chunkSize);
      while (position < fileSize) {
        const bytesToRead = Math.min(chunkSize, fileSize - position);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) {
          break;
        }
        const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
        if (newlineIndex >= 0) {
          return position + newlineIndex + 1;
        }
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }

    return fileSize;
  }

  private seedLiveParseStateFromExistingBridge(
    threadId: string,
    existingBridge: ThreadBridgeRecord | undefined
  ): void {
    if (this.currentTurnIdByThread.has(threadId)) {
      return;
    }
    const hintedTurnId = this.advisoryTurnHintByThread.get(threadId) ?? null;
    if (hintedTurnId) {
      this.currentTurnIdByThread.set(threadId, hintedTurnId);
      return;
    }
    const resumedTurnId = this.extractTurnIdFromMirroredTurnCursor(
      existingBridge?.latestMirroredTurnCursor ?? null
    );
    if (resumedTurnId) {
      this.currentTurnIdByThread.set(threadId, resumedTurnId);
    }
  }

  private extractTurnIdFromMirroredTurnCursor(turnCursor: string | null | undefined): string | null {
    if (typeof turnCursor !== "string") {
      return null;
    }
    const normalized = turnCursor.trim();
    if (!normalized) {
      return null;
    }
    if (normalized.startsWith("turn:")) {
      const turnId = normalized.slice("turn:".length).trim();
      return turnId || null;
    }
    const timestampCursorMatch = normalized.match(/^\d{16}:(.+)$/);
    if (!timestampCursorMatch) {
      return null;
    }
    const turnId = timestampCursorMatch[1]?.trim() ?? "";
    if (!turnId || turnId.startsWith("turn-")) {
      return null;
    }
    return turnId;
  }

  private commitBackfillParseState(
    threadId: string,
    filePath: string,
    scanEndOffset: number,
    parseState: SessionThreadParseState
  ): void {
    const liveCursor = this.stateStore.getSessionLogCursor(threadId);
    if (
      liveCursor &&
      (liveCursor.filePath !== filePath || liveCursor.byteOffset > scanEndOffset)
    ) {
      return;
    }

    if (parseState.currentTurnId && !this.currentTurnIdByThread.has(threadId)) {
      this.currentTurnIdByThread.set(threadId, parseState.currentTurnId);
    }

    if (parseState.openToolCalls.size === 0) {
      return;
    }

    const liveOpenToolCalls = this.openToolCallsByThread.get(threadId);
    if (!liveOpenToolCalls || liveOpenToolCalls.size === 0) {
      this.openToolCallsByThread.set(threadId, new Map(parseState.openToolCalls));
      return;
    }

    for (const [callId, context] of parseState.openToolCalls.entries()) {
      if (!liveOpenToolCalls.has(callId)) {
        liveOpenToolCalls.set(callId, context);
      }
    }
  }

  private resolveEffectiveTurnId(
    threadId: string,
    payload: Record<string, unknown> | null,
    parseState?: SessionThreadParseState
  ): string | null {
    const explicitTurnId = this.extractTurnId(payload);
    if (explicitTurnId) {
      this.setCurrentTurnId(threadId, explicitTurnId, parseState);
      return explicitTurnId;
    }
    return this.getCurrentTurnId(threadId, parseState);
  }

  private getCurrentTurnId(threadId: string, parseState?: SessionThreadParseState): string | null {
    if (parseState) {
      return parseState.currentTurnId;
    }
    const currentTurnId = this.currentTurnIdByThread.get(threadId) ?? null;
    if (currentTurnId) {
      return currentTurnId;
    }
    const hintedTurnId = this.advisoryTurnHintByThread.get(threadId) ?? null;
    if (!hintedTurnId) {
      return null;
    }
    this.currentTurnIdByThread.set(threadId, hintedTurnId);
    return hintedTurnId;
  }

  private setCurrentTurnId(
    threadId: string,
    turnId: string | null,
    parseState?: SessionThreadParseState
  ): void {
    if (parseState) {
      parseState.currentTurnId = turnId;
      return;
    }
    if (turnId) {
      this.currentTurnIdByThread.set(threadId, turnId);
      this.advisoryTurnHintByThread.set(threadId, turnId);
      return;
    }
    this.currentTurnIdByThread.delete(threadId);
    this.advisoryTurnHintByThread.delete(threadId);
  }

  private getOpenToolCalls(
    threadId: string,
    parseState?: SessionThreadParseState
  ): Map<string, SessionToolCallContext> {
    if (parseState) {
      return parseState.openToolCalls;
    }
    return this.openToolCallsByThread.get(threadId) ?? new Map<string, SessionToolCallContext>();
  }

  private peekOpenToolCalls(
    threadId: string,
    parseState?: SessionThreadParseState
  ): Map<string, SessionToolCallContext> | undefined {
    if (parseState) {
      return parseState.openToolCalls;
    }
    return this.openToolCallsByThread.get(threadId);
  }

  private setOpenToolCalls(
    threadId: string,
    calls: Map<string, SessionToolCallContext>,
    parseState?: SessionThreadParseState
  ): void {
    if (parseState) {
      parseState.openToolCalls = calls;
      return;
    }
    this.openToolCallsByThread.set(threadId, calls);
  }

  private parseArgumentsPayload(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") {
      return {};
    }

    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private parsePrefixRule(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const entries = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries : null;
  }

  private parseDesktopLine(line: string, sourceFilePath: string, sourceOffset: number): CodexSessionEvent[] {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }

    const commandApprovalMatch = trimmed.match(
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+show approval conversationId=(?<threadId>\S+)\s+kind=commandExecution\s+requestId=(?<requestId>\S+)/
    );
    if (commandApprovalMatch?.groups) {
      const { threadId, requestId, timestamp } = commandApprovalMatch.groups as {
        threadId?: string;
        requestId?: string;
        timestamp?: string;
      };
      if (!threadId || !requestId) {
        return [];
      }
      return this.withSourceMeta([
        {
          type: "nativeCommandApprovalRequested",
          eventKey: `desktop-approval-request:${requestId}`,
          threadId,
          requestId,
          timestampMs: this.parseTimestampMs(timestamp ?? null)
        }
      ], sourceFilePath, sourceOffset);
    }

    const questionMatch = trimmed.match(
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+show question conversationId=(?<threadId>\S+)\s+questionCount=(?<questionCount>\d+)\s+requestId=(?<requestId>\S+)/
    );
    if (questionMatch?.groups) {
      const { threadId, requestId, questionCount, timestamp } = questionMatch.groups as {
        threadId?: string;
        requestId?: string;
        questionCount?: string;
        timestamp?: string;
      };
      if (!threadId || !requestId) {
        return [];
      }
      return this.withSourceMeta([
        {
          type: "nativeQuestionRequested",
          eventKey: `desktop-question-request:${requestId}`,
          threadId,
          requestId,
          questionCount: Number.parseInt(questionCount ?? "0", 10) || 0,
          timestampMs: this.parseTimestampMs(timestamp ?? null)
        }
      ], sourceFilePath, sourceOffset);
    }

    const responseMatch = trimmed.match(
      /^(?<timestamp>\S+)\s+\w+\s+\[electron-message-handler\]\s+Sending server response id=(?<requestId>\S+)\s+method=(?<method>\S+)\s+response=(?<response>.+)$/
    );
    if (responseMatch?.groups) {
      const { requestId, method, response: rawResponse, timestamp } = responseMatch.groups as {
        requestId?: string;
        method?: string;
        response?: string;
        timestamp?: string;
      };
      if (!requestId || !method) {
        return [];
      }
      let response: unknown = rawResponse ?? null;
      try {
        response = JSON.parse(rawResponse ?? "null");
      } catch {
        // Leave the raw string when the desktop log contains a non-JSON payload.
      }
      return this.withSourceMeta([
        {
          type: "nativeApprovalResolved",
          eventKey: `desktop-resolution:${requestId}:${method}`,
          threadId: null,
          requestId,
          method,
          timestampMs: this.parseTimestampMs(timestamp ?? null),
          response
        }
      ], sourceFilePath, sourceOffset);
    }

    return [];
  }

  private parseShellCommandStatus(output: string): string | null {
    const exitCodeMatch = output.match(/Exit code:\s*(-?\d+)/i);
    if (exitCodeMatch) {
      const exitCode = Number.parseInt(exitCodeMatch[1] ?? "", 10);
      if (Number.isFinite(exitCode) && exitCode !== 0) {
        return `exit ${exitCode}`;
      }
      return null;
    }

    if (/execution error:/i.test(output)) {
      return "execution error";
    }

    return null;
  }

  private isInjectedInstructionBlock(text: string): boolean {
    return (
      text.startsWith("<INSTRUCTIONS>") ||
      text.startsWith("<environment_context>") ||
      (text.includes("AGENTS.md instructions for") &&
        (text.includes("<INSTRUCTIONS>") || text.includes("<environment_context>")))
    );
  }

  private parseTimestampMs(value: unknown): number | null {
    if (typeof value !== "string") {
      return null;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

}
