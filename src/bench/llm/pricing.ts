/** Per-model prices in USD per million tokens (LiteLLM /v1/model/info). Both unset = unpriced. */
export interface Prices {
  inputPricePerM?: number;
  outputPricePerM?: number;
}

/** Where a call's cost figure came from: the proxy's own header, tokens x prices, a pessimistic reservation, or nothing known. */
export type CostSource = 'header' | 'estimated' | 'reserved' | 'none';

/** Prompt size assumed for the reservation before any call has reported its real prompt tokens. */
export const DEFAULT_PROMPT_TOKENS_ESTIMATE = 10_000;
/** Output size assumed for the reservation when the request sets no max_tokens. */
export const DEFAULT_MAX_TOKENS_ESTIMATE = 8_000;
/** Longest wait a Retry-After header may impose. */
export const MAX_RETRY_AFTER_MS = 120_000;

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function isPriced(p: Prices): boolean {
  return isPrice(p.inputPricePerM) && isPrice(p.outputPricePerM);
}

/** Cost of a call from its token usage, or undefined when the model is unpriced or the response reported no usage. */
export function estimateCostUsd(p: Prices, promptTokens?: number, completionTokens?: number): number | undefined {
  if (!isPriced(p) || (promptTokens === undefined && completionTokens === undefined)) return undefined;
  return ((promptTokens ?? 0) * p.inputPricePerM! + (completionTokens ?? 0) * p.outputPricePerM!) / 1e6;
}

/** Worst-case cost of one request: last known prompt size (or the default) at the input price plus the full max_tokens at the output price. 0 when unpriced. */
export function reservationUsd(p: Prices, lastPromptTokens: number | undefined, maxTokens: number | undefined): number {
  if (!isPriced(p)) return 0;
  const prompt = lastPromptTokens !== undefined && lastPromptTokens > 0 ? lastPromptTokens : DEFAULT_PROMPT_TOKENS_ESTIMATE;
  return (prompt * p.inputPricePerM! + (maxTokens ?? DEFAULT_MAX_TOKENS_ESTIMATE) * p.outputPricePerM!) / 1e6;
}

/**
 * The cost to book for a delivered response. A valid proxy header wins; otherwise tokens x prices ('estimated');
 * otherwise (priced model, but no usage reported either) the reservation ('reserved'); unpriced and unreported is 0 ('none').
 */
export function resolveCost(
  headerCostUsd: number,
  prices: Prices,
  usage: { promptTokens?: number; completionTokens?: number },
  reservation: number,
): { costUsd: number; costSource: CostSource } {
  if (headerCostUsd > 0) return { costUsd: headerCostUsd, costSource: 'header' };
  const estimated = estimateCostUsd(prices, usage.promptTokens, usage.completionTokens);
  if (estimated !== undefined) return { costUsd: estimated, costSource: 'estimated' };
  if (reservation > 0) return { costUsd: reservation, costSource: 'reserved' };
  return { costUsd: 0, costSource: 'none' };
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date, capped at MAX_RETRY_AFTER_MS. Undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}
