import type { Observation } from '../types';
import { ModelResponseError } from './errors';
import { postJsonWithRetry } from './http';
import { reservationUsd, resolveCost, type Prices } from './pricing';
import { buildUserMessage, checkRequiredFields, extractAnalysis, extractNotes, extractRationale, SYSTEM_PROMPT, TOOL_DEFS, toolCallToActions } from './tools';
import type { MinIntervalLimiter } from './rateLimiter';
import { RAW_ARGS_LOG_CHARS, type CallHooks, type LLMCallResult, type LLMClient } from './types';

interface ChatToolCall {
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices?: { message?: { tool_calls?: ChatToolCall[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAICompatibleConfig {
  provider: string;
  endpoint: string;
  modelId: string;
  apiKey: string;
  limiter?: MinIntervalLimiter;
  /** Sent in addition to the Authorization bearer header (e.g. LiteLLM's x-litellm-api-key). */
  extraHeaders?: Record<string, string>;
  /** Cap on generated tokens; omitted from the request when unset. */
  maxTokens?: number;
  /** Highest max_tokens a truncated call may be retried with (default 2x maxTokens). */
  maxTokensCeiling?: number;
  /** Per-request timeout in ms; the http default (45s) applies when unset. */
  timeoutMs?: number;
  /** Extra fields merged into the request body (e.g. reasoning_effort, thinking). */
  extraBody?: Record<string, unknown>;
  /** USD per million tokens. With both set, a missing cost header is estimated from usage and every request reserves its worst case. */
  inputPricePerM?: number;
  outputPricePerM?: number;
  /** Request stream=true (SSE) and reassemble the reply: keeps the connection active so a long reasoning call is not cut by a proxy/CDN idle limit. */
  stream?: boolean;
}

/** Client for any OpenAI-compatible chat-completions endpoint with native tool calling. */
export class OpenAICompatibleClient implements LLMClient {
  readonly provider: string;
  readonly modelId: string;
  private endpoint: string;
  private apiKey: string;
  private limiter?: MinIntervalLimiter;
  private extraHeaders: Record<string, string>;
  private maxTokens?: number;
  private maxTokensCeiling?: number;
  private timeoutMs?: number;
  private extraBody?: Record<string, unknown>;
  private prices: Prices;
  private stream: boolean;
  /** Prompt tokens of the latest delivered response (shared by every seat using this client): the reservation's prompt-size estimate. */
  private lastPromptTokens?: number;

  constructor(config: OpenAICompatibleConfig) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.limiter = config.limiter;
    this.extraHeaders = config.extraHeaders ?? {};
    this.maxTokens = config.maxTokens;
    this.maxTokensCeiling = config.maxTokensCeiling;
    this.timeoutMs = config.timeoutMs;
    this.extraBody = config.extraBody;
    this.stream = config.stream === true;
    this.prices = { inputPricePerM: config.inputPricePerM, outputPricePerM: config.outputPricePerM };
  }

  async getAction(
    observation: Observation,
    availablePresets: string[],
    previousRejection?: string,
    hooks?: CallHooks,
  ): Promise<LLMCallResult> {
    const buildBody = (maxTokens: number | undefined) => ({
      model: this.modelId,
      temperature: 0.3,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      tools: TOOL_DEFS.map(t => ({ type: 'function', function: t })),
      tool_choice: 'required',
      ...this.extraBody,
      ...(this.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(observation, availablePresets, previousRejection) },
      ],
    });

    const post = (maxTokens: number | undefined, maxResponseFailures?: number) => postJsonWithRetry<ChatResponse, Omit<LLMCallResult, 'latencyMs'>>(
      this.provider,
      this.endpoint,
      { Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      buildBody(maxTokens),
      (json, meta) => {
        const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
        const call = json.choices?.[0]?.message?.tool_calls?.[0];
        const rawArgs = call?.function.arguments?.slice(0, RAW_ARGS_LOG_CHARS);
        const truncated = finishReason === 'length';
        const usage = { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens };
        if (usage.promptTokens !== undefined) this.lastPromptTokens = usage.promptTokens;
        // Header cost when valid, else tokens x prices, else (priced but no usage) the reservation: a delivered response is never booked as free by accident.
        const cost = resolveCost(meta.costUsd, this.prices, usage, reservationUsd(this.prices, this.lastPromptTokens, maxTokens));
        try {
          // A response cut off by max_tokens may still parse (the server can repair the JSON) but its planning fields are gone.
          // Checked before "no tool call": a call cut off before any tool call is the same deterministic failure.
          if (truncated) throw new Error('Model response was truncated (finish_reason=length); raise maxTokens or shorten the answer.');
          if (!call) throw new Error('Model response contained no tool call.');
          const args: Record<string, unknown> = JSON.parse(call.function.arguments || '{}');
          // Unusable shapes (no placements, bad anchors) throw below; only empty prose (analysis/rationale/notes) is tolerated and reported.
          const { fatal, lenient } = checkRequiredFields(call.function.name, args);
          if (fatal.length > 0) throw new Error(`Tool call is missing required fields: ${fatal.join(', ')}.`);
          return {
            actions: toolCallToActions(call.function.name, args),
            rationale: extractRationale(args),
            analysis: extractAnalysis(args),
            notes: extractNotes(args),
            promptTokens: json.usage?.prompt_tokens,
            completionTokens: json.usage?.completion_tokens,
            costUsd: cost.costUsd,
            costSource: cost.costSource,
            ...(lenient.length > 0 ? { missingFields: lenient } : {}),
            finishReason,
            rawArgs,
          };
        } catch (err) {
          // The response was billed even though it is unusable: keep its usage so it can be counted.
          const e = new ModelResponseError(err instanceof Error ? err.message : String(err));
          e.usage = { ...usage, costUsd: cost.costUsd, costSource: cost.costSource };
          e.finishReason = finishReason;
          e.rawArgs = rawArgs;
          e.truncated = truncated;
          throw e;
        }
      },
      hooks,
      {
        ...(this.stream ? { stream: true } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
        ...(maxResponseFailures !== undefined ? { maxResponseFailures } : {}),
        // Every HTTP attempt (retries and the truncation escalation included) takes a limiter slot and reserves its own worst case.
        ...(this.limiter ? { acquire: () => this.limiter!.acquire() } : {}),
        reservationUsd: () => reservationUsd(this.prices, this.lastPromptTokens, maxTokens),
      },
    );

    let result;
    try {
      result = await post(this.maxTokens);
    } catch (err) {
      // Truncated: resending the identical request is pointless. Retry at most once with a larger max_tokens, up to the ceiling.
      const next = err instanceof ModelResponseError && err.truncated && this.maxTokens !== undefined
        ? Math.min(this.maxTokens * 2, this.maxTokensCeiling ?? this.maxTokens * 2)
        : undefined;
      if (next === undefined || this.maxTokens === undefined || next <= this.maxTokens) throw err;
      hooks?.escalated?.({ fromMaxTokens: this.maxTokens, toMaxTokens: next });
      // The escalated call is the one retry for this turn-call: a bad response here is final (no further resend).
      result = await post(next, 1);
    }

    return { ...result.value, latencyMs: result.latencyMs };
  }
}
