import type { Observation } from '../types';
import { postJsonWithRetry } from './http';
import {
  buildUserMessage,
  extractAnalysis,
  extractNotes,
  extractRationale,
  checkRequiredFields,
  activeSystemPrompt,
  TOOL_DEFS,
  toolCallToActions,
  type ToolDef,
} from './tools';
import type { MinIntervalLimiter } from './rateLimiter';
import type { CallHooks, LLMCallResult, LLMClient } from './types';

interface GeminiPart {
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Gemini's function-declaration schema subset rejects numeric `enum`; drop it recursively. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

function toFunctionDeclaration(tool: ToolDef): Record<string, unknown> {
  const decl: Record<string, unknown> = { name: tool.name, description: tool.description };
  // Gemini rejects OBJECT parameters with no properties, so omit them for no-arg tools.
  if (Object.keys(tool.parameters.properties).length > 0) {
    decl.parameters = sanitizeSchema(tool.parameters);
  }
  return decl;
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export function buildGeminiBody(
  observation: Observation,
  availablePresets: string[],
  previousRejection?: string,
  thinking?: ThinkingLevel,
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: activeSystemPrompt() }] },
    contents: [{ role: 'user', parts: [{ text: buildUserMessage(observation, availablePresets, previousRejection) }] }],
    tools: [{ functionDeclarations: TOOL_DEFS.map(toFunctionDeclaration) }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0.3, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
  };
}

export class AiStudioClient implements LLMClient {
  readonly provider = 'aistudio';
  readonly modelId: string;
  private apiKey: string;
  private limiter?: MinIntervalLimiter;
  private thinking?: ThinkingLevel;

  constructor(modelId: string, apiKey: string, limiter?: MinIntervalLimiter, thinking?: ThinkingLevel) {
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.limiter = limiter;
    this.thinking = thinking;
  }

  async getAction(
    observation: Observation,
    availablePresets: string[],
    previousRejection?: string,
    hooks?: CallHooks,
  ): Promise<LLMCallResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:generateContent`;

    const { value, latencyMs } = await postJsonWithRetry<GeminiResponse, Omit<LLMCallResult, 'latencyMs'>>(
      this.provider,
      url,
      { 'x-goog-api-key': this.apiKey },
      buildGeminiBody(observation, availablePresets, previousRejection, this.thinking),
      json => {
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        const call = parts.find(p => p.functionCall)?.functionCall;
        if (!call) throw new Error('Model response contained no function call.');
        // Same rule as the OpenAI-compatible clients: unusable shapes fail, empty prose (analysis/rationale/notes) is accepted and reported.
        const { fatal, lenient } = checkRequiredFields(call.name, call.args ?? {});
        if (fatal.length > 0) throw new Error(`Tool call is missing required fields: ${fatal.join(', ')}.`);
        return {
          actions: toolCallToActions(call.name, call.args ?? {}),
          rationale: extractRationale(call.args ?? {}),
          analysis: extractAnalysis(call.args ?? {}),
          notes: extractNotes(call.args ?? {}),
          thoughtTokens: json.usageMetadata?.thoughtsTokenCount,
          promptTokens: json.usageMetadata?.promptTokenCount,
          completionTokens: json.usageMetadata?.candidatesTokenCount,
          ...(lenient.length > 0 ? { missingFields: lenient } : {}),
        };
      },
      hooks,
      this.limiter ? { acquire: () => this.limiter!.acquire() } : {},
    );

    return { ...value, latencyMs };
  }
}
