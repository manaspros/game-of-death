import { requireEnv } from '../config';
import models from '../models.config.json';
import { AiStudioClient, type ThinkingLevel } from './aistudio';
import { GroqClient } from './groq';
import { OpenRouterClient } from './openrouter';
import { MinIntervalLimiter } from './rateLimiter';
import type { LLMClient } from './types';

export type Provider = 'openrouter' | 'groq' | 'aistudio';

export interface ModelEntry {
  key: string;
  provider: Provider;
  modelId: string;
  nativeToolCalling: boolean;
  contextWindow?: number;
  /** Minimum gap between calls to this model's provider, in ms. Defaults per provider below. */
  minIntervalMs?: number;
  /** Hidden-reasoning level. AI Studio only for now: Gemini 3.x models take minimal | low | medium | high. */
  thinking?: ThinkingLevel;
  notes?: string;
}

export const MODEL_REGISTRY: readonly ModelEntry[] = models as ModelEntry[];

export const API_KEY_ENV: Record<Provider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  aistudio: 'GOOGLE_AI_STUDIO_API_KEY',
};

/**
 * Courtesy spacing between calls, a little under each free tier's requests-per-minute
 * cap (OpenRouter 20 RPM, Groq 30 RPM, AI Studio ~15 RPM). Override per model with
 * `minIntervalMs`, or for everything with BENCH_MIN_CALL_INTERVAL_MS.
 */
const DEFAULT_MIN_INTERVAL_MS: Record<Provider, number> = {
  openrouter: 3200,
  groq: 2200,
  aistudio: 4200,
};

const limiters = new Map<string, MinIntervalLimiter>();

function limiterFor(entry: ModelEntry): MinIntervalLimiter {
  const override = Number(process.env.BENCH_MIN_CALL_INTERVAL_MS);
  const intervalMs = Number.isFinite(override) && override >= 0 && process.env.BENCH_MIN_CALL_INTERVAL_MS
    ? override
    : entry.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS[entry.provider];
  const key = `${entry.provider}:${intervalMs}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new MinIntervalLimiter(intervalMs);
    limiters.set(key, limiter);
  }
  return limiter;
}

export function getModelEntry(key: string, registry: readonly ModelEntry[] = MODEL_REGISTRY): ModelEntry {
  const entry = registry.find(m => m.key === key);
  if (!entry) {
    const known = registry.map(m => m.key).join(', ');
    throw new Error(`Unknown model key "${key}". Known keys: ${known}`);
  }
  return entry;
}

export function createClient(entry: ModelEntry): LLMClient {
  if (!entry.nativeToolCalling) {
    throw new Error(
      `Model "${entry.key}" has nativeToolCalling=false; the JSON-in-text fallback is not implemented yet.`,
    );
  }

  if (entry.thinking && entry.provider !== 'aistudio') {
    throw new Error(`Model "${entry.key}" sets thinking, which is only supported for the aistudio provider so far.`);
  }

  const apiKey = requireEnv(API_KEY_ENV[entry.provider]);
  const limiter = limiterFor(entry);
  switch (entry.provider) {
    case 'openrouter':
      return new OpenRouterClient(entry.modelId, apiKey, limiter);
    case 'groq':
      return new GroqClient(entry.modelId, apiKey, limiter);
    case 'aistudio':
      return new AiStudioClient(entry.modelId, apiKey, limiter, entry.thinking);
  }
}
