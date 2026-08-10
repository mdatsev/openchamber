import { ACTIVITY_STANDALONE_TOOL_NAMES } from './constants';
import type {
    TranscriptMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';

const isStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && ACTIVITY_STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

const getPartEndTime = (part: TranscriptMessageEntry['parts'][number]): number | undefined => {
    if (part.kind === 'tool') return part.state.time?.end;
    return part.time?.end;
};

const getPartText = (part: TranscriptMessageEntry['parts'][number]): string | undefined => (
    (part.kind === 'text' || part.kind === 'reasoning') && part.text.trim().length > 0 ? part.text : undefined
);

const getMessageFinish = (message: TranscriptMessageEntry): string | undefined => message.finish;

const isCompactionSummaryMessage = (message: TranscriptMessageEntry): boolean => message.isCompactionSummary === true;

const buildTurnPartRecord = (
    turnId: string,
    messageId: string,
    part: TranscriptMessageEntry['parts'][number],
    partIndex: number,
): TurnPartRecord => {
    return {
        id: part.id ?? `${messageId}-part-${partIndex}-${part.kind}`,
        turnId,
        messageId,
        part,
        partIndex,
        endedAt: getPartEndTime(part),
    };
};

interface ProjectActivityInput {
    turnId: string;
    assistantMessages: TranscriptMessageEntry[];
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    showTextJustificationActivity: boolean;
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
}

export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part) => {
            if (part.kind === 'tool') {
                hasTools = true;
                return;
            }

            if (part.kind === 'reasoning' && getPartText(part)) {
                hasReasoning = true;
            }
        });
    });

    const taskMessageById = new Map<string, string>();
    const taskOrder: string[] = [];
    const partsByAfterTool = new Map<string | null, TurnActivityRecord[]>();
    let currentAfterToolPartId: string | null = null;

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.kind === 'tool');
        const messageIsCompactionSummary = isCompactionSummaryMessage(message);

        message.parts.forEach((part, partIndex) => {
            const isTool = part.kind === 'tool';

            const text = part.kind === 'reasoning' || part.kind === 'text'
                ? getPartText(part)
                : undefined;
            const partId = part.id ?? `${message.id}-part-${partIndex}-${part.kind}`;

            const toolName = isTool
                ? part.kind === 'tool' ? part.tool : undefined
                : undefined;
            const standaloneTool = isTool && isStandaloneTool(toolName);
            if (standaloneTool) {
                const toolPartId = partId;
                if (!taskMessageById.has(toolPartId)) {
                    taskMessageById.set(toolPartId, message.id);
                    taskOrder.push(toolPartId);
                }
                currentAfterToolPartId = toolPartId;
            }

            const isConfirmedSummaryText = part.kind === 'text'
                && typeof text === 'string'
                && finish === 'stop'
                && input.summarySourceMessageId === message.id
                && input.summarySourcePartId === partId;

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.kind === 'reasoning') {
                if (text) {
                    kind = 'reasoning';
                }
            } else if (
                input.showTextJustificationActivity
                && part.kind === 'text'
                && text
                && (
                    messageIsCompactionSummary
                    || (
                        !isConfirmedSummaryText
                        && (messageHasTool || (typeof finish === 'string' && finish !== 'stop'))
                    )
                )
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            const activity: TurnActivityRecord = {
                ...buildTurnPartRecord(input.turnId, message.id, part, partIndex),
                kind,
            };
            activityParts.push(activity);

            if (kind === 'tool' && standaloneTool) {
                return;
            }

            const list = partsByAfterTool.get(currentAfterToolPartId) ?? [];
            list.push(activity);
            partsByAfterTool.set(currentAfterToolPartId, list);
        });
    });

    const activitySegments: TurnActivityGroup[] = [];

    const pickStartAnchor = (segmentParts: TurnActivityRecord[]): string | undefined => {
        if (segmentParts.length === 0) {
            return undefined;
        }

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        for (const message of input.assistantMessages) {
            const count = countByMessage.get(message.id) ?? 0;
            if (count > 0 && !firstWithAny) {
                firstWithAny = message.id;
            }
        }

        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...taskOrder];
    orderedKeys.forEach((afterToolPartId) => {
        const segmentParts = partsByAfterTool.get(afterToolPartId) ?? [];
        if (segmentParts.length === 0) {
            return;
        }

        const anchorMessageId = afterToolPartId === null
            ? pickStartAnchor(segmentParts)
            : taskMessageById.get(afterToolPartId);

        if (!anchorMessageId) {
            return;
        }

        activitySegments.push({
            id: `${input.turnId}:${anchorMessageId}:${afterToolPartId ?? 'start'}`,
            anchorMessageId,
            afterToolPartId,
            parts: segmentParts,
        });
    });

    return {
        activityParts,
        activitySegments,
        hasTools,
        hasReasoning,
    };
};
