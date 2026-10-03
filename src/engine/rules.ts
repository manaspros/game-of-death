import type { Cell } from './cell';
import type { Owner } from './types';

/** Owner of a cell born from the given alive neighbors. */
export function determineOwner(neighbors: Cell[]): Owner {
  let p1 = 0;
  let p2 = 0;
  let neutral = 0;
  for (const n of neighbors) {
    if (!n.alive) continue;
    if (n.owner === 'p1') p1++;
    else if (n.owner === 'p2') p2++;
    else neutral++;
  }

  if (p1 > 0 && p2 === 0 && neutral === 0) return 'p1';
  if (p2 > 0 && p1 === 0 && neutral === 0) return 'p2';
  return 'neutral';
}

/** Standard B3/S23 Game of Life survival rule. */
export function shouldSurvive(cell: Cell, aliveNeighborCount: number): boolean {
  if (cell.alive) {
    return aliveNeighborCount === 2 || aliveNeighborCount === 3;
  }
  return aliveNeighborCount === 3;
}

/** Most HP a heart can lose in one generation, however many enemy cells sit in its zone. */
export const HEART_DAMAGE_CAP_PER_GEN = 5;
