import { OpenAICompatibleClient } from './openaiCompatible';
import type { MinIntervalLimiter } from './rateLimiter';

export class GroqClient extends OpenAICompatibleClient {
  constructor(modelId: string, apiKey: string, limiter?: MinIntervalLimiter) {
    super({
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      modelId,
      apiKey,
      limiter,
    });
  }
}
