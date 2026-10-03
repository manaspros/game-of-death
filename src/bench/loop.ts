import { PATTERNS } from '../game/patterns';
import type { GameState } from '../game/state';
import { applyBenchAction } from './action';
import type { BlueprintBook } from './blueprints';
import type { MatchMemory } from './memory';
import { isFatalProviderError, ModelResponseError } from './llm/errors';
import type { LLMClient } from './llm/types';
import { emitSnapshot, type MatchLogger } from './logger';
import { serializeObservation } from './observation';
import { describeAction } from './replay';
import type { ActionResult } from './types';

/** Consecutive calls in which nothing worked, allowed for one turn slot before auto-skipping it. */
const ILLEGAL_RETRY_CAP = 3;

/**
 * Interactive agentic loop for one player's build phase.
 * See docs/AI_INTEGRATION.md §6.
 *
 * One call can carry several actions (place_many); they are applied in order
 * and each is logged on its own so replays and summaries stay exact.
 *
 * Provider outages and exhausted quotas are NOT turned into forfeits: they
 * throw, so the match is aborted as invalid instead of silently scoring a
 * player who never got to move. Only model-caused failures (illegal or
 * unusable proposals) are handled in-loop.
 */
export async function runLLMBuildPhase(
  state: GameState,
  playerId: 1 | 2,
  client: LLMClient,
  logger: MatchLogger,
  signal?: AbortSignal,
  book?: BlueprintBook,
  memory?: MatchMemory,
): Promise<void> {
  const player = state.players[playerId - 1];
  const presetNames = PATTERNS.map(p => p.name);
  const hardCallCap = 2 * player.movesPerRound;

  let calls = 0;
  let illegalStreak = 0;
  let lastRejection: string | undefined;

  while (!player.committed && player.movesLeft > 0 && calls < hardCallCap) {
    if (signal?.aborted) return;
    calls++;
    const observation = serializeObservation(state, playerId, book, memory);

    let callResult;
    try {
      callResult = await client.getAction(observation, presetNames, lastRejection, {
        attemptFailed: info =>
          logger.log({ type: 'attempt_failed', playerId, modelId: client.modelId, callIndex: calls, ...info }),
        throttled: info =>
          logger.log({ type: 'throttled', playerId, modelId: client.modelId, callIndex: calls, ...info }),
        waiting: info =>
          logger.log({ type: 'call_waiting', playerId, modelId: client.modelId, callIndex: calls, ...info }),
      });
    } catch (err) {
      if (isFatalProviderError(err)) {
        logger.log({ type: 'llm_error', playerId, modelId: client.modelId, callIndex: calls, error: err.message });
        throw err;
      }
      if (err instanceof ModelResponseError) {
        logger.log({
          type: 'llm_bad_response',
          playerId,
          modelId: client.modelId,
          callIndex: calls,
          error: err.message,
        });
        lastRejection = `Your last response was unusable (${err.message}). Call one of the tools with all required fields.`;
        illegalStreak++;
        if (illegalStreak >= ILLEGAL_RETRY_CAP) {
          logger.log({ type: 'auto_skip', playerId, callIndex: calls, reason: err.message });
          break;
        }
        continue;
      }
      throw err;
    }
    if (signal?.aborted) return;

    const failures: string[] = [];
    let succeeded = 0;
    let submitted = false;

    for (let i = 0; i < callResult.actions.length; i++) {
      if (player.committed) break;
      const action = callResult.actions[i];
      const movesLeftBefore = player.movesLeft;

      let applyResult: ActionResult;
      try {
        applyResult = applyBenchAction(state, playerId, action, book);
      } catch (err) {
        applyResult = { ok: false, error: `Threw while applying action: ${String(err)}` };
      }

      logger.log({
        type: 'turn',
        playerId,
        modelId: client.modelId,
        callIndex: calls,
        batchIndex: i,
        batchSize: callResult.actions.length,
        round: state.round,
        movesLeftBefore,
        // Call-level data (observation, rationale, latency, tokens) is stored once, on the first action.
        observation: i === 0 ? observation : undefined,
        action,
        rationale: i === 0 ? callResult.rationale : undefined,
        analysis: i === 0 ? callResult.analysis : undefined,
        notes: i === 0 ? callResult.notes : undefined,
        applyResult,
        latencyMs: i === 0 ? callResult.latencyMs : 0,
        promptTokens: i === 0 ? callResult.promptTokens : undefined,
        completionTokens: i === 0 ? callResult.completionTokens : undefined,
        thoughtTokens: i === 0 ? callResult.thoughtTokens : undefined,
      });

      memory?.recordAction(playerId, action, applyResult);
      if (applyResult.ok) succeeded++;
      else failures.push(`${describeAction(action)}: ${applyResult.error}`);
      if (applyResult.submitted) submitted = true;
    }

    if (callResult.notes) memory?.setNotes(playerId, callResult.notes);
    emitSnapshot(logger, state);

    lastRejection = failures.length > 0 ? failures.join(' | ') : undefined;
    if (succeeded === 0) {
      illegalStreak++;
      if (illegalStreak >= ILLEGAL_RETRY_CAP) {
        logger.log({ type: 'auto_skip', playerId, callIndex: calls, reason: lastRejection ?? 'no valid action' });
        break;
      }
      continue;
    }

    illegalStreak = 0;
    if (submitted) break;
  }

  if (!player.committed) {
    state.submitBuild(playerId);
    logger.log({ type: 'force_submit', playerId, movesLeft: player.movesLeft, calls });
  }
}
