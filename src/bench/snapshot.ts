import type { Phase, Zone } from '../engine/types';
import type { GameState } from '../game/state';

export interface SideSnapshot {
  hp: number;
  movesLeft: number;
  committed: boolean;
  heartZone: Zone | null;
}

/** Compact board state for the live spectator. `cells` is a flat [x, y, owner, ...] list (1=p1, 2=p2, 3=neutral, 4=p1 heart, 5=p2 heart). */
export interface Snapshot {
  round: number;
  phase: Phase;
  generation: number;
  totalGenerations: number;
  width: number;
  height: number;
  zones: { p1: Zone; battlefield: Zone; p2: Zone };
  cells: number[];
  p1: SideSnapshot;
  p2: SideSnapshot;
}

export function buildSnapshot(state: GameState): Snapshot {
  const cells: number[] = [];
  const grid = state.grid;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.getCell(x, y);
      if (!cell?.alive) continue;
      const owner = cell.owner === 'p1' ? 1 : cell.owner === 'p2' ? 2 : 3;
      cells.push(x, y, cell.fixed ? owner + 3 : owner);
    }
  }

  const side = (i: 0 | 1): SideSnapshot => {
    const p = state.players[i];
    return {
      hp: p.heartHp,
      movesLeft: p.movesLeft,
      committed: p.committed,
      heartZone: p.heartZone ? { ...p.heartZone } : null,
    };
  };

  return {
    round: state.round,
    phase: state.phase,
    generation: state.simulation?.generation ?? 0,
    totalGenerations: state.preset.generationsPerRound,
    width: grid.width,
    height: grid.height,
    zones: {
      p1: { ...state.layout.p1Build },
      battlefield: { ...state.layout.battlefield },
      p2: { ...state.layout.p2Build },
    },
    cells,
    p1: side(0),
    p2: side(1),
  };
}
