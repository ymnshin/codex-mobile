export interface InspectionMessageCandidate {
  createdTimestamp: number;
  editedTimestamp: number | null;
  content: string;
}

export interface InspectionMessageSummary {
  activityTimestamp: number;
  preview: string | null;
}

export function selectLatestInspectionMessage(
  messages: readonly InspectionMessageCandidate[],
  summarize: (content: string) => string | null
): InspectionMessageSummary | null {
  if (messages.length === 0) {
    return null;
  }

  const latest = messages.reduce<InspectionMessageCandidate | null>((current, candidate) => {
    if (!current) {
      return candidate;
    }

    const currentActivity = current.editedTimestamp ?? current.createdTimestamp;
    const candidateActivity = candidate.editedTimestamp ?? candidate.createdTimestamp;
    return candidateActivity > currentActivity ? candidate : current;
  }, null);

  if (!latest) {
    return null;
  }

  return {
    activityTimestamp: latest.editedTimestamp ?? latest.createdTimestamp,
    preview: summarize(latest.content)
  };
}
