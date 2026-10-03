import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameState } from '../game/state';
import { buildSnapshot, type Snapshot } from './snapshot';

export function emitSnapshot(logger: MatchLogger, state: GameState): void {
  if (logger.snapshot) logger.snapshot(buildSnapshot(state));
}

/**
 * Structured per-match logging — required by docs/AI_INTEGRATION.md §11,
 * not optional instrumentation. One JSON object per line.
 */
export interface MatchLogger {
  log(entry: Record<string, unknown>): void;
  /** High-volume board state for live viewers; the file logger ignores it. */
  snapshot?(snap: Snapshot): void;
}

/** Wraps a logger so each event also prints a one-line live summary to the console. */
export function withConsole(inner: MatchLogger): MatchLogger {
  return {
    log(entry: Record<string, unknown>) {
      inner.log(entry);
      const line = summarize(entry);
      if (line) console.log(line);
    },
  };
}

function label(p: unknown): string {
  const x = p as { provider?: string; modelId?: string } | undefined;
  return x?.modelId ? `${x.provider}/${x.modelId}` : 'baseline bot';
}

function summarize(e: Record<string, unknown>): string | null {
  switch (e.type) {
    case 'match_start':
      return `== match start: P1=${label(e.p1)} vs P2=${label(e.p2)} on "${e.preset}"`;
    case 'turn': {
      const a = e.action as { action: string; anchor?: number[]; preset?: string; cells?: unknown[]; name?: string };
      const r = e.applyResult as { ok: boolean; error?: string };
      const what =
        a.action === 'submit'
          ? 'submit'
          : a.action === 'save_blueprint'
            ? `save blueprint "${a.name}" (${a.cells?.length ?? 0} cells)`
            : a.action === 'clear'
              ? `clear box ${JSON.stringify((a as { region?: unknown }).region)}`
              : `place ${a.preset ?? `custom(${a.cells?.length ?? 0} cells)`}@(${a.anchor?.join(',')})`;
      const verdict = r.ok ? 'ok' : `REJECTED: ${r.error}`;
      const why = typeof e.rationale === 'string' ? `\n        why: ${e.rationale.slice(0, 220)}` : '';
      return `  R${e.round} P${e.playerId} call#${e.callIndex}${Number(e.batchSize) > 1 ? `.${Number(e.batchIndex) + 1}/${e.batchSize}` : ''} moves=${e.movesLeftBefore} ${what} -> ${verdict} (${e.latencyMs}ms)${why}`;
    }
    case 'attempt_failed':
      return `  !! P${e.playerId} call#${e.callIndex} attempt ${e.attempt}/${e.maxAttempts} failed after ${Math.round((e.elapsedMs as number) / 1000)}s: ${e.reason}${e.willRetry ? ` - retrying in ${Math.round(((e.retryInMs as number) ?? 0) / 1000)}s` : ' - giving up'}`;
    case 'llm_bad_response':
      return `  !! P${e.playerId} call#${e.callIndex} unusable model response: ${e.error}`;
    case 'match_invalid':
      return `== MATCH INVALID (P${e.playerId}, round ${e.round}): ${e.reason}`;
    case 'throttled':
      return `  ~~ P${e.playerId} call#${e.callIndex} spaced out ${Math.round((e.waitMs as number) / 100) / 10}s to respect the provider's rate limit`;
    case 'round_break':
      return `== resting ${Math.round((e.pauseMs as number) / 1000)}s before round ${e.nextRound}`;
    case 'round_start':
      return `== round ${e.round}/${e.maxRounds} starts`;
    case 'call_waiting':
      return `  ... P${e.playerId} call#${e.callIndex} still waiting on model (${Math.round((e.elapsedMs as number) / 1000)}s, attempt ${e.attempt})`;
    case 'llm_error':
      return `  !! llm_error P${e.playerId} call#${e.callIndex}: ${e.error}`;
    case 'auto_skip':
      return `  !! auto_skip P${e.playerId} after repeated illegal actions: ${e.reason}`;
    case 'force_submit':
      return `  -- force_submit P${e.playerId} (movesLeft=${e.movesLeft}, calls=${e.calls})`;
    case 'round_resolved':
      return `== round ${e.round} resolved: cells p1=${e.p1Cells} p2=${e.p2Cells} | heart HP p1=${e.p1HeartHp} p2=${e.p2HeartHp}`;
    case 'match_end':
      return `== match end: winner=${String(e.winner)}`;
    default:
      return null;
  }
}

export function createFileLogger(filePath: string): MatchLogger {
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    log(entry: Record<string, unknown>) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      appendFileSync(filePath, line + '\n', 'utf8');
    },
  };
}
