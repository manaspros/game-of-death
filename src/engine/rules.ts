import type { Cell } from './cell';
import type { Owner } from './types';

/**
 * Owner of a cell born on an empty square, given how many live neighbors of each owner it has.
 * Each owner follows Life on its own cells: it is born only if exactly one owner has exactly 3 neighbors
 * there. If two owners both have exactly 3, nothing is born.
 */
export function birthOwner(counts: Record<Owner, number>): Owner | null {
  const owners = (['p1', 'p2', 'neutral'] as const).filter(o => counts[o] === 3);
  return owners.length === 1 ? owners[0] : null;
}

/** Standard B3/S23 survival rule, applied to the number of live neighbors of the cell's own owner. */
export function shouldSurvive(cell: Cell, ownNeighborCount: number): boolean {
  if (cell.alive) {
    return ownNeighborCount === 2 || ownNeighborCount === 3;
  }
  return ownNeighborCount === 3;
}

/** HP a heart loses for each enemy cell inside its zone. */
export const HEART_DAMAGE_PER_CELL = 10;

/** Most enemy cells that deal damage to a heart in one generation (so at most 5 x 10 = 50 HP); extra cells are still removed. */
export const HEART_DAMAGE_CELL_CAP_PER_GEN = 5;
