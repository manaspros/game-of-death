import type { PresetName } from '../engine/types';
import { GameState } from '../game/state';
import { runBaselineBotBuildPhase } from './baselineBot';
import { BlueprintBook } from './blueprints';
import { MatchMemory } from './memory';
import { buildPostMortem } from './postmortem';
import { isFatalProviderError } from './llm/errors';
import type { CostGate, LLMClient } from './llm/types';
import { runLLMBuildPhase } from './loop';
import { emitSnapshot, type MatchLogger } from './logger';

export interface MatchResult {
  winner: 1 | 2 | 'draw' | null;
  rounds: number;
  p1HeartHp: number;
  p2HeartHp: number;
  /** Set when the match was aborted because a provider failed; the result must not be scored. */
  invalid?: { playerId: 1 | 2; reason: string };
  /** Set when MatchOptions.signal aborted the match (e.g. token budget); the result must not be scored. */
  aborted?: boolean;
  /** Set (together with `aborted`) when the match was stopped because its USD cost reached the per-match cap; the result must not be scored. */
  costCap?: boolean;
  /** Real USD cost of all LLM calls in this match (sum of the logged costUsd). */
  costUsd?: number;
}

export interface MatchOptions {
  /** Pause between simulated generations so a live viewer can follow along. */
  simDelayMs?: number;
  /** Override the arena's default number of rounds. */
  maxRounds?: number;
  /** Real rest between rounds: gives providers breathing room and viewers a "next round" screen. */
  roundPauseMs?: number;
  /** External abort (e.g. a token meter). The match stops as soon as in-flight calls return and reports `aborted`. */
  signal?: AbortSignal;
  /** Stop the match once its cumulative LLM cost reaches this many USD. Default: env BENCH_MATCH_MAX_USD, else 1.0. */
  maxUsd?: number;
  /** Outer spend admission (the tournament's total budget): consulted, together with the match cap, before every provider request. A refusal aborts the match without costCap. */
  gate?: CostGate;
}

export const DEFAULT_MATCH_MAX_USD = 1.0;

/** Per-match USD cap: explicit option, else BENCH_MATCH_MAX_USD, else the default. Non-positive/invalid values fall back to the default. */
export function resolveMaxUsd(explicit?: number): number {
  for (const v of [explicit, process.env.BENCH_MATCH_MAX_USD ? Number(process.env.BENCH_MATCH_MAX_USD) : undefined]) {
    if (v !== undefined && Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_MATCH_MAX_USD;
}

/** An LLM client, or 'baseline' for the scripted non-LLM bot. */
export type PlayerController = LLMClient | 'baseline';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function describe(c: PlayerController): { provider: string; modelId: string } | null {
  return c === 'baseline' ? null : { provider: c.provider, modelId: c.modelId };
}

async function runBuildPhase(
  state: GameState,
  playerId: 1 | 2,
  controller: PlayerController,
  logger: MatchLogger,
  signal: AbortSignal,
  book: BlueprintBook,
  memory: MatchMemory,
  gate: CostGate,
): Promise<void> {
  if (controller === 'baseline') {
    runBaselineBotBuildPhase(state, playerId, (action, applyResult, movesLeftBefore) =>
      logger.log({ type: 'bot_turn', playerId, round: state.round, movesLeftBefore, action, applyResult }),
    );
    emitSnapshot(logger, state);
  } else {
    await runLLMBuildPhase(state, playerId, controller, logger, signal, book, memory, gate);
  }
}

/**
 * Runs one full match between two controllers (LLM or scripted baseline).
 * Both build phases run concurrently: zones are disjoint, and under
 * semi-hidden visibility neither side can see the other's in-progress build,
 * so neither seat gets an information or timing advantage.
 *
 * If a provider is down or out of quota, the match is aborted and returned
 * with `invalid` set rather than forfeiting that player's turn.
 */
export async function runMatch(
  presetName: PresetName,
  p1: PlayerController,
  p2: PlayerController,
  rawLogger: MatchLogger,
  options: MatchOptions = {},
): Promise<MatchResult> {
  // Own abort so the cost cap and an external signal (token budget) stop the match the same way.
  const stop = new AbortController();
  const external = options.signal;
  if (external?.aborted) stop.abort();
  else external?.addEventListener('abort', () => stop.abort(), { once: true });
  const signal = stop.signal;

  const maxUsd = resolveMaxUsd(options.maxUsd);
  let matchCostUsd = 0;
  let costCapped = false;
  // Meters real LLM spend from the logged rows (turn / llm_usage carry costUsd) and stops the match at the cap.
  const logger: MatchLogger = {
    log(entry) {
      const cost = typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
      if (cost > 0 && (entry.type === 'turn' || entry.type === 'llm_usage')) {
        matchCostUsd += cost;
        rawLogger.log({ ...entry, matchCostUsd });
        if (matchCostUsd >= maxUsd && !costCapped) {
          costCapped = true;
          rawLogger.log({ type: 'match_cost_cap', totalCostUsd: matchCostUsd, maxUsd, reason: 'cost cap' });
          stop.abort();
        }
        return;
      }
      rawLogger.log(entry);
    },
    ...(rawLogger.snapshot ? { snapshot: (snap: Parameters<NonNullable<MatchLogger['snapshot']>>[0]) => rawLogger.snapshot!(snap) } : {}),
  };

  // Every provider request first reserves its worst-case cost: refused when spent + in-flight reservations + this one would pass the match cap
  // (or the outer gate's cap), so concurrent seats and retries cannot jointly overshoot.
  let reservedUsd = 0;
  const gate: CostGate = {
    reserve(usd) {
      if (signal.aborted) return null;
      if (matchCostUsd + reservedUsd + usd > maxUsd) {
        if (!costCapped) {
          costCapped = true;
          rawLogger.log({ type: 'match_cost_cap', totalCostUsd: matchCostUsd, maxUsd, reservationUsd: usd, reason: 'cost cap' });
          stop.abort();
        }
        return null;
      }
      const outer = options.gate ? options.gate.reserve(usd) : undefined;
      if (outer === null) {
        stop.abort();
        return null;
      }
      reservedUsd += usd;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reservedUsd -= usd;
        outer?.();
      };
    },
  };

  const state = new GameState(presetName);
  if (options.maxRounds !== undefined) state.maxRounds = options.maxRounds;
  logger.log({
    type: 'match_start',
    preset: presetName,
    maxRounds: state.maxRounds,
    p1: describe(p1),
    p2: describe(p2),
  });
  emitSnapshot(logger, state);

  // Each player's saved formations live for this match only.
  const books: Record<1 | 2, BlueprintBook> = { 1: new BlueprintBook(), 2: new BlueprintBook() };
  // What each model wrote to its future self, plus what happened each round (the API itself remembers nothing).
  const memory = new MatchMemory();

  const abortedResult = (): MatchResult => ({
    winner: null,
    rounds: state.round,
    p1HeartHp: state.players[0].heartHp,
    p2HeartHp: state.players[1].heartHp,
    aborted: true,
    ...(costCapped ? { costCap: true } : {}),
    costUsd: matchCostUsd,
  });

  while (true) {
    if (signal.aborted) return abortedResult();
    logger.log({
      type: 'round_start',
      round: state.round,
      maxRounds: state.maxRounds,
      p1HeartHp: state.players[0].heartHp,
      p2HeartHp: state.players[1].heartHp,
    });

    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    if (signal.aborted) abort.abort();
    signal.addEventListener('abort', onExternalAbort);
    let invalid: MatchResult['invalid'];
    const guard = (playerId: 1 | 2, controller: PlayerController) =>
      runBuildPhase(state, playerId, controller, logger, abort.signal, books[playerId], memory, gate).catch(err => {
        if (!isFatalProviderError(err)) throw err;
        invalid ??= { playerId, reason: err.message };
        abort.abort();
      });

    try {
      await Promise.all([guard(1, p1), guard(2, p2)]);
    } finally {
      signal.removeEventListener('abort', onExternalAbort);
    }

    if (signal.aborted && !invalid) return abortedResult();
    if (invalid) {
      logger.log({ type: 'match_invalid', round: state.round, playerId: invalid.playerId, reason: invalid.reason });
      return {
        winner: null,
        rounds: state.round,
        p1HeartHp: state.players[0].heartHp,
        p2HeartHp: state.players[1].heartHp,
        invalid,
        costUsd: matchCostUsd,
      };
    }
    emitSnapshot(logger, state);

    const sim = state.startSimulation();
    if (!sim) throw new Error('Failed to start simulation: both players should have committed by now.');
    logger.log({ type: 'simulation_start', round: state.round });

    while (state.simulation && state.simulation.generation < state.preset.generationsPerRound) {
      state.advanceSimulation();
      emitSnapshot(logger, state);
      if (options.simDelayMs) await sleep(options.simDelayMs);
    }

    const result = state.resolve();
    if (state.previousRoundGrid) {
      const report = buildPostMortem({
        preGrid: state.previousRoundGrid,
        generations: state.preset.generationsPerRound,
        cellMaxAge: state.preset.cellMaxAge,
        heartZones: { 1: state.players[0].heartZone, 2: state.players[1].heartZone },
        placements: memory.placementsThisRound(),
      });
      memory.setReport(1, report[1]);
      memory.setReport(2, report[2]);
      logger.log({ type: 'post_mortem', round: state.round, p1: report[1], p2: report[2] });
    }
    memory.closeRound(state.round, result);
    emitSnapshot(logger, state);
    logger.log({
      type: 'round_resolved',
      round: state.round,
      p1Cells: result.p1Cells,
      p2Cells: result.p2Cells,
      p1HeartHp: result.p1HeartHp,
      p2HeartHp: result.p2HeartHp,
      winner: result.winner,
      isGameOver: result.isGameOver,
    });

    if (result.isGameOver) {
      logger.log({ type: 'match_end', ...result, margin: result.p1HeartHp - result.p2HeartHp });
      return {
        winner: result.winner,
        rounds: state.round,
        p1HeartHp: result.p1HeartHp,
        p2HeartHp: result.p2HeartHp,
        costUsd: matchCostUsd,
      };
    }

    const pauseMs = options.roundPauseMs ?? 0;
    logger.log({
      type: 'round_break',
      round: state.round,
      nextRound: state.round + 1,
      pauseMs,
      p1Cells: result.p1Cells,
      p2Cells: result.p2Cells,
      p1HeartHp: result.p1HeartHp,
      p2HeartHp: result.p2HeartHp,
    });
    if (pauseMs > 0) await sleep(pauseMs);

    state.nextRound();
    emitSnapshot(logger, state);
  }
}
