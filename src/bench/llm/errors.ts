import type { CostSource } from './pricing';
/** Every retry was spent on HTTP/network/timeout failures: the provider is down or overloaded. */
export class ProviderUnavailableError extends Error {}

/** The provider's daily/plan quota is used up; retrying cannot help. */
export class QuotaExhaustedError extends Error {}

/** The provider rejected the request itself (bad key, bad model id, bad schema); retrying cannot help. */
export class ProviderRequestError extends Error {}

/** The match stopped (cost cap / budget abort) before this request was sent; nothing was billed for it. */
export class RequestNotSentError extends Error {}

/** A response arrived but was unusable (no tool call, malformed arguments). A model failure, not an outage. */
export class ModelResponseError extends Error {
  /** Billed usage of the unusable response, when the provider reported it. */
  usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number; costSource?: CostSource };
  /** finish_reason=length: the same request would be cut off again, so it must never be resent unchanged. */
  truncated?: boolean;
  /** The provider's finish_reason and the raw tool-call arguments (truncated), when known, for the logs. */
  finishReason?: string;
  rawArgs?: string;
}

/** Errors that make a benchmark result meaningless: abort the match instead of forfeiting a turn. */
export function isFatalProviderError(
  err: unknown,
): err is ProviderUnavailableError | QuotaExhaustedError | ProviderRequestError {
  return (
    err instanceof ProviderUnavailableError ||
    err instanceof QuotaExhaustedError ||
    err instanceof ProviderRequestError
  );
}
