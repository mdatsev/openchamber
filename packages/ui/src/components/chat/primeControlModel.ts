import type { ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import type { PrimeModel, PrimeThinkingLevel } from '@/lib/api/types';
import type { ModelMetadata } from '@/types';

interface PrimeModelPickerCatalog {
  providers: ModelPickerProvider[];
  metadata: Map<string, ModelMetadata>;
  modelsByKey: Map<string, PrimeModel>;
}

export const primeModelKey = (provider: string, modelID: string) => JSON.stringify([provider, modelID]);

export const buildPrimeModelPickerCatalog = (models: readonly PrimeModel[]): PrimeModelPickerCatalog => {
  const providersByID = new Map<string, ModelPickerProvider>();
  const metadata = new Map<string, ModelMetadata>();
  const modelsByKey = new Map<string, PrimeModel>();

  for (const model of models) {
    const key = primeModelKey(model.provider, model.id);
    if (modelsByKey.has(key)) continue;
    modelsByKey.set(key, model);

    let provider = providersByID.get(model.provider);
    if (!provider) {
      provider = { id: model.provider, name: model.provider, models: [] };
      providersByID.set(model.provider, provider);
    }

    const limit = {
      ...(model.contextWindow !== null ? { context: model.contextWindow } : {}),
      ...(model.maxTokens !== null ? { output: model.maxTokens } : {}),
    };
    provider.models?.push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      ...(Object.keys(limit).length > 0 ? { limit } : {}),
    });
    metadata.set(`${model.provider}/${model.id}`, {
      id: model.id,
      providerId: model.provider,
      name: model.name,
      reasoning: model.reasoning,
      ...(Object.keys(limit).length > 0 ? { limit } : {}),
    });
  }

  return {
    providers: [...providersByID.values()],
    metadata,
    modelsByKey,
  };
};

export const getPrimeThinkingOptions = (
  model: PrimeModel | null,
  availableLevels: readonly PrimeThinkingLevel[],
): PrimeThinkingLevel[] => model?.reasoning === false ? [] : [...new Set(availableLevels)];

export type PrimeControlShortcutScope = 'draft' | 'transcript';

export const PRIME_OPEN_MODEL_SELECTOR_EVENT = 'openchamber:prime-open-model-selector';
export const PRIME_CYCLE_THINKING_EVENT = 'openchamber:prime-cycle-thinking';

export const getNextPrimeThinkingLevel = (
  options: readonly PrimeThinkingLevel[],
  currentLevel: PrimeThinkingLevel,
): PrimeThinkingLevel | null => {
  if (options.length === 0) return null;
  const currentIndex = options.indexOf(currentLevel);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
  return options[nextIndex] ?? null;
};

