import type { TranscriptMessage, TranscriptPart } from '../transcript/types';
import type { TurnActivityGroup, TurnActivityRecord, TurnChangedFile, TurnDiffStats, TurnGroupingContext } from '../lib/turns/types';

const readPartTime = (part: TranscriptPart) => part.kind === 'tool' ? part.state.time : part.time;

export const areRenderRelevantPartsEqual = (left: TranscriptPart[], right: TranscriptPart[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart.kind !== rightPart.kind || leftPart.id !== rightPart.id) return false;
    if (leftPart.kind === 'tool' && rightPart.kind === 'tool') {
      if (leftPart.tool !== rightPart.tool || leftPart.state !== rightPart.state || leftPart.metadata !== rightPart.metadata || leftPart.output !== rightPart.output) return false;
      continue;
    }
    const leftTime = readPartTime(leftPart);
    const rightTime = readPartTime(rightPart);
    if (leftTime?.start !== rightTime?.start || leftTime?.end !== rightTime?.end) return false;
    if ((leftPart.kind === 'text' || leftPart.kind === 'reasoning') && (rightPart.kind === 'text' || rightPart.kind === 'reasoning')) {
      if (leftPart.text !== rightPart.text) return false;
      if (leftPart.kind === 'text' && rightPart.kind === 'text') {
        if (leftPart.shellAction?.command !== rightPart.shellAction?.command
          || leftPart.shellAction?.output !== rightPart.shellAction?.output
          || leftPart.shellAction?.status !== rightPart.shellAction?.status) return false;
      }
    }
  }
  return true;
};

const areRenderRelevantMessageInfoEqual = (left: TranscriptMessage, right: TranscriptMessage): boolean => {
  if (left === right) return true;
  return left.id === right.id
    && left.role === right.role
    && left.sessionId === right.sessionId
    && left.finish === right.finish
    && left.status === right.status
    && left.mode === right.mode
    && left.agent === right.agent
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.variant === right.variant
    && left.modelVariant === right.modelVariant
    && left.synthetic === right.synthetic
    && left.userMessageMarker === right.userMessageMarker
    && left.createdAt === right.createdAt
    && left.completedAt === right.completedAt
    && left.error?.text === right.error?.text
    && left.error?.variant === right.error?.variant;
};

export const areRenderRelevantMessagesEqual = (left: TranscriptMessage, right: TranscriptMessage): boolean => (
  areRenderRelevantMessageInfoEqual(left, right) && areRenderRelevantPartsEqual(left.parts, right.parts)
);

export const areOptionalRenderRelevantMessagesEqual = (left?: TranscriptMessage, right?: TranscriptMessage): boolean => {
  if (!left || !right) return left === right;
  return areRenderRelevantMessagesEqual(left, right);
};

const areTurnDiffStatsEqual = (left?: TurnDiffStats, right?: TurnDiffStats): boolean => {
  if (!left || !right) {
    return left === right;
  }

  return left.additions === right.additions
    && left.deletions === right.deletions
    && left.files === right.files;
};

const areTurnChangedFilesEqual = (left?: TurnChangedFile[], right?: TurnChangedFile[]): boolean => {
  if (left === right) return true;
  if (!left || !right) return !left && !right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftFile = left[index];
    const rightFile = right[index];
    if (
      leftFile.file !== rightFile.file
      || leftFile.additions !== rightFile.additions
      || leftFile.deletions !== rightFile.deletions
    ) {
      return false;
    }
  }
  return true;
};

const areTurnActivityRecordsEqual = (left: TurnActivityRecord, right: TurnActivityRecord): boolean => {
  return left.id === right.id
    && left.messageId === right.messageId
    && left.kind === right.kind
    && left.partIndex === right.partIndex
    && left.endedAt === right.endedAt
    && areRenderRelevantPartsEqual([left.part], [right.part]);
};

const areRelevantActivityPartsEqual = (
  left: TurnActivityRecord[] | undefined,
  right: TurnActivityRecord[] | undefined,
  messageId: string,
): boolean => {
  let leftIndex = 0;
  let rightIndex = 0;

  while (true) {
    while (leftIndex < (left?.length ?? 0) && left?.[leftIndex]?.messageId !== messageId) {
      leftIndex += 1;
    }
    while (rightIndex < (right?.length ?? 0) && right?.[rightIndex]?.messageId !== messageId) {
      rightIndex += 1;
    }

    const leftRecord = left?.[leftIndex];
    const rightRecord = right?.[rightIndex];

    if (!leftRecord || !rightRecord) {
      return leftRecord === rightRecord;
    }

    if (!areTurnActivityRecordsEqual(leftRecord, rightRecord)) {
      return false;
    }

    leftIndex += 1;
    rightIndex += 1;
  }
};

const areTurnActivityGroupsEqual = (left: TurnActivityGroup, right: TurnActivityGroup): boolean => {
  if (left.id !== right.id || left.anchorMessageId !== right.anchorMessageId || left.afterToolPartId !== right.afterToolPartId) {
    return false;
  }

  if (left.parts.length !== right.parts.length) {
    return false;
  }

  for (let index = 0; index < left.parts.length; index += 1) {
    if (!areTurnActivityRecordsEqual(left.parts[index], right.parts[index])) {
      return false;
    }
  }

  return true;
};

const hasRelevantActivitySegments = (segments: TurnActivityGroup[] | undefined, messageId: string): boolean => {
  return Boolean(segments?.some((segment) => segment.anchorMessageId === messageId));
};

const areRelevantActivitySegmentsEqual = (
  left: TurnActivityGroup[] | undefined,
  right: TurnActivityGroup[] | undefined,
  messageId: string,
): boolean => {
  let leftIndex = 0;
  let rightIndex = 0;

  while (true) {
    while (leftIndex < (left?.length ?? 0) && left?.[leftIndex]?.anchorMessageId !== messageId) {
      leftIndex += 1;
    }
    while (rightIndex < (right?.length ?? 0) && right?.[rightIndex]?.anchorMessageId !== messageId) {
      rightIndex += 1;
    }

    const leftSegment = left?.[leftIndex];
    const rightSegment = right?.[rightIndex];

    if (!leftSegment || !rightSegment) {
      return leftSegment === rightSegment;
    }

    if (!areTurnActivityGroupsEqual(leftSegment, rightSegment)) {
      return false;
    }

    leftIndex += 1;
    rightIndex += 1;
  }
};

export const areRelevantTurnGroupingContextsEqual = (
  left: TurnGroupingContext | undefined,
  right: TurnGroupingContext | undefined,
  messageId: string,
  isUserMessage: boolean,
): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return left === right;
  }

  if (isUserMessage) {
    return true;
  }

  if (left.turnId !== right.turnId) return false;
  if (left.isFirstAssistantInTurn !== right.isFirstAssistantInTurn) return false;
  if (left.isLastAssistantInTurn !== right.isLastAssistantInTurn) return false;
  if (left.isLatestTurn !== right.isLatestTurn) return false;
  if (left.isWorking !== right.isWorking) return false;
  if (left.hasTools !== right.hasTools) return false;
  if (left.hasReasoning !== right.hasReasoning) return false;
  if (left.userMessageCreatedAt !== right.userMessageCreatedAt) return false;
  if (left.userMessageVariant !== right.userMessageVariant) return false;

  const headerRelevant = left.headerMessageId === messageId || right.headerMessageId === messageId;
  if (headerRelevant && left.headerMessageId !== right.headerMessageId) {
    return false;
  }

  const ownerRelevant = left.activityOwnerMessageId === messageId || right.activityOwnerMessageId === messageId;
  if (ownerRelevant && left.activityOwnerMessageId !== right.activityOwnerMessageId) {
    return false;
  }

  if (!areRelevantActivityPartsEqual(left.activityParts, right.activityParts, messageId)) {
    return false;
  }

  if (!areRelevantActivitySegmentsEqual(left.activityGroupSegments, right.activityGroupSegments, messageId)) {
    return false;
  }

  const segmentsRelevant = hasRelevantActivitySegments(left.activityGroupSegments, messageId)
    || hasRelevantActivitySegments(right.activityGroupSegments, messageId);

  if ((ownerRelevant || segmentsRelevant) && left.isGroupExpanded !== right.isGroupExpanded) {
    return false;
  }

  if ((ownerRelevant || segmentsRelevant) && left.toggleGroup !== right.toggleGroup) {
    return false;
  }

  if ((ownerRelevant || segmentsRelevant) && !areTurnDiffStatsEqual(left.diffStats, right.diffStats)) {
    return false;
  }

  if ((ownerRelevant || segmentsRelevant || left.isLastAssistantInTurn || right.isLastAssistantInTurn) && !areTurnChangedFilesEqual(left.changedFiles, right.changedFiles)) {
    return false;
  }

  return true;
};
