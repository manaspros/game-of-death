import { OpenAICompatibleClient } from './openaiCompatible';
import type { MinIntervalLimiter } from './rateLimiter';

export class OpenRouterClient extends OpenAICompatibleClient {
  constructor(modelId: string, apiKey: string, limiter?: MinIntervalLimiter) {
    super({
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      modelId,
      apiKey,
      limiter,
    });
  }
}
