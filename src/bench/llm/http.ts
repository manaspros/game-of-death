import { ModelResponseError, ProviderRequestError, ProviderUnavailableError, QuotaExhaustedError } from './errors';
import type { CallHooks } from './types';

const TIMEOUT_MS = 45_000;
/** Waits between attempts after an HTTP/network failure: ~3 minutes of patience in total. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000];
/** Unusable-but-delivered responses are not an outage, so they get fewer, quicker retries. */
const MAX_RESPONSE_FAILURES = 3;
const RESPONSE_RETRY_DELAY_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const DAILY_QUOTA = /per[\s_-]?day|daily|free-models-per-day/i;

export interface HttpResult<R> {
  value: R;
  latencyMs: number;
}

export interface HttpOptions {
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

/**
 * POST JSON with a timeout and patient retry on 429 (rate), 5xx, network
 * errors and timeouts. Throws:
 *  - QuotaExhaustedError on a daily-quota 429 (retrying cannot help),
 *  - ProviderUnavailableError once every retry has been spent,
 *  - ModelResponseError if the provider answered but `parse` rejected it
 *    several times in a row (a model failure, not an outage).
 * 4xx responses (bad request, bad key) fail immediately.
 * Every failed attempt is reported via `hooks.attemptFailed`, and
 * `hooks.waiting` fires periodically while the call is in flight.
 */
export async function postJsonWithRetry<T, R>(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  parse: (json: T) => R,
  hooks?: CallHooks,
  options: HttpOptions = {},
): Promise<HttpResult<R>> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxAttempts = delays.length + 1;
  const callStart = Date.now();
  let currentAttempt = 1;
  const heartbeat = hooks?.waiting
    ? setInterval(
        () => hooks.waiting?.({ elapsedMs: Date.now() - callStart, attempt: currentAttempt }),
        HEARTBEAT_MS,
      )
    : null;

  try {
    let lastError: unknown;
    let responseFailures = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      currentAttempt = attempt;
      const start = Date.now();
      try {
        return await attemptOnce();
      } catch (err) {
        if (err instanceof ProviderRequestError || err instanceof QuotaExhaustedError) throw err;
        lastError = err;

        const isResponseFailure = err instanceof ModelResponseError;
        if (isResponseFailure) responseFailures++;
        const giveUp = isResponseFailure ? responseFailures >= MAX_RESPONSE_FAILURES : attempt >= maxAttempts;
        const delay = isResponseFailure ? RESPONSE_RETRY_DELAY_MS : delays[attempt - 1];

        hooks?.attemptFailed?.({
          attempt,
          maxAttempts,
          reason: describeError(err, timeoutMs),
          elapsedMs: Date.now() - start,
          willRetry: !giveUp,
          retryInMs: giveUp ? undefined : delay,
        });
        if (giveUp) break;
        await sleep(delay);
      }
    }

    if (lastError instanceof ModelResponseError) throw lastError;
    throw new ProviderUnavailableError(
      `${label} unavailable after ${maxAttempts} attempts: ${describeError(lastError, timeoutMs)}`,
    );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  async function attemptOnce(): Promise<HttpResult<R>> {
    const start = Date.now();
    // The timer must cover reading the body too, not just the headers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text();
        if (res.status === 429 && DAILY_QUOTA.test(text)) {
          throw new QuotaExhaustedError(`${label} daily quota exhausted: ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
        }
        const detail = text.slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!res.ok) {
        throw new ProviderRequestError(`${label} error ${res.status}: ${await res.text()}`);
      }

      const json = (await res.json()) as T;
      const latencyMs = Date.now() - start;
      let value: R;
      try {
        value = parse(json);
      } catch (err) {
        throw new ModelResponseError(err instanceof Error ? err.message : String(err));
      }
      return { value, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') return `timeout after ${timeoutMs / 1000}s`;
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
