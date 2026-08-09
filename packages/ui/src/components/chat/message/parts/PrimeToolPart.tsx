import React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { PrimeTranscriptItem } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getToolMetadata } from '@/lib/toolHelpers';
import { cn } from '@/lib/utils';
import { getToolIcon } from './toolPresentation';
import { MinDurationShineText } from './MinDurationShineText';

const TOOL_ROW_TEXT_CLASS = 'leading-5';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

const toolSummary = (input: string | null) => {
  if (!input) return null;
  let candidate = input;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const preferred = ['code', 'command', 'path', 'filePath', 'query', 'url', 'prompt']
      .map((key) => parsed[key])
      .find((value) => typeof value === 'string');
    if (typeof preferred === 'string') candidate = preferred;
  } catch {
    // Plain-text tool inputs are already displayable.
  }
  const normalized = candidate.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
};

interface PrimeToolPartProps {
  item: PrimeTranscriptItem;
}

export function PrimeToolPart({ item }: PrimeToolPartProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const toolName = item.label ?? 'tool';
  const normalizedToolName = toolName.toLowerCase();
  const isAgentMessage = item.role === 'system' && normalizedToolName === 'agent_message';
  const isIpython = normalizedToolName === 'ipython';
  const displayName = isAgentMessage ? getToolMetadata(toolName).displayName : toolName;
  const active = item.streaming || item.toolStatus === 'running';
  let toolInput = item.toolInput;
  if (isIpython && toolInput) {
    try {
      const parsedInput = JSON.parse(toolInput) as unknown;
      if (
        parsedInput
        && typeof parsedInput === 'object'
        && !Array.isArray(parsedInput)
        && 'code' in parsedInput
        && typeof parsedInput.code === 'string'
      ) {
        toolInput = parsedInput.code;
      }
    } catch {
      // Plain-text IPython input is already the source code to display.
    }
  }
  const toolOutput = item.toolOutput ?? (isAgentMessage ? item.text : null);
  const summary = toolSummary(toolInput ?? item.text);
  const hasExpandedContent = Boolean(toolInput || toolOutput);

  return (
    <div>
      <div
        role={hasExpandedContent ? 'button' : undefined}
        tabIndex={hasExpandedContent ? 0 : undefined}
        aria-expanded={hasExpandedContent ? expanded : undefined}
        onClick={hasExpandedContent ? () => setExpanded((current) => !current) : undefined}
        onKeyDown={hasExpandedContent ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setExpanded((current) => !current);
        } : undefined}
        className={cn(
          'group/tool flex items-center gap-1.5 rounded-xl py-1.5 pl-px pr-2',
          hasExpandedContent && 'cursor-pointer',
        )}
      >
        <span className="relative h-5 w-3.5 shrink-0">
          <span
            className={cn(
              'absolute inset-0 flex items-center justify-center transition-opacity',
              expanded && 'opacity-0',
              !expanded && hasExpandedContent && 'group-hover/tool:opacity-0',
            )}
            style={{ color: item.isError ? 'var(--status-error)' : 'var(--tools-icon)' }}
          >
            {getToolIcon(toolName)}
          </span>
          {hasExpandedContent && (
            <Icon
              name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
              className={cn(
                'absolute inset-0 size-3.5 transition-opacity',
                expanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
              )}
            />
          )}
        </span>
        <MinDurationShineText
          active={active && !item.isError}
          className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0')}
          style={{ color: item.isError ? 'var(--status-error)' : 'var(--tools-title)' }}
          title={displayName}
        >
          {displayName}
        </MinDurationShineText>
        {!expanded && summary && (
          <span
            className={cn('min-w-0 flex-1 truncate opacity-80', TOOL_ROW_DESCRIPTION_CLASS)}
            style={{ color: 'var(--tools-description)' }}
            title={summary}
          >
            {summary}
          </span>
        )}
      </div>

      {expanded && hasExpandedContent && (
        <div className="relative ml-2 pb-1 pl-3 pt-0.5">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 top-0 w-px"
            style={{ backgroundColor: item.isError ? 'var(--status-error)' : 'var(--tools-border)' }}
          />
          <ScrollableOverlay
            as="div"
            outerClassName="max-h-80"
            className="space-y-3 pr-2"
            useScrollShadow
            scrollShadowSize={36}
            userIntentOnly
          >
            {isAgentMessage ? (
              <SimpleMarkdownRenderer
                content={item.text}
                variant="tool"
                className="typography-markdown-body"
                enableFileReferences={false}
              />
            ) : (
              <>
                {toolInput && (
                  <div>
                    <div className="mb-1 typography-micro font-medium text-muted-foreground">
                      {t('chat.modelControls.input')}
                    </div>
                    {isIpython ? (
                      <div className="tool-input-surface rounded-xl bg-[var(--surface-muted)] p-2 text-muted-foreground/90">
                        <WorkerHighlightedCode language="python" code={toolInput} wrap />
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-muted)] p-2 font-mono text-xs text-foreground/85">
                        {toolInput}
                      </pre>
                    )}
                  </div>
                )}
                {toolOutput && (
                  <div>
                    <div className="mb-1 typography-micro font-medium text-muted-foreground">
                      {t('chat.toolPart.output')}
                    </div>
                    {isIpython ? (
                      <div className="tool-output-surface rounded-xl bg-[var(--surface-muted)] p-2 text-muted-foreground/90">
                        <WorkerHighlightedCode language="python" code={toolOutput} wrap />
                      </div>
                    ) : (
                      <SimpleMarkdownRenderer
                        content={toolOutput}
                        variant="tool"
                        className="typography-markdown-body"
                        enableFileReferences={false}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </ScrollableOverlay>
        </div>
      )}
    </div>
  );
}
