import type { Observation } from '../types';
import { postJsonWithRetry } from './http';
import { buildUserMessage, extractAnalysis, extractNotes, extractRationale, SYSTEM_PROMPT, TOOL_DEFS, toolCallToActions } from './tools';
import type { MinIntervalLimiter } from './rateLimiter';
import type { CallHooks, LLMCallResult, LLMClient } from './types';

interface ChatToolCall {
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices?: { message?: { tool_calls?: ChatToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAICompatibleConfig {
  provider: string;
  endpoint: string;
  modelId: string;
  apiKey: string;
  limiter?: MinIntervalLimiter;
}

/** Client for any OpenAI-compatible chat-completions endpoint with native tool calling. */
export class OpenAICompatibleClient implements LLMClient {
  readonly provider: string;
  readonly modelId: string;
  private endpoint: string;
  private apiKey: string;
  private limiter?: MinIntervalLimiter;

  constructor(config: OpenAICompatibleConfig) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.limiter = config.limiter;
  }

  async getAction(
    observation: Observation,
    availablePresets: string[],
    previousRejection?: string,
    hooks?: CallHooks,
  ): Promise<LLMCallResult> {
    const body = {
      model: this.modelId,
      temperature: 0.3,
      tools: TOOL_DEFS.map(t => ({ type: 'function', function: t })),
      tool_choice: 'required',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(observation, availablePresets, previousRejection) },
      ],
    };

    const waited = (await this.limiter?.acquire()) ?? 0;
    if (waited >= 1000) hooks?.throttled?.({ waitMs: waited });

    const { value, latencyMs } = await postJsonWithRetry<ChatResponse, Omit<LLMCallResult, 'latencyMs'>>(
      this.provider,
      this.endpoint,
      { Authorization: `Bearer ${this.apiKey}` },
      body,
      json => {
        const call = json.choices?.[0]?.message?.tool_calls?.[0];
        if (!call) throw new Error('Model response contained no tool call.');
        const args: Record<string, unknown> = JSON.parse(call.function.arguments || '{}');
        return {
          actions: toolCallToActions(call.function.name, args),
          rationale: extractRationale(args),
          analysis: extractAnalysis(args),
          notes: extractNotes(args),
          promptTokens: json.usage?.prompt_tokens,
          completionTokens: json.usage?.completion_tokens,
        };
      },
      hooks,
    );

    return { ...value, latencyMs };
  }
}
