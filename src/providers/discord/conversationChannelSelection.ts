export interface ConversationChannelCandidate {
  id: string;
  name: string;
  parentId: string | null;
  topic: string | null;
  codexThreadId: string | null;
  bridgeScope: string | null;
  isBridgeManaged: boolean;
  createdTimestamp: number;
}

interface SelectConversationChannelInput {
  codexThreadId: string;
  desiredName: string;
  categoryId: string;
  preferredChannelId: string | null;
  allowCrossCategoryExactMatch?: boolean;
  bridgeScope?: string | null;
}

function compareConversationCandidatePriority(
  left: ConversationChannelCandidate,
  right: ConversationChannelCandidate,
  input: SelectConversationChannelInput
): number {
  const score = (candidate: ConversationChannelCandidate): number => {
    let value = 0;
    if (candidate.id === input.preferredChannelId) {
      value += 100;
    }
    if (candidate.parentId === input.categoryId) {
      value += 10;
    }
    if (candidate.name === input.desiredName) {
      value += 5;
    }
    return value;
  };

  const scoreDelta = score(right) - score(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  if (right.createdTimestamp !== left.createdTimestamp) {
    return right.createdTimestamp - left.createdTimestamp;
  }

  return left.id.localeCompare(right.id);
}

function isReusableConversationChannelByName(
  candidate: ConversationChannelCandidate,
  input: SelectConversationChannelInput
): boolean {
  if (candidate.parentId !== input.categoryId || candidate.name !== input.desiredName) {
    return false;
  }
  return (
    candidate.isBridgeManaged &&
    candidate.codexThreadId === null &&
    candidate.bridgeScope === (input.bridgeScope ?? null)
  );
}

export function selectCanonicalConversationChannel(
  candidates: ConversationChannelCandidate[],
  input: SelectConversationChannelInput
): {
  canonical: ConversationChannelCandidate | null;
  duplicates: ConversationChannelCandidate[];
} {
  const allowCrossCategoryExactMatch = input.allowCrossCategoryExactMatch ?? true;
  const bridgeScope = input.bridgeScope ?? null;
  const exactMatches = candidates.filter(
    (candidate) =>
      candidate.isBridgeManaged &&
      candidate.codexThreadId === input.codexThreadId &&
      candidate.bridgeScope === bridgeScope
  );
  const reusableExactMatches = allowCrossCategoryExactMatch
    ? exactMatches
    : exactMatches.filter(
        (candidate) => candidate.parentId === input.categoryId || candidate.id === input.preferredChannelId
      );
  if (reusableExactMatches.length > 0) {
    const [canonical, ...rest] = [...reusableExactMatches].sort((left, right) =>
      compareConversationCandidatePriority(left, right, input)
    );
    return {
      canonical: canonical ?? null,
      duplicates: rest
    };
  }

  const byName = candidates
    .filter((candidate) => isReusableConversationChannelByName(candidate, input))
    .sort((left, right) => compareConversationCandidatePriority(left, right, input))[0];

  return {
    canonical: byName ?? null,
    duplicates: []
  };
}
