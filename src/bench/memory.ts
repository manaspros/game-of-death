import type { PlacedGroup } from './postmortem';
import type { ActionResult, BenchAction, RoundRecord } from './types';

export const MAX_NOTES_CHARS = 800;
/** Notes written by later calls in the same turn are appended; the whole block is capped here. */
export const MAX_TURN_NOTES_CHARS = 1600;
/** Only the most recent rounds are shown, to keep the observation small. */
export const HISTORY_ROUNDS = 6;

interface RoundResult {
  p1HeartHp: number;
  p2HeartHp: number;
  p1Cells: number;
  p2Cells: number;
}

/** Short text for a successful action, e.g. "LWSS/r0@9,18" or "save:Wedge". */
export function compactAction(action: BenchAction): string | null {
  if (action.action === 'submit') return null;
  if (action.action === 'save_blueprint') return `save:${action.name}`;
  if (action.action === 'clear') return `clear@${action.region.x},${action.region.y},${action.region.w}x${action.region.h}`;
  const name = 'preset' in action ? action.preset : `custom(${action.cells.length})`;
  const rotation = 'preset' in action && action.rotation ? `/r${action.rotation}` : '';
  return `${name}${rotation}@${action.anchor[0]},${action.anchor[1]}`;
}

/**
 * Memory for one match, for both seats. The model API is stateless, so this is
 * what makes "learn between rounds" possible: the notes a model wrote to its
 * future self, and an automatic record of what happened each round.
 */
export class MatchMemory {
  private notes: Record<1 | 2, string> = { 1: '', 2: '' };
  private pending: Record<1 | 2, string[]> = { 1: [], 2: [] };
  private rounds: Record<1 | 2, RoundRecord[]> = { 1: [], 2: [] };
  private hp = { 1: 100, 2: 100 };
  private placed: Record<1 | 2, PlacedGroup[]> = { 1: [], 2: [] };
  private notesWritesThisTurn: Record<1 | 2, number> = { 1: 0, 2: 0 };
  private reports: Record<1 | 2, string[]> = { 1: [], 2: [] };

  /**
   * The first notes of a turn replace last turn's (so a model carries forward
   * what still matters). Notes from later calls in the same turn are appended,
   * so a short follow-up call can never erase the plan the first call wrote.
   */
  setNotes(playerId: 1 | 2, text: string): void {
    const clean = text.trim().slice(0, MAX_NOTES_CHARS);
    if (!clean) return;
    if (this.notesWritesThisTurn[playerId] === 0) {
      this.notes[playerId] = clean;
    } else if (!this.notes[playerId].includes(clean)) {
      this.notes[playerId] = `${this.notes[playerId]}\n+ ${clean}`.slice(0, MAX_TURN_NOTES_CHARS);
    }
    this.notesWritesThisTurn[playerId]++;
  }

  /** Facts about the round that just finished, shown to that player on its next turn. */
  setReport(playerId: 1 | 2, lines: string[]): void {
    this.reports[playerId] = lines;
  }

  /** Cells each successful placement really added this round (input for the post-mortem). */
  placementsThisRound(): Record<1 | 2, PlacedGroup[]> {
    return this.placed;
  }

  recordAction(playerId: 1 | 2, action: BenchAction, result: ActionResult): void {
    if (!result.ok) return;
    const text = compactAction(action);
    // A partly applied placement is remembered as such, so history and the report never show it as the full shape.
    const shown = text && result.partial ? `${text} [only ${result.partial.placed}/${result.partial.total} cells]` : text;
    if (shown) this.pending[playerId].push(shown);
    if (text && result.placedCells && result.placedCells.length > 0) {
      this.placed[playerId].push({ label: shown ?? text, cells: result.placedCells, partial: result.partial });
    }
  }

  /** Call once per round, right after it resolves. */
  closeRound(round: number, result: RoundResult): void {
    const make = (id: 1 | 2): RoundRecord => {
      const mine = id === 1 ? result.p1HeartHp : result.p2HeartHp;
      const theirs = id === 1 ? result.p2HeartHp : result.p1HeartHp;
      const enemy = id === 1 ? 2 : 1;
      return {
        round,
        yourPlacements: this.pending[id],
        yourHeartHp: mine,
        damageYouTook: this.hp[id] - mine,
        enemyHeartHp: theirs,
        damageYouDealt: this.hp[enemy] - theirs,
        yourCellsOnBattlefield: id === 1 ? result.p1Cells : result.p2Cells,
        enemyCellsOnBattlefield: id === 1 ? result.p2Cells : result.p1Cells,
      };
    };
    const records = { 1: make(1), 2: make(2) };
    for (const id of [1, 2] as const) {
      this.rounds[id].push(records[id]);
      this.pending[id] = [];
      this.placed[id] = [];
      this.notesWritesThisTurn[id] = 0;
    }
    this.hp = { 1: result.p1HeartHp, 2: result.p2HeartHp };
  }

  view(playerId: 1 | 2): { notes: string; history: RoundRecord[]; lastRoundReport: string[]; thisTurn: string[] } {
    return {
      notes: this.notes[playerId],
      history: this.rounds[playerId].slice(-HISTORY_ROUNDS),
      lastRoundReport: this.reports[playerId],
      thisTurn: [...this.pending[playerId]],
    };
  }
}
