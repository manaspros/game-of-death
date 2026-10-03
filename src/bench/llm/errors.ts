/** Every retry was spent on HTTP/network/timeout failures: the provider is down or overloaded. */
export class ProviderUnavailableError extends Error {}

/** The provider's daily/plan quota is used up; retrying cannot help. */
export class QuotaExhaustedError extends Error {}

/** The provider rejected the request itself (bad key, bad model id, bad schema); retrying cannot help. */
export class ProviderRequestError extends Error {}

/** A response arrived but was unusable (no tool call, malformed arguments). A model failure, not an outage. */
export class ModelResponseError extends Error {}

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
