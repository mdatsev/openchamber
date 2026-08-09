import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PrimeModel, PrimeSessionControls, PrimeThinkingLevel } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatEffortLabel } from './mobileControlsUtils';

const primeModelKey = (provider: string, modelID: string) => JSON.stringify([provider, modelID]);

interface PrimeControlSelectorsProps {
  controls: PrimeSessionControls;
  model: PrimeModel | null;
  thinkingLevel: PrimeThinkingLevel;
  disabled: boolean;
  className?: string;
  onModelChange: (model: PrimeModel) => void;
  onThinkingLevelChange: (level: PrimeThinkingLevel) => void;
}

export function PrimeControlSelectors({
  controls,
  model,
  thinkingLevel,
  disabled,
  className,
  onModelChange,
  onThinkingLevelChange,
}: PrimeControlSelectorsProps) {
  const { t } = useI18n();
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {controls.models.length > 0 && (
        <Select
          value={model ? primeModelKey(model.provider, model.id) : undefined}
          disabled={disabled}
          onValueChange={(value) => {
            const selected = controls.models.find((candidate) => primeModelKey(candidate.provider, candidate.id) === value);
            if (selected) onModelChange(selected);
          }}
        >
          <SelectTrigger
            size="chip"
            className="max-w-[min(55vw,18rem)] border-0 bg-transparent px-2 shadow-none"
            aria-label={t('chat.modelControls.selectModel')}
          >
            <Icon name="chat-ai-3" className="size-3.5" />
            <SelectValue placeholder={t('chat.modelControls.selectModel')}>
              {model?.name ?? t('chat.modelControls.selectModel')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="start"
            className="max-h-80 max-w-[min(90vw,28rem)]"
            scrollClassName="max-h-80"
          >
            {controls.models.map((candidate) => (
              <SelectItem key={primeModelKey(candidate.provider, candidate.id)} value={primeModelKey(candidate.provider, candidate.id)}>
                {candidate.name} · {candidate.provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {controls.availableThinkingLevels.length > 0 && (
        <Select<PrimeThinkingLevel>
          value={thinkingLevel}
          disabled={disabled}
          onValueChange={onThinkingLevelChange}
        >
          <SelectTrigger
            size="chip"
            className="border-0 bg-transparent px-2 shadow-none"
            aria-label={t('chat.unifiedControls.effort.title')}
          >
            <Icon name="brain-ai-3" className="size-3.5" />
            <SelectValue>{formatEffortLabel(thinkingLevel)}</SelectValue>
          </SelectTrigger>
          <SelectContent side="top" align="start" fitContent>
            {controls.availableThinkingLevels.map((level) => (
              <SelectItem key={level} value={level}>{formatEffortLabel(level)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
