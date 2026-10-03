import type { PresetName } from '../engine/types';
import { GameState } from '../game/state';
import { BlueprintBook } from './blueprints';
import { INTRO } from './copy';
import { applyBenchAction } from './action';
import { buildSnapshot, type Snapshot } from './snapshot';
import type { ActionResult, BenchAction } from './types';

/**
 * Rebuilds a finished match from its JSONL log by replaying the logged
 * actions through the real game engine, and turns it into a list of frames
 * with fixed durations. Pure (no DOM, no Node APIs) so the browser replay
 * page and the Node tests share it. Verified against the logged results.
 */

export interface LogEvent {
  type: string;
  [key: string]: unknown;
}

export interface PlayerLabel {
  name: string;
  provider: string;
}

export interface CardData {
  title: string;
  subtitle?: string;
  lines: string[];
  accent: 'p1' | 'p2' | 'neutral';
}

export interface Caption {
  playerId: 1 | 2;
  who: string;
  action: string;
  rationale?: string;
  status: 'ok' | 'rejected' | 'bot';
  detail?: string;
}

export type ReplayFrame =
  /** `alpha` fades the card in and out (1 = fully shown). */
  | { kind: 'card'; durationMs: number; card: CardData; snapshot: Snapshot; alpha: number }
  /** `fresh` is a flat [x, y, ...] list of cells that were just placed, for highlighting. */
  | { kind: 'board'; durationMs: number; snapshot: Snapshot; headline: string; captions?: Caption[]; fresh?: number[] }
  /** A model's written analysis, shown over the board just before its placements appear. */
  | { kind: 'analysis'; durationMs: number; snapshot: Snapshot; playerId: 1 | 2; who: string; text: string };

export interface Timeline {
  frames: ReplayFrame[];
  players: [PlayerLabel, PlayerLabel];
  preset: string;
  maxRounds: number;
  fps: number;
  /** Replay-vs-log mismatches. Empty means the replay reproduced the logged match exactly. */
  warnings: string[];
  totalMs: number;
}

export interface TimelineOptions {
  /** Output frame rate. Every frame duration is a whole number of these frames, so playback is evenly paced. */
  fps?: number;
  /** Video time shown per player move, regardless of how long the model really took. */
  stepMs?: number;
  titleCardMs?: number;
  howCardMs?: number;
  matchCardMs?: number;
  roundCardMs?: number;
  breakCardMs?: number;
  endCardMs?: number;
  fadeFrames?: number;
  /** Show each model's written analysis before its moves (default true). */
  showAnalysis?: boolean;
}

const DEFAULTS: Required<TimelineOptions> = {
  fps: 30,
  stepMs: 1100,
  titleCardMs: 2600,
  howCardMs: 7000,
  matchCardMs: 3200,
  roundCardMs: 1500,
  breakCardMs: 2400,
  endCardMs: 6000,
  fadeFrames: 5,
  showAnalysis: true,
};

/** Rationales are flavour text on screen; the full text lives in the log and summary. */
const CAPTION_RATIONALE_MAX = 110;
/** The on-screen analysis panel fits about this much text; the full text stays in the log. */
const ANALYSIS_MAX_CHARS = 800;

export function parseJsonl(text: string): LogEvent[] {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as LogEvent);
}

export function describeAction(action: BenchAction): string {
  if (action.action === 'submit') return 'submit turn';
  if (action.action === 'save_blueprint') return `save blueprint "${action.name}" (${action.cells.length} cells)`;
  if (action.action === 'clear') return `clear own cells in box (${action.region.x}, ${action.region.y}, ${action.region.w}x${action.region.h})`;
  const at = `@ (${action.anchor[0]}, ${action.anchor[1]})`;
  if ('preset' in action) {
    const turns = action.rotation ? ` rotated ${action.rotation * 90}°` : '';
    return `place ${action.preset}${turns} ${at}`;
  }
  return `place custom shape (${action.cells.length} cells) ${at}`;
}

function labelOf(raw: unknown): PlayerLabel {
  const p = raw as { provider?: string; modelId?: string } | null | undefined;
  return p?.modelId ? { name: p.modelId, provider: p.provider ?? '' } : { name: 'Baseline bot', provider: 'scripted' };
}

const asPlayer = (v: unknown): 1 | 2 => (Number(v) === 2 ? 2 : 1);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function buildTimeline(events: LogEvent[], options: TimelineOptions = {}): Timeline {
  const opt = { ...DEFAULTS, ...options };
  const frameMs = 1000 / opt.fps;
  /** Snap a duration to a whole number of output frames (at least one). */
  const snap = (ms: number): number => Math.max(1, Math.round(ms / frameMs)) * frameMs;

  const start = events.find(e => e.type === 'match_start');
  if (!start) throw new Error('This log has no match_start event, so it cannot be replayed.');

  const players: [PlayerLabel, PlayerLabel] = [labelOf(start.p1), labelOf(start.p2)];
  const preset = String(start.preset ?? 'standard');
  const state = new GameState(preset as PresetName);
  const loggedRounds = Number(start.maxRounds);
  if (Number.isInteger(loggedRounds) && loggedRounds > 0) state.maxRounds = loggedRounds;
  const warnings: string[] = [];
  const frames: ReplayFrame[] = [];

  // Per-player proposal stats for the closing card.
  const stats = { 1: { proposals: 0, rejected: 0 }, 2: { proposals: 0, rejected: 0 } };
  for (const e of events) {
    if (e.type !== 'turn') continue;
    const s = stats[asPlayer(e.playerId)];
    s.proposals++;
    if (!(e.applyResult as ActionResult).ok) s.rejected++;
  }

  const hp = () => `${players[0].name} ${state.players[0].heartHp}  ·  ${players[1].name} ${state.players[1].heartHp}`;

  /** A card that fades in, holds, and fades out; `holdMs` is the total on-screen time. */
  const card = (c: CardData, holdMs: number): void => {
    const snapshot = buildSnapshot(state);
    const fade = opt.fadeFrames;
    const steady = snap(holdMs) - 2 * fade * frameMs;
    for (let i = 1; i <= fade; i++) frames.push({ kind: 'card', durationMs: frameMs, card: c, snapshot, alpha: i / (fade + 1) });
    frames.push({ kind: 'card', durationMs: Math.max(frameMs, steady), card: c, snapshot, alpha: 1 });
    for (let i = fade; i >= 1; i--) frames.push({ kind: 'card', durationMs: frameMs, card: c, snapshot, alpha: i / (fade + 1) });
  };

  let lastCells = new Set<string>();
  const cellKeys = (snapshot: Snapshot): Set<string> => {
    const keys = new Set<string>();
    for (let i = 0; i < snapshot.cells.length; i += 3) keys.add(`${snapshot.cells[i]},${snapshot.cells[i + 1]}`);
    return keys;
  };
  const board = (headline: string, durationMs: number, captions?: Caption[], highlightNew = false): void => {
    const snapshot = buildSnapshot(state);
    let fresh: number[] | undefined;
    if (highlightNew) {
      fresh = [];
      for (let i = 0; i < snapshot.cells.length; i += 3) {
        if (!lastCells.has(`${snapshot.cells[i]},${snapshot.cells[i + 1]}`)) fresh.push(snapshot.cells[i], snapshot.cells[i + 1]);
      }
    }
    lastCells = cellKeys(snapshot);
    frames.push({ kind: 'board', durationMs: snap(durationMs), snapshot, headline, captions, fresh });
  };

  // Both players build at the same time, so their k-th moves are shown together.
  interface Queued {
    action: BenchAction;
    logged: ActionResult;
    rationale?: string;
    analysis?: string;
    isBot: boolean;
  }
  const queue: Record<1 | 2, Queued[]> = { 1: [], 2: [] };
  const books: Record<1 | 2, BlueprintBook> = { 1: new BlueprintBook(), 2: new BlueprintBook() };
  const forced = new Set<1 | 2>();

  const analysisFrame = (playerId: 1 | 2, raw: string): void => {
    const clean = raw.replace(/\s+/g, ' ').trim();
    const text = clean.length > ANALYSIS_MAX_CHARS ? `${clean.slice(0, ANALYSIS_MAX_CHARS - 1).trimEnd()}…` : clean;
    frames.push({
      kind: 'analysis',
      durationMs: snap(Math.min(3500, 1200 + text.length * 3)),
      snapshot: buildSnapshot(state),
      playerId,
      who: players[playerId - 1].name,
      text,
    });
  };

  const flushBuildPhase = (): void => {
    const steps = Math.max(queue[1].length, queue[2].length);
    for (let k = 0; k < steps; k++) {
      // The models think first, then their placements appear.
      if (opt.showAnalysis) {
        for (const playerId of [1, 2] as const) {
          const analysis = queue[playerId][k]?.analysis;
          if (analysis) analysisFrame(playerId, analysis);
        }
      }
      const captions: Caption[] = [];
      let hold = 0;
      for (const playerId of [1, 2] as const) {
        const q = queue[playerId][k];
        if (!q) continue;
        if (q.logged.ok) {
          const replayed = applyBenchAction(state, playerId, q.action, books[playerId]);
          if (!replayed.ok) warnings.push(`Round ${state.round}: P${playerId} action replayed as illegal (${replayed.error}).`);
        }
        if (q.isBot && q.action.action === 'submit') continue;
        const rationale =
          q.rationale && q.rationale.length > CAPTION_RATIONALE_MAX
            ? `${q.rationale.slice(0, CAPTION_RATIONALE_MAX - 1).trimEnd()}…`
            : q.rationale;
        captions.push({
          playerId,
          who: players[playerId - 1].name,
          action: describeAction(q.action),
          rationale,
          status: q.isBot ? 'bot' : q.logged.ok ? 'ok' : 'rejected',
          detail: q.logged.ok ? undefined : q.logged.error,
        });
        // Fixed pace: the video does not wait for the model, however long it really took.
        hold = Math.max(hold, q.isBot ? opt.stepMs * 0.6 : q.logged.ok ? opt.stepMs : opt.stepMs * 1.4);
      }
      if (captions.length > 0) board(`Round ${state.round} · build phase`, hold, captions, true);
    }
    forced.forEach(id => state.submitBuild(id));
    forced.clear();
    queue[1] = [];
    queue[2] = [];
  };

  // ---- Intro: what this is, then who is playing ----
  card({ title: INTRO.title, subtitle: INTRO.tagline, lines: [], accent: 'neutral' }, opt.titleCardMs);
  card({ title: 'HOW IT WORKS', lines: [...INTRO.steps], accent: 'neutral' }, opt.howCardMs);
  card(
    {
      title: 'TODAY',
      subtitle: `${players[0].name}  vs  ${players[1].name}`,
      lines: [`arena: ${preset}`],
      accent: 'neutral',
    },
    opt.matchCardMs,
  );
  lastCells = cellKeys(buildSnapshot(state));

  for (const e of events) {
    switch (e.type) {
      case 'round_start': {
        const round = num(e.round);
        card(
          { title: `ROUND ${round}`, subtitle: `of ${num(e.maxRounds)}`, lines: ['Heart HP', hp()], accent: 'neutral' },
          opt.roundCardMs,
        );
        lastCells = cellKeys(buildSnapshot(state));
        board(`Round ${round} · build phase`, 400);
        break;
      }

      case 'turn':
      case 'bot_turn': {
        queue[asPlayer(e.playerId)].push({
          action: e.action as BenchAction,
          logged: e.applyResult as ActionResult,
          rationale: typeof e.rationale === 'string' ? e.rationale : undefined,
          analysis: typeof e.analysis === 'string' ? e.analysis : undefined,
          isBot: e.type === 'bot_turn',
        });
        break;
      }

      case 'force_submit':
        forced.add(asPlayer(e.playerId));
        break;

      case 'simulation_start': {
        flushBuildPhase();
        state.submitBuild(1);
        state.submitBuild(2);
        if (!state.startSimulation()) {
          warnings.push(`Round ${state.round}: simulation could not start during replay.`);
          break;
        }
        board(`Round ${state.round} · both players committed`, 900);
        const total = state.preset.generationsPerRound;
        while (state.simulation && state.simulation.generation < total) {
          state.advanceSimulation();
          // One generation per output frame: an even cadence is what makes it look smooth.
          board(`Round ${state.round} · simulating · generation ${state.simulation?.generation ?? total}/${total}`, frameMs);
        }
        break;
      }

      case 'round_resolved': {
        const result = state.resolve();
        if (
          result.p1HeartHp !== num(e.p1HeartHp) ||
          result.p2HeartHp !== num(e.p2HeartHp) ||
          result.p1Cells !== num(e.p1Cells) ||
          result.p2Cells !== num(e.p2Cells)
        ) {
          warnings.push(
            `Round ${num(e.round)}: replay diverged from the log (HP ${result.p1HeartHp}/${result.p2HeartHp} vs logged ${num(e.p1HeartHp)}/${num(e.p2HeartHp)}).`,
          );
        }
        board(`Round ${num(e.round)} resolved · cells ${result.p1Cells} vs ${result.p2Cells}`, 1200);
        if (!result.isGameOver) state.nextRound();
        break;
      }

      case 'round_break':
        card(
          {
            title: `ROUND ${num(e.round)} COMPLETE`,
            subtitle: `Next: round ${num(e.nextRound)}`,
            lines: [
              'Cells on the field',
              `${players[0].name} ${num(e.p1Cells)}  ·  ${players[1].name} ${num(e.p2Cells)}`,
              '',
              'Heart HP',
              `${players[0].name} ${num(e.p1HeartHp)}  ·  ${players[1].name} ${num(e.p2HeartHp)}`,
            ],
            accent: 'neutral',
          },
          opt.breakCardMs,
        );
        break;

      case 'match_end': {
        const winner = e.winner;
        const title = winner === 1 || winner === 2 ? `${players[winner - 1].name} WINS` : 'DRAW';
        const stat = (id: 1 | 2) =>
          `${players[id - 1].name}: ${stats[id].proposals} moves proposed, ${stats[id].rejected} rejected`;
        card(
          {
            title: 'MATCH OVER',
            subtitle: title,
            lines: [
              'Final heart HP',
              `${players[0].name} ${num(e.p1HeartHp)}  ·  ${players[1].name} ${num(e.p2HeartHp)}`,
              '',
              ...(stats[1].proposals + stats[2].proposals > 0 ? [stat(1), stat(2)].filter(l => !l.includes(': 0 moves')) : []),
            ],
            accent: winner === 1 ? 'p1' : winner === 2 ? 'p2' : 'neutral',
          },
          opt.endCardMs,
        );
        break;
      }

      case 'match_invalid':
        flushBuildPhase();
        card(
          {
            title: 'MATCH INVALID',
            subtitle: 'not scoreable',
            lines: [`Player ${num(e.playerId)}'s provider failed in round ${num(e.round)}.`, String(e.reason ?? '').slice(0, 160)],
            accent: 'neutral',
          },
          opt.endCardMs,
        );
        break;
    }
  }

  return {
    frames,
    players,
    preset,
    maxRounds: state.maxRounds,
    fps: opt.fps,
    warnings,
    totalMs: frames.reduce((sum, f) => sum + f.durationMs, 0),
  };
}
