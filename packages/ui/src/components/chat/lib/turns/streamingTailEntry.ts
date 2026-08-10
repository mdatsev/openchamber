import { projectTurnRecords } from './projectTurnRecords';
import { adaptOpenCodeLiveParts, adaptOpenCodeTurnMessage } from '../../transcript/openCodeTurnCompatibility';
import type { ChatMessageEntry, TranscriptMessageEntry, TranscriptTurnRecord, TurnRecord } from './types';

export type TranscriptStreamingTailEntry =
    | { kind: 'ungrouped'; key: string; message: TranscriptMessageEntry; previousMessage?: TranscriptMessageEntry; nextMessage?: TranscriptMessageEntry }
    | { kind: 'turn'; key: string; turn: TranscriptTurnRecord; isLastTurn: boolean };

/** @deprecated OpenCode-shaped compatibility input. */
export type StreamingTailEntry =
    | { kind: 'ungrouped'; key: string; message: ChatMessageEntry; previousMessage?: ChatMessageEntry; nextMessage?: ChatMessageEntry }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
    activeStreamingMessageId: string | null | undefined;
    liveMessage: TranscriptMessageEntry | null | undefined;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    mergeHiddenUserTurns?: { planModeEnabled: boolean };
};

type LegacyBuildLiveStreamingEntryOptions = Omit<BuildLiveStreamingEntryOptions, 'liveMessage'> & {
    liveParts: ChatMessageEntry['parts'];
};

const withLiveMessage = (message: TranscriptMessageEntry, activeId: string, live: TranscriptMessageEntry | null | undefined) => (
    message.id === activeId && live ? live : message
);

const buildTranscriptLiveStreamingEntry = <TEntry extends TranscriptStreamingTailEntry>(
    entry: TEntry,
    options: BuildLiveStreamingEntryOptions,
): TEntry => {
    const activeId = options.activeStreamingMessageId;
    if (!activeId) return entry;
    if (entry.kind === 'ungrouped') {
        const message = withLiveMessage(entry.message, activeId, options.liveMessage);
        return message === entry.message ? entry : { ...entry, message } as TEntry;
    }
    let changed = false;
    const assistants = entry.turn.assistantMessages.map((message) => {
        const next = withLiveMessage(message, activeId, options.liveMessage);
        if (next !== message) changed = true;
        return next;
    });
    if (!changed) return entry;
    const liveById = new Map(assistants.map((message) => [message.id, message]));
    const source = entry.turn.messages.length > 0
        ? entry.turn.messages.slice().sort((a, b) => a.order - b.order).map((record) => liveById.get(record.messageId) ?? record.message)
        : [entry.turn.userMessage, ...assistants];
    const projection = projectTurnRecords(source, {
        showTextJustificationActivity: options.showTextJustificationActivity,
        showTurnChangedFiles: options.showTurnChangedFiles,
        mergeHiddenUserTurns: options.mergeHiddenUserTurns,
    });
    const turn = projection.turns[0] ?? { ...entry.turn, assistantMessages: assistants, assistantMessageIds: assistants.map((message) => message.id) };
    return { ...entry, turn } as TEntry;
};

const adaptLegacyEntry = (entry: StreamingTailEntry, planModeEnabled: boolean): TranscriptStreamingTailEntry => {
    if (entry.kind === 'ungrouped') return {
        ...entry,
        message: adaptOpenCodeTurnMessage(entry.message, planModeEnabled),
        previousMessage: entry.previousMessage ? adaptOpenCodeTurnMessage(entry.previousMessage, planModeEnabled) : undefined,
        nextMessage: entry.nextMessage ? adaptOpenCodeTurnMessage(entry.nextMessage, planModeEnabled) : undefined,
    };
    const adapt = (message: ChatMessageEntry) => adaptOpenCodeTurnMessage(message, planModeEnabled);
    return {
        ...entry,
        turn: {
            ...entry.turn,
            userMessage: adapt(entry.turn.userMessage),
            assistantMessages: entry.turn.assistantMessages.map(adapt),
            messages: entry.turn.messages.map((record) => ({ ...record, message: adapt(record.message) })),
        },
    };
};

export function buildLiveStreamingEntry<TEntry extends TranscriptStreamingTailEntry>(entry: TEntry, options: BuildLiveStreamingEntryOptions): TEntry;
/** @deprecated Pass a neutral liveMessage instead of SDK liveParts. */
export function buildLiveStreamingEntry(entry: StreamingTailEntry, options: LegacyBuildLiveStreamingEntryOptions): TranscriptStreamingTailEntry;
export function buildLiveStreamingEntry(
    entry: TranscriptStreamingTailEntry | StreamingTailEntry,
    options: BuildLiveStreamingEntryOptions | LegacyBuildLiveStreamingEntryOptions,
): TranscriptStreamingTailEntry {
    const firstMessage = entry.kind === 'ungrouped' ? entry.message : entry.turn.userMessage;
    if (!('info' in firstMessage)) return buildTranscriptLiveStreamingEntry(entry as TranscriptStreamingTailEntry, options as BuildLiveStreamingEntryOptions);
    const activeId = options.activeStreamingMessageId;
    if (!activeId) return adaptLegacyEntry(entry as StreamingTailEntry, options.mergeHiddenUserTurns?.planModeEnabled ?? false);
    const legacyEntry = entry as StreamingTailEntry;
    const rawMessages = legacyEntry.kind === 'ungrouped'
        ? [legacyEntry.message]
        : [legacyEntry.turn.userMessage, ...legacyEntry.turn.assistantMessages];
    const activeRaw = rawMessages.find((message) => message.info.id === activeId);
    if (!activeRaw) return entry as unknown as TranscriptStreamingTailEntry;
    const planMode = options.mergeHiddenUserTurns?.planModeEnabled ?? false;
    const baseLive = adaptOpenCodeTurnMessage(activeRaw, planMode);
    const liveMessage = 'liveMessage' in options
        ? options.liveMessage
        : { ...baseLive, parts: adaptOpenCodeLiveParts(options.liveParts, activeId) };
    return buildTranscriptLiveStreamingEntry(adaptLegacyEntry(legacyEntry, planMode), { ...options, liveMessage });
}
