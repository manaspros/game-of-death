import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { PresetName } from '../engine/types';
import { requireEnv } from './config';
import { createClient, getModelEntry } from './llm/registry';
import type { CostGate } from './llm/types';
import { isPromptVariant, PROMPT_VARIANTS, setPromptVariant, type PromptVariant } from './llm/tools';
import { createFileLogger, type MatchLogger } from './logger';
import { exportVideo, videoExportProblem } from './video/export';
import { runMatch, type MatchResult, type PlayerController } from './match';
import { parseJsonl, type LogEvent } from './replay';

export const TOURNAMENT_DIR = 'bench-logs/tournaments';
export const TOURNAMENT_VIDEO_DIR = 'videos/tournaments';
/** USD any single tournament match may spend before it is voided ('cost cap'). Env TOURNEY_MATCH_MAX_USD. */
export const DEFAULT_TOURNEY_MATCH_MAX_USD = 3.0;
/** Rest between matches (env TOURNEY_MATCH_PAUSE_SEC), to stay clear of provider rate limits. */
export const DEFAULT_MATCH_PAUSE_SEC = 5;

export interface Fixture {
  /** Position in the deterministic schedule (0-based). */
  index: number;
  a: string;
  b: string;
  /** Who sits in seat 1 / seat 2 this match. */
  p1: string;
  p2: string;
}

export type Seat = { p1: number; p2: number };

/** Why a seat's calls went wrong in one match, by cause. */
export interface FailureCounts {
  /** Actions the game rejected (bad anchor, outside the zone, Heart placed twice, ...). */
  illegalAction: number;
  /** Unusable responses cut off by max_tokens (runaway reasoning), after the client's own retry. */
  truncated: number;
  /** Unusable responses with no tool call at all, after the client's own retry. */
  noToolCall: number;
  /** Other unusable responses (bad JSON, missing required fields), after the client's own retry. */
  malformedCall: number;
  /** Accepted calls that left analysis / rationale / notes empty. */
  missingProse: number;
  /** Single HTTP attempts that failed (timeout, 429, 5xx, unusable response) and were retried or given up on. */
  failedAttempts: number;
  /** Moves left unspent when the turn was force-submitted. */
  unspentMoves: number;
}

export const FAILURE_KINDS = ['illegalAction', 'truncated', 'noToolCall', 'malformedCall', 'missingProse', 'failedAttempts', 'unspentMoves'] as const satisfies readonly (keyof FailureCounts)[];

/** Token use of one seat split by kind. completion includes hidden reasoning for providers that bill it as output; thought is only set where reported apart (Gemini). */
export interface TokenDetail {
  prompt: number;
  completion: number;
  thought: number;
}

/** One line of results.jsonl. Consumed by the leaderboard and web page: keep the shape stable. */
export interface TournamentRow {
  index: number;
  tournamentId: string;
  preset: string;
  a: string;
  b: string;
  p1: string;
  p2: string;
  winner: 'p1' | 'p2' | 'draw' | null;
  winnerModel: string | null;
  rounds: number;
  p1HeartHp: number;
  p2HeartHp: number;
  margin: number;
  void: boolean;
  voidReason?: string;
  tokens: Seat;
  /** Real LLM spend per seat in USD (LiteLLM-reported); 0 when the provider reports no cost. Absent in rows written before cost tracking. */
  costUsd?: { p1: number; p2: number };
  invalidCalls: Seat;
  autoSkips: Seat;
  /** Per-seat failure causes. Absent in rows written before failure tracking. */
  failures?: { p1: FailureCounts; p2: FailureCounts };
  /** Per-seat token split. Absent in rows written before token tracking. */
  tokenDetail?: { p1: TokenDetail; p2: TokenDetail };
  /** System prompt variant the match was played under. Absent = 'default'. */
  promptVariant?: PromptVariant;
  logFile: string;
  finishedAt: string;
}

/** Games per pair are forced even (and at least 2) so each side gets each seat equally. */
export function evenGames(n: number): number {
  const g = Number.isFinite(n) ? Math.floor(n) : 2;
  return Math.max(2, g % 2 === 0 ? g : g + 1);
}

/** Round-robin over all unordered pairs; within a pair, seats alternate so each model plays half its games as P1. */
export function buildSchedule(models: string[], gamesPerPair: number): Fixture[] {
  const games = evenGames(gamesPerPair);
  const out: Fixture[] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      for (let g = 0; g < games; g++) {
        const aFirst = g % 2 === 0;
        out.push({
          index: out.length,
          a: models[i],
          b: models[j],
          p1: aFirst ? models[i] : models[j],
          p2: aFirst ? models[j] : models[i],
        });
      }
    }
  }
  return out;
}

/** Model keys can hold '/', ':' and the like; keep file names portable. */
export function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || '_';
}

interface LogStats {
  tokens: Seat;
  costUsd: { p1: number; p2: number };
  invalidCalls: Seat;
  autoSkips: Seat;
  failures: { p1: FailureCounts; p2: FailureCounts };
  tokenDetail: { p1: TokenDetail; p2: TokenDetail };
}

const noFailures = (): FailureCounts => ({ illegalAction: 0, truncated: 0, noToolCall: 0, malformedCall: 0, missingProse: 0, failedAttempts: 0, unspentMoves: 0 });
const noTokens = (): TokenDetail => ({ prompt: 0, completion: 0, thought: 0 });

/** Sorts an unusable-response log row into its cause (the messages come from the clients' response parsers). */
function badResponseKind(e: LogEvent): 'truncated' | 'noToolCall' | 'malformedCall' {
  const msg = typeof e.error === 'string' ? e.error : '';
  if (e.finishReason === 'length' || /truncated/i.test(msg)) return 'truncated';
  if (/no tool call|no function call/i.test(msg)) return 'noToolCall';
  return 'malformedCall';
}

/**
 * Counts from a match's JSONL rows (same row types summary.ts reads):
 *  - tokens: promptTokens + completionTokens + thoughtTokens on `turn` rows (call-level, stored on the first action),
 *    plus the same fields on `llm_usage` rows (billed calls that produced no turn row: unusable responses, empty or discarded calls),
 *  - invalidCalls: `turn` rows whose applyResult.ok is false, plus `llm_bad_response` rows,
 *  - autoSkips: `auto_skip` rows,
 *  - failures: the same invalid calls split by cause, plus `missing_fields_warning`, `attempt_failed` and `force_submit` (unspent moves) rows,
 *  - tokenDetail: the token sum split into prompt / completion / thought.
 */
export function statsFromLog(events: LogEvent[]): LogStats {
  const s: LogStats = {
    tokens: { p1: 0, p2: 0 },
    costUsd: { p1: 0, p2: 0 },
    invalidCalls: { p1: 0, p2: 0 },
    autoSkips: { p1: 0, p2: 0 },
    failures: { p1: noFailures(), p2: noFailures() },
    tokenDetail: { p1: noTokens(), p2: noTokens() },
  };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const e of events) {
    const seat = e.playerId === 1 ? 'p1' : e.playerId === 2 ? 'p2' : null;
    if (!seat) continue;
    if (e.type === 'llm_usage' || e.type === 'turn') {
      s.tokens[seat] += n(e.promptTokens) + n(e.completionTokens) + n(e.thoughtTokens);
      s.tokenDetail[seat].prompt += n(e.promptTokens);
      s.tokenDetail[seat].completion += n(e.completionTokens);
      s.tokenDetail[seat].thought += n(e.thoughtTokens);
      s.costUsd[seat] += n(e.costUsd);
    }
    if (e.type === 'turn') {
      if ((e.applyResult as { ok?: boolean } | undefined)?.ok === false) {
        s.invalidCalls[seat]++;
        s.failures[seat].illegalAction++;
      }
    } else if (e.type === 'llm_bad_response') {
      s.invalidCalls[seat]++;
      s.failures[seat][badResponseKind(e)]++;
    } else if (e.type === 'auto_skip') s.autoSkips[seat]++;
    else if (e.type === 'missing_fields_warning') s.failures[seat].missingProse++;
    else if (e.type === 'attempt_failed') s.failures[seat].failedAttempts++;
    else if (e.type === 'force_submit') s.failures[seat].unspentMoves += n(e.movesLeft);
  }
  return s;
}

/** Worker k of n (0-based): plays only the schedule indices with index % n === k. */
export interface Shard {
  k: number;
  n: number;
}

/** Parses TOURNEY_SHARD="k/n" (0-based k, 0 <= k < n). */
export function parseShard(text: string): Shard {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  const k = m ? Number(m[1]) : NaN;
  const n = m ? Number(m[2]) : NaN;
  if (!m || n < 1 || k >= n) throw new Error(`TOURNEY_SHARD must look like "k/n" with 0 <= k < n (0-based), got "${text}".`);
  return { k, n };
}

export interface TournamentOptions {
  /** Parallel worker slice. Several workers may run the same tournament id and dir concurrently; see TOURNEY_SHARD in the README notes. */
  shard?: Shard;
  models: string[];
  gamesPerPair: number;
  preset: PresetName;
  id: string;
  /** Turns a model key into a player. Injected so tests can use fake clients; created once per key. */
  createController: (key: string) => PlayerController;
  /** Root folder holding one sub-folder per tournament. Default bench-logs/tournaments. */
  baseDir?: string;
  maxRounds?: number;
  /** Stop before starting a match once total tokens (incl. resumed rows) reach this; a running match is voided ('budget') when it gets there. */
  tokenBudget?: number;
  /** Total USD cap across the tournament (incl. resumed rows), enforced like tokenBudget. */
  maxUsd?: number;
  /** USD cap for any single match (default DEFAULT_TOURNEY_MATCH_MAX_USD); a match reaching it is voided with reason 'cost cap' and the tournament continues. */
  matchMaxUsd?: number;
  /** Rest between two played matches, in ms (default 0 here; the CLI defaults to TOURNEY_MATCH_PAUSE_SEC=5). */
  matchPauseMs?: number;
  /** Renders a finished (non-void) match's log to a video. Called in the background after each match; a failure is logged and recorded in videos.jsonl, never fatal. */
  exportVideo?: (job: { logPath: string; outPath: string }) => Promise<void>;
  /** Root folder for match videos: <videoDir>/<tournament id>/<match file base>.mp4 (default videos/tournaments). */
  videoDir?: string;
  /** Re-run matches whose latest row is void (default: they stay done). The new row supersedes the old one. */
  retryVoid?: boolean;
  roundPauseMs?: number;
  /** Stop after this many newly played matches (used to exercise resume). */
  maxMatches?: number;
  /** System prompt variant every model plays under (default 'default'). Saved in meta.json: one tournament id = one variant. */
  promptVariant?: PromptVariant;
  /** Suppress progress output. */
  quiet?: boolean;
}

export interface TournamentOutcome {
  /** Rows written by this run (not the resumed ones). */
  rows: TournamentRow[];
  /** Fixtures skipped because results.jsonl already had them. */
  skipped: number;
  stoppedForBudget: boolean;
  totalTokens: number;
  totalUsd: number;
}

/**
 * Parses results.jsonl text. An unparseable LAST line (a write cut short by a kill) is skipped with a warning;
 * an unparseable line anywhere else is a real error and throws.
 */
export function parseResultRows(
  text: string,
  warn: (msg: string) => void = m => console.warn(m),
): { rows: TournamentRow[]; skippedLast: boolean } {
  const lines = text.split('\n').filter(l => l.trim());
  const rows: TournamentRow[] = [];
  let skippedLast = false;
  lines.forEach((l, i) => {
    try {
      rows.push(JSON.parse(l) as TournamentRow);
    } catch (err) {
      if (i !== lines.length - 1) throw new Error(`results.jsonl line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      skippedLast = true;
      warn(`results.jsonl: ignoring unparseable last line (${l.length} chars), probably cut off mid-write.`);
    }
  });
  return { rows, skippedLast };
}

/** One row per match index: when an index appears more than once, the last row wins. */
export function latestPerIndex(rows: TournamentRow[]): TournamentRow[] {
  const byIndex = new Map<number, TournamentRow>();
  for (const r of rows) byIndex.set(r.index, r);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function readRows(file: string, warn: (msg: string) => void, repair = true): TournamentRow[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const { rows, skippedLast } = parseResultRows(text, warn);
  // Drop the broken tail (or add the missing newline) so the next append starts on a fresh line.
  // Never with parallel workers: the "broken" tail may be another worker's append in flight, and rewriting the file would lose it.
  if (repair && (skippedLast || (text && !text.endsWith('\n')))) writeFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');
  return rows;
}

/** Result-affecting settings saved in meta.json so a resume cannot silently mix incomparable games under one leaderboard. */
export interface TournamentMeta {
  version: 1;
  models: string[];
  gamesPerPair: number;
  preset: string;
  /** null = the preset's own round count. */
  maxRounds: number | null;
  /** Absent in meta.json files written before prompt variants = 'default'. */
  promptVariant?: PromptVariant;
}

/** Throws a clear error when the saved settings differ from the current ones. */
export function assertMetaMatches(saved: unknown, current: TournamentMeta, id: string): void {
  const s = (saved ?? {}) as Partial<TournamentMeta>;
  const show = (v: unknown) => (v === null || v === undefined ? 'preset default' : Array.isArray(v) ? v.join(',') : String(v));
  const diffs: string[] = [];
  if (s.preset !== current.preset) diffs.push(`preset ${show(s.preset)} -> ${show(current.preset)}`);
  if (s.maxRounds !== current.maxRounds) diffs.push(`maxRounds ${show(s.maxRounds)} -> ${show(current.maxRounds)}`);
  if (s.gamesPerPair !== current.gamesPerPair) diffs.push(`games per pair ${show(s.gamesPerPair)} -> ${show(current.gamesPerPair)}`);
  if (JSON.stringify(s.models) !== JSON.stringify(current.models)) diffs.push(`models ${show(s.models)} -> ${show(current.models)}`);
  if ((s.promptVariant ?? 'default') !== (current.promptVariant ?? 'default')) diffs.push(`prompt variant ${s.promptVariant ?? 'default'} -> ${current.promptVariant ?? 'default'}`);
  if (diffs.length > 0) {
    throw new Error(`Cannot resume tournament "${id}": its settings changed since it started (${diffs.join('; ')}). Use the original settings or a new TOURNEY_ID.`);
  }
}

const sumTokens = (r: TournamentRow) => r.tokens.p1 + r.tokens.p2;
const sumUsd = (r: TournamentRow) => (r.costUsd?.p1 ?? 0) + (r.costUsd?.p2 ?? 0);

export async function runTournament(opts: TournamentOptions): Promise<TournamentOutcome> {
  const dir = join(opts.baseDir ?? TOURNAMENT_DIR, opts.id);
  const resultsFile = join(dir, 'results.jsonl');
  mkdirSync(dir, { recursive: true });
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  const dupes = opts.models.filter((m, i) => opts.models.indexOf(m) !== i);
  if (dupes.length) throw new Error(`Duplicate model keys: ${[...new Set(dupes)].join(', ')}. Each model may appear only once.`);

  const schedule = buildSchedule(opts.models, opts.gamesPerPair);
  const shard = opts.shard;
  if (shard && (!Number.isInteger(shard.k) || !Number.isInteger(shard.n) || shard.n < 1 || shard.k < 0 || shard.k >= shard.n)) throw new Error(`Invalid shard ${shard.k}/${shard.n}.`);
  const prior = readRows(resultsFile, msg => log(`Warning: ${msg}`), !shard);
  for (const r of prior) {
    const fx = schedule[r.index];
    if (!fx || fx.a !== r.a || fx.b !== r.b || fx.p1 !== r.p1 || fx.p2 !== r.p2 || r.preset !== opts.preset) {
      throw new Error(
        `Cannot resume tournament "${opts.id}": row #${r.index} in results.jsonl (${r.a} vs ${r.b}, P1=${r.p1}, preset ${r.preset}) ` +
          `does not match the schedule for the current models/games/preset` +
          (fx ? ` (expected ${fx.a} vs ${fx.b}, P1=${fx.p1}, preset ${opts.preset}).` : ` (the schedule has only ${schedule.length} matches).`) +
          ` Use the original settings or a new TOURNEY_ID.`,
      );
    }
  }
  const promptVariant = opts.promptVariant ?? 'default';
  const meta: TournamentMeta = { version: 1, models: opts.models, gamesPerPair: evenGames(opts.gamesPerPair), preset: opts.preset, maxRounds: opts.maxRounds ?? null, promptVariant };
  const metaFile = join(dir, 'meta.json');
  // Written exactly once (flag 'wx'): of several workers starting together one creates it, the others validate against it.
  let created = false;
  if (!existsSync(metaFile)) {
    if (prior.length > 0) log(`Warning: tournament "${opts.id}" has results but no meta.json (started before settings were saved); maxRounds of the earlier rows cannot be verified. Saving the current settings.`);
    try {
      writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  if (!created) {
    let saved: unknown;
    // Another worker may be mid-write of the file it just created: retry briefly before calling it corrupt.
    for (let attempt = 0; ; attempt++) {
      try {
        saved = JSON.parse(readFileSync(metaFile, 'utf8'));
        break;
      } catch {
        if (!shard || attempt >= 20) throw new Error(`Cannot resume tournament "${opts.id}": ${metaFile} is not valid JSON. Fix or delete it, or use a new TOURNEY_ID.`);
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
    }
    assertMetaMatches(saved, meta, opts.id);
  }
  // Void rows stay done (and out of the ratings) unless asked to retry; the last row per index is the current one.
  const done = new Set(latestPerIndex(prior).filter(r => !(r.void && opts.retryVoid)).map(r => r.index));
  const mine = (index: number) => !shard || index % shard.n === shard.k;
  let totalTokens = prior.reduce((sum, r) => sum + sumTokens(r), 0);
  let totalUsd = prior.reduce((sum, r) => sum + sumUsd(r), 0);

  const controllers = new Map<string, PlayerController>();
  for (const key of opts.models) controllers.set(key, opts.createController(key));

  const outcome: TournamentOutcome = { rows: [], skipped: 0, stoppedForBudget: false, totalTokens, totalUsd };
  setPromptVariant(promptVariant);
  log(`Tournament ${opts.id}: ${opts.models.length} models, ${schedule.length} matches, preset "${opts.preset}", prompt variant "${promptVariant}"` +
    (shard ? `, shard ${shard.k}/${shard.n} (${schedule.filter(f => mine(f.index)).length} of them mine)` : '') +
    (done.size ? `, resuming with ${done.size} done` : ''));

  const matchMaxUsd = opts.matchMaxUsd !== undefined && Number.isFinite(opts.matchMaxUsd) && opts.matchMaxUsd > 0 ? opts.matchMaxUsd : DEFAULT_TOURNEY_MATCH_MAX_USD;
  const pauseMs = opts.matchPauseMs ?? 0;
  log(`Spend limits: $${matchMaxUsd.toFixed(2)} per match (a match reaching it is VOIDED as "cost cap"), ${opts.maxUsd !== undefined ? `$${opts.maxUsd} for the whole tournament` : 'no tournament USD cap'}.`);
  // Videos render one at a time in the background while later matches play; awaited before returning.
  let exportQueue: Promise<void> = Promise.resolve();
  const videoRoot = join(opts.videoDir ?? TOURNAMENT_VIDEO_DIR, opts.id);
  const videoSidecar = join(dir, 'videos.jsonl');
  const queueExport = (index: number, logPath: string) => {
    const outPath = join(videoRoot, basename(logPath, '.jsonl') + '.mp4');
    const rel = (p: string) => relative(process.cwd(), p).split('\\').join('/');
    exportQueue = exportQueue.then(async () => {
      try {
        await opts.exportVideo!({ logPath, outPath });
        appendFileSync(videoSidecar, JSON.stringify({ index, logFile: rel(logPath), video: rel(outPath) }) + '\n', 'utf8');
        log(`  video: ${rel(outPath)}`);
      } catch (err) {
        const videoError = err instanceof Error ? err.message : String(err);
        appendFileSync(videoSidecar, JSON.stringify({ index, logFile: rel(logPath), videoError }) + '\n', 'utf8');
        log(`Warning: video export failed for match #${index} (the tournament continues): ${videoError}`);
      }
    });
  };

  for (const fx of schedule) {
    if (!mine(fx.index)) continue;
    if (done.has(fx.index)) {
      outcome.skipped++;
      continue;
    }
    if (opts.maxMatches !== undefined && outcome.rows.length >= opts.maxMatches) break;
    if (shard) {
      // Budgets are tournament-wide: take every worker's finished spend from the shared results.jsonl before each match.
      // Matches other workers still have in flight are not visible yet, so the total may overshoot by up to (workers - 1) matches.
      const shared = readRows(resultsFile, () => {}, false);
      totalTokens = shared.reduce((sum, r) => sum + sumTokens(r), 0);
      totalUsd = shared.reduce((sum, r) => sum + sumUsd(r), 0);
      outcome.totalTokens = totalTokens;
      outcome.totalUsd = totalUsd;
    }
    if (opts.tokenBudget !== undefined && totalTokens >= opts.tokenBudget) {
      outcome.stoppedForBudget = true;
      log(`Token budget reached (${totalTokens} >= ${opts.tokenBudget}); stopping before match #${fx.index}. Re-run with the same TOURNEY_ID to resume.`);
      break;
    }

    if (opts.maxUsd !== undefined && totalUsd >= opts.maxUsd) {
      outcome.stoppedForBudget = true;
      log(`USD budget reached ($${totalUsd.toFixed(4)} >= $${opts.maxUsd}); stopping before match #${fx.index}. Re-run with the same TOURNEY_ID to resume.`);
      break;
    }

    if (outcome.rows.length > 0 && pauseMs > 0) {
      log(`Pausing ${(pauseMs / 1000).toFixed(0)}s before match #${fx.index} (TOURNEY_MATCH_PAUSE_SEC).`);
      await new Promise<void>(resolve => setTimeout(resolve, pauseMs));
    }

    const logPath = join(dir, `match-${fx.index}-${sanitizeKey(fx.a)}-vs-${sanitizeKey(fx.b)}.jsonl`);
    // A crashed earlier attempt may have left a partial log; start clean so counts stay right.
    rmSync(logPath, { force: true });

    let result: MatchResult | null = null;
    let voidReason: string | undefined;
    // Running meter: every logged call (even failed ones) counts, and the match aborts once the budget is used up.
    const fileLogger = createFileLogger(logPath);
    const abort = new AbortController();
    let matchTokens = 0;
    let matchUsd = 0;
    // Tournament-wide admission: a request is refused (and the match voided as 'budget') if its worst case could pass the tournament USD cap.
    let reservedUsd = 0;
    const gate: CostGate = {
      reserve(usd) {
        if (opts.maxUsd !== undefined && totalUsd + matchUsd + reservedUsd + usd > opts.maxUsd) return null;
        reservedUsd += usd;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            reservedUsd -= usd;
          }
        };
      },
    };
    const meter: MatchLogger = {
      log(entry) {
        fileLogger.log(entry);
        if (entry.type === 'turn' || entry.type === 'llm_usage') {
          const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
          matchTokens += n(entry.promptTokens) + n(entry.completionTokens) + n(entry.thoughtTokens);
          matchUsd += n(entry.costUsd);
          if (opts.tokenBudget !== undefined && totalTokens + matchTokens >= opts.tokenBudget) abort.abort();
          if (opts.maxUsd !== undefined && totalUsd + matchUsd >= opts.maxUsd) abort.abort();
        }
      },
    };
    try {
      result = await runMatch(opts.preset, controllers.get(fx.p1)!, controllers.get(fx.p2)!, meter, {
        maxRounds: opts.maxRounds,
        roundPauseMs: opts.roundPauseMs ?? 0,
        signal: abort.signal,
        maxUsd: matchMaxUsd,
        gate,
      });
      if (result.costCap) voidReason = 'cost cap';
      else if (result.aborted) voidReason = 'budget';
      else if (result.invalid) voidReason = `P${result.invalid.playerId} (${result.invalid.playerId === 1 ? fx.p1 : fx.p2}): ${result.invalid.reason}`;
    } catch (err) {
      voidReason = `match errored: ${err instanceof Error ? err.message : String(err)}`;
    }

    const stats = existsSync(logPath)
      ? statsFromLog(parseJsonl(readFileSync(logPath, 'utf8')))
      : statsFromLog([]);
    const isVoid = voidReason !== undefined || result === null;
    const winner: TournamentRow['winner'] = isVoid
      ? null
      : result!.winner === 1 ? 'p1' : result!.winner === 2 ? 'p2' : 'draw';
    const p1Hp = result?.p1HeartHp ?? 0;
    const p2Hp = result?.p2HeartHp ?? 0;

    const row: TournamentRow = {
      index: fx.index,
      tournamentId: opts.id,
      preset: opts.preset,
      a: fx.a,
      b: fx.b,
      p1: fx.p1,
      p2: fx.p2,
      winner,
      winnerModel: winner === 'p1' ? fx.p1 : winner === 'p2' ? fx.p2 : null,
      rounds: result?.rounds ?? 0,
      p1HeartHp: p1Hp,
      p2HeartHp: p2Hp,
      margin: p1Hp - p2Hp,
      void: isVoid,
      ...(isVoid ? { voidReason: voidReason ?? 'no result' } : {}),
      tokens: stats.tokens,
      costUsd: stats.costUsd,
      invalidCalls: stats.invalidCalls,
      autoSkips: stats.autoSkips,
      failures: stats.failures,
      tokenDetail: stats.tokenDetail,
      promptVariant,
      logFile: relative(process.cwd(), logPath).split('\\').join('/'),
      finishedAt: new Date().toISOString(),
    };
    appendFileSync(resultsFile, JSON.stringify(row) + '\n', 'utf8');
    outcome.rows.push(row);
    totalTokens += sumTokens(row);
    totalUsd += sumUsd(row);
    outcome.totalTokens = totalTokens;
    outcome.totalUsd = totalUsd;

    if (voidReason === 'budget') {
      outcome.stoppedForBudget = true;
      log(`Budget reached mid-match (tokens ${totalTokens}/${opts.tokenBudget ?? '-'}, USD $${totalUsd.toFixed(4)}/${opts.maxUsd ?? '-'}); match #${fx.index} voided. Re-run with the same TOURNEY_ID (and TOURNEY_RETRY_VOID=1 to replay it) to resume.`);
      break;
    }
    if (voidReason === 'cost cap') {
      log(`COST CAP: match #${fx.index} (${fx.a} vs ${fx.b}) was stopped at $${sumUsd(row).toFixed(4)} of its $${matchMaxUsd.toFixed(2)} per-match cap and is VOID (not rated). Raise TOURNEY_MATCH_MAX_USD or replay it with TOURNEY_RETRY_VOID=1.`);
    }
    if (!isVoid && opts.exportVideo) queueExport(fx.index, logPath);
    const verdict = isVoid ? `VOID (${voidReason})` : `winner=${row.winnerModel ?? 'draw'} margin=${row.margin}`;
    log(`#${fx.index}/${schedule.length - 1} ${fx.a} vs ${fx.b} (P1=${fx.p1}) ${verdict} rounds=${row.rounds} tokens=${sumTokens(row)} cumulative=${totalTokens} cost=$${sumUsd(row).toFixed(4)} cumulativeCost=$${totalUsd.toFixed(4)}`);
  }

  if (opts.exportVideo) {
    log('Waiting for video exports to finish...');
    await exportQueue;
  }
  outcome.totalTokens = totalTokens;
  outcome.totalUsd = totalUsd;
  return outcome;
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}".`);
  return n;
}

async function main(): Promise<void> {
  const models = requireEnv('TOURNEY_MODELS').split(',').map(s => s.trim()).filter(Boolean);
  if (models.length < 2) throw new Error('TOURNEY_MODELS needs at least two model keys (baseline is allowed).');
  const requested = envInt('TOURNEY_GAMES') ?? 2;
  const gamesPerPair = evenGames(requested);
  if (gamesPerPair !== requested) console.log(`TOURNEY_GAMES=${requested} forced to ${gamesPerPair} (must be even).`);
  const id = process.env.TOURNEY_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const promptVariant = process.env.TOURNEY_PROMPT_VARIANT || 'default';
  if (!isPromptVariant(promptVariant)) throw new Error(`TOURNEY_PROMPT_VARIANT must be one of ${PROMPT_VARIANTS.join(', ')}, got "${promptVariant}".`);

  const pauseSec = envInt('BENCH_ROUND_PAUSE_SEC');
  const matchMaxUsd = envInt('TOURNEY_MATCH_MAX_USD');
  if (matchMaxUsd !== undefined && matchMaxUsd <= 0) throw new Error('TOURNEY_MATCH_MAX_USD must be positive.');
  const matchPauseSec = envInt('TOURNEY_MATCH_PAUSE_SEC') ?? DEFAULT_MATCH_PAUSE_SEC;
  if (matchPauseSec < 0) throw new Error('TOURNEY_MATCH_PAUSE_SEC must be 0 or more.');

  // Every finished match is rendered to videos/tournaments/<id>/ unless TOURNEY_EXPORT_VIDEO=0. Check the tools up front: failing now costs nothing, failing after $40 of matches would.
  const autoExport = process.env.TOURNEY_EXPORT_VIDEO !== '0';
  if (autoExport) {
    const problem = videoExportProblem();
    if (problem) throw new Error(`Video export is on (TOURNEY_EXPORT_VIDEO) but not available: ${problem} Fix that, or set TOURNEY_EXPORT_VIDEO=0 to run without videos.`);
  }
  let builtReplayPage = false;
  const outcome = await runTournament({
    models,
    gamesPerPair,
    preset: (process.env.BENCH_PRESET || 'skirmish') as PresetName,
    id,
    maxRounds: envInt('TOURNEY_MAX_ROUNDS'),
    tokenBudget: envInt('TOURNEY_TOKEN_BUDGET'),
    maxUsd: envInt('TOURNEY_MAX_USD'),
    ...(process.env.TOURNEY_SHARD ? { shard: parseShard(process.env.TOURNEY_SHARD) } : {}),
    matchMaxUsd,
    matchPauseMs: matchPauseSec * 1000,
    ...(autoExport
      ? {
          exportVideo: async ({ logPath, outPath }: { logPath: string; outPath: string }) => {
            // Rebuild the replay page once per run (it may be stale), then reuse it for every match.
            const build = !builtReplayPage;
            builtReplayPage = true;
            await exportVideo({ logPath, outPath, fps: 30, build });
          },
        }
      : {}),
    retryVoid: process.env.TOURNEY_RETRY_VOID === '1',
    promptVariant,
    roundPauseMs: pauseSec !== undefined ? pauseSec * 1000 : 0,
    createController: key => (key === 'baseline' ? 'baseline' : createClient(getModelEntry(key))),
  });

  const voids = outcome.rows.filter(r => r.void).length;
  console.log(`\nDone: ${outcome.rows.length} matches played (${voids} void), ${outcome.skipped} resumed/skipped, ${outcome.totalTokens} tokens total, $${outcome.totalUsd.toFixed(4)} spent.` +
    (outcome.stoppedForBudget ? ' Stopped on token budget.' : ''));
  console.log(`Results: ${TOURNAMENT_DIR}/${id}/results.jsonl`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Tournament failed:', err);
    process.exitCode = 1;
  });
}
