import type { BenchAction, Observation } from '../types';

export interface LLMCallResult {
  /** One action for a normal call; several when the model used place_many. Applied in order. */
  actions: BenchAction[];
  /** The model's own stated reason for this move, from the tool call's rationale field. */
  rationale?: string;
  /** The model's written step-by-step check (the `analysis` field of the place tool), if it gave one. */
  analysis?: string;
  /** What the model wants to remember next call (the `notes` field). */
  notes?: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Hidden reasoning tokens, when the provider reports them (Gemini thoughtsTokenCount). */
  thoughtTokens?: number;
}

export interface AttemptFailure {
  attempt: number;
  maxAttempts: number;
  reason: string;
  elapsedMs: number;
  willRetry: boolean;
  retryInMs?: number;
}

export interface CallHooks {
  /** Fired each time one HTTP attempt fails (timeout, 429, 5xx, bad response). */
  attemptFailed?(info: AttemptFailure): void;
  /** Fired when the call was held back to respect the provider's request spacing. */
  throttled?(info: { waitMs: number }): void;
  /** Fired periodically while a call is still in flight. */
  waiting?(info: { elapsedMs: number; attempt: number }): void;
}

export interface LLMClient {
  readonly provider: string;
  readonly modelId: string;
  getAction(
    observation: Observation,
    availablePresets: string[],
    previousRejection?: string,
    hooks?: CallHooks,
  ): Promise<LLMCallResult>;
}
