export interface StartupThreadWriteStats {
  totalWrites: number;
  statusCardWrites: number;
  liveMessageWrites: number;
  textMessageWrites: number;
}

export interface StartupCacheStats {
  channelSnapshotHits: number;
  channelSnapshotMisses: number;
  writableTargetHits: number;
  writableTargetMisses: number;
  messageHits: number;
  messageMisses: number;
  statusCardLookupHits: number;
  statusCardLookupMisses: number;
}

export interface StartupTransportContext {
  startupPhase: "cold-attach" | null;
  compactStartupReplay: boolean;
  threadWriteStats: Map<string, StartupThreadWriteStats>;
  cacheStats: StartupCacheStats;
}

export interface ProviderOperationContext {
  startup?: StartupTransportContext | null;
  threadId?: string | null;
  isolateProjectCategory?: boolean;
  projectScope?: string | null;
}

export function createStartupTransportContext(): StartupTransportContext {
  return {
    startupPhase: "cold-attach",
    compactStartupReplay: true,
    threadWriteStats: new Map<string, StartupThreadWriteStats>(),
    cacheStats: {
      channelSnapshotHits: 0,
      channelSnapshotMisses: 0,
      writableTargetHits: 0,
      writableTargetMisses: 0,
      messageHits: 0,
      messageMisses: 0,
      statusCardLookupHits: 0,
      statusCardLookupMisses: 0
    }
  };
}

export function createProviderOperationContext(
  threadId: string | null,
  startup?: StartupTransportContext | null,
  options: {
    isolateProjectCategory?: boolean;
    projectScope?: string | null;
  } = {}
): ProviderOperationContext {
  return {
    startup: startup ?? null,
    threadId,
    isolateProjectCategory: options.isolateProjectCategory ?? false,
    projectScope: options.projectScope?.trim() || null
  };
}

export function recordStartupWrite(
  context: ProviderOperationContext | undefined,
  kind: "status" | "live" | "text"
): void {
  const startup = context?.startup;
  const threadId = context?.threadId?.trim() ?? "";
  if (!startup || startup.startupPhase !== "cold-attach" || !threadId) {
    return;
  }

  const existing = startup.threadWriteStats.get(threadId) ?? {
    totalWrites: 0,
    statusCardWrites: 0,
    liveMessageWrites: 0,
    textMessageWrites: 0
  };
  existing.totalWrites += 1;
  if (kind === "status") {
    existing.statusCardWrites += 1;
  } else if (kind === "live") {
    existing.liveMessageWrites += 1;
  } else {
    existing.textMessageWrites += 1;
  }
  startup.threadWriteStats.set(threadId, existing);
}

export function recordStartupCacheStat(
  context: ProviderOperationContext | undefined,
  kind: keyof StartupCacheStats
): void {
  const startup = context?.startup;
  if (!startup || startup.startupPhase !== "cold-attach") {
    return;
  }
  startup.cacheStats[kind] += 1;
}
