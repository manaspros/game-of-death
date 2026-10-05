import { ModelResponseError, ProviderRequestError, RequestNotSentError, ProviderUnavailableError, QuotaExhaustedError } from './errors';
import { parseRetryAfter } from './pricing';
import { readChatCompletionStream } from './sse';
import type { CallHooks } from './types';

const TIMEOUT_MS = 45_000;
/** Waits between attempts after an HTTP/network failure: ~3 minutes of patience in total. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000];
/** Unusable-but-delivered responses are not an outage, so they get fewer, quicker retries. */
const MAX_RESPONSE_FAILURES = 2;
const RESPONSE_RETRY_DELAY_MS = 1_000;
const HEARTBEAT_MS = 15_000;
/** Requests allowed more than the default timeout get at most this many timed-out attempts (bounds worst-case call time). */
const MAX_TIMEOUTS_LONG_REQUEST = 2;
const DAILY_QUOTA = /per[\s_-]?day|daily|free-models-per-day/i;

export interface HttpResult<R> {
  value: R;
  latencyMs: number;
}

export interface HttpOptions {
  retryDelaysMs?: number[];
  timeoutMs?: number;
  /** Total attempts allowed for unusable-but-delivered responses (default 2: the original plus one retry). */
  maxResponseFailures?: number;
  /** Awaited before EVERY HTTP attempt (first try, retries, truncation escalations): the provider/model rate limiter. Returns ms waited. */
  acquire?: () => Promise<number>;
  /** Pessimistic USD cost of one attempt, evaluated per attempt and reserved through hooks.reserve before sending (0 or unset: no reservation). */
  reservationUsd?: () => number;
  /** The body asks for stream=true: read the SSE reply and reassemble it into a normal response (the proxy sends no cost header then; usage.cost stands in for it). */
  stream?: boolean;
}

/** A non-2xx answer worth retrying (429 / 5xx); carries the server's Retry-After, if any. */
class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
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
  parse: (json: T, meta: { costUsd: number }) => R,
  hooks?: CallHooks,
  options: HttpOptions = {},
): Promise<HttpResult<R>> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxAttempts = delays.length + 1;
  const maxResponseFailures = options.maxResponseFailures ?? MAX_RESPONSE_FAILURES;
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
    let timeouts = 0;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      currentAttempt = attempt;
      attemptsMade = attempt;
      const start = Date.now();
      try {
        // Every HTTP attempt takes its own limiter slot, then re-checks that the match is still running (the wait can be long).
        if (options.acquire) {
          const waited = await options.acquire();
          if (waited >= 1000) hooks?.throttled?.({ waitMs: waited });
        }
        if (hooks?.canSend && !hooks.canSend()) throw new RequestNotSentError(`${label}: request not sent, the match was stopped (cost cap or budget).`);
        return await attemptOnce();
      } catch (err) {
        if (err instanceof RequestNotSentError || err instanceof ProviderRequestError || err instanceof QuotaExhaustedError) throw err;
        lastError = err;

        const isResponseFailure = err instanceof ModelResponseError;
        if (isResponseFailure) responseFailures++;
        const timedOut = err instanceof Error && err.name === 'AbortError';
        if (timedOut) timeouts++;
        const tooManyTimeouts = timedOut && timeoutMs > TIMEOUT_MS && timeouts >= MAX_TIMEOUTS_LONG_REQUEST;
        // A truncated response is deterministic: resending the identical request only buys the same cut-off again.
        const truncated = isResponseFailure && err.truncated === true;
        const giveUp = truncated || (isResponseFailure ? responseFailures >= maxResponseFailures : attempt >= maxAttempts || tooManyTimeouts);
        // A server-sent Retry-After (429/503) replaces the fixed backoff.
        const retryAfterMs = err instanceof HttpStatusError ? err.retryAfterMs : undefined;
        const delay = isResponseFailure ? RESPONSE_RETRY_DELAY_MS : retryAfterMs ?? delays[attempt - 1];

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
      `${label} unavailable after ${attemptsMade} attempts: ${describeError(lastError, timeoutMs)}`,
    );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  async function attemptOnce(): Promise<HttpResult<R>> {
    const start = Date.now();
    // Reserve this attempt's worst-case cost before sending; the reservation is held until the attempt is over and its real cost is booked.
    const reservation = options.reservationUsd?.() ?? 0;
    let release: (() => void) | null = null;
    if (reservation > 0 && hooks?.reserve) {
      release = hooks.reserve(reservation);
      if (!release) throw new RequestNotSentError(`${label}: request not sent, the next call could exceed the cost cap (reserved $${reservation.toFixed(4)}).`);
    }
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
        const retryAfterMs = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers?.get?.('retry-after')) : undefined;
        throw new HttpStatusError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status, retryAfterMs);
      }
      if (!res.ok) {
        const text = await res.text();
        // Azure's prompt filter flags some valid prompts intermittently (same prompt passes on repeat): treat it as a bad response and retry.
        if (res.status === 400 && /invalid_prompt/.test(text)) {
          throw new ModelResponseError(`${label} prompt filter (invalid_prompt)`);
        }
        throw new ProviderRequestError(`${label} error ${res.status}: ${text}`);
      }

      const json = (options.stream && res.body ? await readChatCompletionStream(res.body) : await res.json()) as T;
      const latencyMs = Date.now() - start;
      // LiteLLM reports the real USD cost of every response in this header; absent or invalid means 0 here and the client estimates from usage x prices.
      // A streamed reply has no such header, but its final usage chunk may carry the proxy's cost.
      const rawCost = Number(res.headers?.get?.('x-litellm-response-cost') ?? (json as { usage?: { cost?: number } }).usage?.cost);
      const costUsd = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;
      let value: R;
      try {
        value = parse(json, { costUsd });
      } catch (err) {
        const failure = err instanceof ModelResponseError ? err : new ModelResponseError(err instanceof Error ? err.message : String(err));
        if (failure.usage) hooks?.usage?.({ ...failure.usage, costUsd: failure.usage.costUsd ?? costUsd });
        throw failure;
      }
      return { value, latencyMs };
    } catch (err) {
      // A timeout, 5xx or network failure may still have been billed upstream with no usage to show for it: charge the reservation so budgets stay conservative.
      // 429s (rejected by the rate limiter), 4xx and unusable-but-delivered responses (their usage is already reported) are not charged here.
      const chargeable =
        reservation > 0 &&
        !(err instanceof ModelResponseError || err instanceof ProviderRequestError || err instanceof QuotaExhaustedError) &&
        !(err instanceof HttpStatusError && err.status < 500);
      if (chargeable) hooks?.usage?.({ costUsd: reservation, costSource: 'reserved' });
      throw err;
    } finally {
      clearTimeout(timer);
      release?.();
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
