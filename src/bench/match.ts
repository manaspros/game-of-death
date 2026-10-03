import type { PresetName } from '../engine/types';
import { GameState } from '../game/state';
import { runBaselineBotBuildPhase } from './baselineBot';
import { BlueprintBook } from './blueprints';
import { MatchMemory } from './memory';
import { buildPostMortem } from './postmortem';
import { isFatalProviderError } from './llm/errors';
import type { LLMClient } from './llm/types';
import { runLLMBuildPhase } from './loop';
import { emitSnapshot, type MatchLogger } from './logger';

export interface MatchResult {
  winner: 1 | 2 | 'draw' | null;
  rounds: number;
  p1HeartHp: number;
  p2HeartHp: number;
  /** Set when the match was aborted because a provider failed; the result must not be scored. */
  invalid?: { playerId: 1 | 2; reason: string };
}

export interface MatchOptions {
  /** Pause between simulated generations so a live viewer can follow along. */
  simDelayMs?: number;
  /** Override the arena's default number of rounds. */
  maxRounds?: number;
  /** Real rest between rounds: gives providers breathing room and viewers a "next round" screen. */
  roundPauseMs?: number;
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
): Promise<void> {
  if (controller === 'baseline') {
    runBaselineBotBuildPhase(state, playerId, (action, applyResult, movesLeftBefore) =>
      logger.log({ type: 'bot_turn', playerId, round: state.round, movesLeftBefore, action, applyResult }),
    );
    emitSnapshot(logger, state);
  } else {
    await runLLMBuildPhase(state, playerId, controller, logger, signal, book, memory);
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
  logger: MatchLogger,
  options: MatchOptions = {},
): Promise<MatchResult> {
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

  while (true) {
    logger.log({
      type: 'round_start',
      round: state.round,
      maxRounds: state.maxRounds,
      p1HeartHp: state.players[0].heartHp,
      p2HeartHp: state.players[1].heartHp,
    });

    const abort = new AbortController();
    let invalid: MatchResult['invalid'];
    const guard = (playerId: 1 | 2, controller: PlayerController) =>
      runBuildPhase(state, playerId, controller, logger, abort.signal, books[playerId], memory).catch(err => {
        if (!isFatalProviderError(err)) throw err;
        invalid ??= { playerId, reason: err.message };
        abort.abort();
      });

    await Promise.all([guard(1, p1), guard(2, p2)]);

    if (invalid) {
      logger.log({ type: 'match_invalid', round: state.round, playerId: invalid.playerId, reason: invalid.reason });
      return {
        winner: null,
        rounds: state.round,
        p1HeartHp: state.players[0].heartHp,
        p2HeartHp: state.players[1].heartHp,
        invalid,
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
      logger.log({ type: 'match_end', ...result });
      return {
        winner: result.winner,
        rounds: state.round,
        p1HeartHp: result.p1HeartHp,
        p2HeartHp: result.p2HeartHp,
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
