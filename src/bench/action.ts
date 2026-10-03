import { PATTERNS, rotatePattern, type RotatedPattern } from '../game/patterns';
import type { GameState } from '../game/state';
import { MAX_CUSTOM_BOUNDING_BOX, type BlueprintBook } from './blueprints';
import type { ActionResult, BenchAction, PlaceAction } from './types';

/**
 * Free cleanup of your own leftovers: removes your own non-Heart cells inside
 * a box, clipped to your build zone. No moves are spent and none are refunded
 * (removing cells must not be a way to farm moves), and enemy cells, the Heart
 * and anything outside your zone are untouched.
 */
function clearCells(state: GameState, playerId: 1 | 2, region: { x: number; y: number; w: number; h: number }): ActionResult {
  if (!state.isBuildPhase) return { ok: false, error: 'You can only clear during the build phase.' };
  const player = state.players[playerId - 1];
  if (player.committed) return { ok: false, error: 'You already ended your turn.' };
  const { x, y, w, h } = region;
  if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1) {
    return { ok: false, error: 'A clear box needs whole numbers x, y, w, h with w and h at least 1.' };
  }
  const zone = playerId === 1 ? state.layout.p1Build : state.layout.p2Build;
  const owner = playerId === 1 ? 'p1' : 'p2';
  let removed = 0;
  for (let cy = Math.max(y, zone.y); cy < Math.min(y + h, zone.y + zone.h); cy++) {
    for (let cx = Math.max(x, zone.x); cx < Math.min(x + w, zone.x + zone.w); cx++) {
      const cell = state.grid.getCell(cx, cy);
      if (cell?.alive && cell.owner === owner && !cell.fixed) {
        state.grid.removeCell(cx, cy);
        removed++;
      }
    }
  }
  return removed > 0
    ? { ok: true }
    : {
        ok: false,
        error: `Clear box (${x}, ${y}, ${w}x${h}) holds none of your own removable cells inside your zone (x ${zone.x}-${zone.x + zone.w - 1}, y ${zone.y}-${zone.y + zone.h - 1}); enemy cells, your Heart and cells outside your zone cannot be cleared.`,
      };
}

type ResolvedPattern = { value: RotatedPattern } | { error: string };

export function applyBenchAction(
  state: GameState,
  playerId: 1 | 2,
  action: BenchAction,
  book?: BlueprintBook,
): ActionResult {
  if (action.action === 'clear') return clearCells(state, playerId, action.region);

  if (action.action === 'save_blueprint') {
    if (!state.isBuildPhase) return { ok: false, error: 'Blueprints can only be saved during the build phase.' };
    if (!book) return { ok: false, error: 'Blueprints are not available in this match.' };
    const saved = book.save(action.name, action.cells);
    return saved.ok ? { ok: true } : { ok: false, error: saved.error };
  }

  if (action.action === 'submit') {
    const ok = state.submitBuild(playerId);
    return ok ? { ok: true, submitted: true } : { ok: false, error: 'Already committed.' };
  }

  const player = state.players[playerId - 1];
  if (!player) return { ok: false, error: 'Invalid player id.' };

  const resolved = resolvePattern(action, book);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const pattern = resolved.value;

  if (pattern.name === 'Heart') {
    if (player.heartPlaced) return { ok: false, error: 'Heart already placed.' };
    const placed = state.placeHeart(action.anchor[0], action.anchor[1], pattern, playerId);
    return placed
      ? { ok: true }
      : { ok: false, error: explainFailure(state, playerId, pattern, action.anchor, 'heart') };
  }

  if (!player.heartPlaced) {
    return { ok: false, error: 'Must place Heart before any other pattern.' };
  }

  const newCells: [number, number][] = [];
  for (const [dx, dy] of pattern.cells) {
    const cx = action.anchor[0] + dx;
    const cy = action.anchor[1] + dy;
    if (!state.grid.getCell(cx, cy)?.alive) newCells.push([cx, cy]);
  }
  const placed = state.stampPattern(action.anchor[0], action.anchor[1], pattern, playerId);
  return placed
    ? { ok: true, placedCells: newCells }
    : { ok: false, error: explainFailure(state, playerId, pattern, action.anchor, 'pattern') };
}

/**
 * Say exactly why the engine refused a placement, in the order the engine
 * checks: already committed, outside the zone, nothing new, not enough moves.
 */
function explainFailure(
  state: GameState,
  playerId: 1 | 2,
  pattern: RotatedPattern,
  anchor: [number, number],
  kind: 'heart' | 'pattern',
): string {
  const player = state.players[playerId - 1];
  const zone = playerId === 1 ? state.layout.p1Build : state.layout.p2Build;
  const [ax, ay] = anchor;
  const what = `${pattern.name} at (${ax}, ${ay})`;

  if (player.committed) return `${what}: you already ended your turn.`;

  const dxs = pattern.cells.map(c => c[0]);
  const dys = pattern.cells.map(c => c[1]);
  const xMin = zone.x - Math.min(...dxs);
  const xMax = zone.x + zone.w - 1 - Math.max(...dxs);
  const yMin = zone.y - Math.min(...dys);
  const yMax = zone.y + zone.h - 1 - Math.max(...dys);
  const outside = pattern.cells.find(([dx, dy]) => {
    const x = ax + dx;
    const y = ay + dy;
    return x < zone.x || x >= zone.x + zone.w || y < zone.y || y >= zone.y + zone.h;
  });
  if (outside) {
    return (
      `${what}: cell (${ax + outside[0]}, ${ay + outside[1]}) is outside your buildZone ` +
      `(x ${zone.x}-${zone.x + zone.w - 1}, y ${zone.y}-${zone.y + zone.h - 1}). ` +
      `This shape needs anchor x in ${xMin}..${xMax} and y in ${yMin}..${yMax}.`
    );
  }

  if (kind === 'heart') {
    return player.heartPlaced ? 'Your Heart is already placed.' : `${what}: overlaps cells that are already alive; pick an empty spot.`;
  }

  let newCells = 0;
  for (const [dx, dy] of pattern.cells) {
    if (!state.grid.getCell(ax + dx, ay + dy)?.alive) newCells++;
  }
  if (newCells === 0) return `${what}: every cell is already alive there, so it would add nothing.`;
  if (newCells > player.movesLeft) {
    return `${what}: needs ${newCells} moves (one per new live cell) but you only have ${player.movesLeft} left.`;
  }
  return `${what}: refused by the game rules.`;
}

function resolvePattern(action: PlaceAction, book?: BlueprintBook): ResolvedPattern {
  if ('preset' in action) {
    const base = PATTERNS.find(p => p.name === action.preset) ?? book?.get(action.preset);
    if (!base) return { error: `Unknown preset or saved blueprint "${action.preset}".` };
    return { value: rotatePattern(base, action.rotation ?? 0) };
  }

  if (!Array.isArray(action.cells) || action.cells.length === 0) {
    return { error: 'cells must be a non-empty array of [dx, dy] pairs.' };
  }

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const [dx, dy] of action.cells) {
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    if (dx > maxX) maxX = dx;
    if (dy > maxY) maxY = dy;
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width > MAX_CUSTOM_BOUNDING_BOX || height > MAX_CUSTOM_BOUNDING_BOX) {
    return {
      error: `Custom pattern bounding box too large (${width}x${height}); max is ${MAX_CUSTOM_BOUNDING_BOX}x${MAX_CUSTOM_BOUNDING_BOX}.`,
    };
  }

  return {
    value: {
      name: 'Custom',
      category: 'special',
      cells: action.cells.map(([dx, dy]) => [dx, dy] as [number, number]),
      width,
      height,
    },
  };
}
