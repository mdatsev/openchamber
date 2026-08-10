import type { PrimeAPI } from '@openchamber/ui/lib/api/types';

class PrimeUnsupportedError extends Error {
  readonly status = 501;
  readonly code = 'prime_unsupported';

  constructor() {
    super('prime_unsupported');
    this.name = 'PrimeUnsupportedError';
  }
}

const unsupported = async (): Promise<never> => {
  throw new PrimeUnsupportedError();
};

export const createVSCodePrimeAPI = (): PrimeAPI => ({
  create: unsupported,
  getStatus: unsupported,
  getCatalog: unsupported,
  getTranscript: unsupported,
  getContext: unsupported,
  activate: unsupported,
  deactivate: unsupported,
  getSnapshot: unsupported,
  openEvents: unsupported,
  prompt: unsupported,
  abort: unsupported,
  setModel: unsupported,
  setThinkingLevel: unsupported,
});
