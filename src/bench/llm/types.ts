import type { BenchAction, Observation } from '../types';
import type { CostSource } from './pricing';

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
  /** Real USD cost of this call as reported by the provider (LiteLLM x-litellm-response-cost); 0 when unreported. */
  costUsd?: number;
  /** Where costUsd came from: the proxy header, tokens x configured prices ('estimated'), or a pessimistic reservation ('reserved'). */
  costSource?: CostSource;
  /** Required prose fields (analysis / rationale / notes) the model left out or empty; the call was still accepted. */
  missingFields?: string[];
  /** The provider's finish_reason for this call (openai-compatible clients). */
  finishReason?: string;
  /** The raw tool-call arguments as sent by the model, truncated to RAW_ARGS_LOG_CHARS (openai-compatible clients). */
  rawArgs?: string;
}

/** Longest raw tool-call arguments string kept in the logs. */
export const RAW_ARGS_LOG_CHARS = 2000;

export interface AttemptFailure {
  attempt: number;
  maxAttempts: number;
  reason: string;
  elapsedMs: number;
  willRetry: boolean;
  retryInMs?: number;
}

export interface CallHooks {
  /** Asked before EVERY provider request (first attempt, retries, escalations); false means do not send (match stopped or cost cap reached). */
  canSend?(): boolean;
  /** Fired each time one HTTP attempt fails (timeout, 429, 5xx, bad response). */
  attemptFailed?(info: AttemptFailure): void;
  /** Fired when the call was held back to respect the provider's request spacing. */
  throttled?(info: { waitMs: number }): void;
  /** Fired with the billed usage of a delivered-but-unusable response (so it can be counted). */
  usage?(info: { promptTokens?: number; completionTokens?: number; costUsd?: number; costSource?: CostSource }): void;
  /** Asked before every provider request with its pessimistic worst-case USD cost; returns a release function once reserved, or null to refuse (budget). */
  reserve?(usd: number): (() => void) | null;
  /** Fired when a truncated (finish_reason=length) call is retried once with a larger max_tokens. */
  escalated?(info: { fromMaxTokens: number; toMaxTokens: number }): void;
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

/** Admission control for spend: each request reserves its worst case until it finishes, so concurrent calls cannot jointly overshoot a cap. */
export interface CostGate {
  reserve(usd: number): (() => void) | null;
}
