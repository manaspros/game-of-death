import type { Grid } from '../engine/grid';
import { getPatternByName } from '../game/patterns';
import type { GameState } from '../game/state';
import { applyBenchAction } from './action';
import type { ActionResult, BenchAction } from './types';

export type BotActionListener = (action: BenchAction, result: ActionResult, movesLeftBefore: number) => void;

const BLOCK_COST = 4;
const GLIDER_COST = 5;
const GUARD_BLOCKS = 2;

/**
 * Where the enemy Heart sits, if the bot could legitimately know: Heart cells
 * are permanent, so they show up in the previous round's board, which is the
 * same information a human sees under semi-hidden visibility.
 */
function knownEnemyHeart(previous: Grid | null, enemyOwner: 'p1' | 'p2'): { x: number; y: number } | null {
  if (!previous) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < previous.height; y++) {
    for (let x = 0; x < previous.width; x++) {
      const c = previous.getCell(x, y);
      if (c?.alive && c.fixed && c.owner === enemyOwner) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n === 0 ? null : { x: Math.round(sx / n), y: Math.round(sy / n) };
}

/** Glider rotation that drifts toward +x/-x and +y/-y (0 down-right, 1 down-left, 2 up-left, 3 up-right). */
function headingRotation(towardRight: boolean, down: boolean): number {
  if (towardRight) return down ? 0 : 3;
  return down ? 1 : 2;
}

/**
 * Fixed, deterministic, non-LLM opponent - the comparability anchor described
 * in docs/AI_INTEGRATION.md section 7. Heart goes on the far side of its zone
 * and a pair of Blocks guards it. Gliders are aimed along diagonals that hit
 * the enemy Heart once it is known (round 2 onward); in round 1 they are
 * spread across all rows in both diagonal directions.
 */
export function runBaselineBotBuildPhase(
  state: GameState,
  playerId: 1 | 2,
  onAction?: BotActionListener,
): void {
  const player = state.players[playerId - 1];
  const act = (action: BenchAction): void => {
    const movesLeftBefore = player.movesLeft;
    const result = applyBenchAction(state, playerId, action);
    onAction?.(action, result, movesLeftBefore);
  };
  const zone = playerId === 1 ? state.layout.p1Build : state.layout.p2Build;
  const towardRight = playerId === 1;
  const towardEnemy = towardRight ? 1 : -1;
  const heartX = towardRight ? zone.x + 2 : zone.x + zone.w - 7;

  if (!player.heartPlaced) {
    act({
      action: 'place',
      anchor: [heartX, zone.y + zone.h / 2 - 2],
      preset: 'Heart',
    });
    const guardX = heartX + towardEnemy * 7;
    for (let i = 0; i < GUARD_BLOCKS && player.movesLeft >= BLOCK_COST; i++) {
      act({
        action: 'place',
        anchor: [guardX, zone.y + zone.h / 2 - 3 + i * 4],
        preset: 'Block',
      });
    }
  }

  if (!getPatternByName('Glider')) throw new Error('Glider preset not found.');
  const target = knownEnemyHeart(state.previousRoundGrid, playerId === 1 ? 'p2' : 'p1');
  const edgeX = towardRight ? zone.x + zone.w - 4 : zone.x + 1;
  const minY = zone.y;
  const maxY = zone.y + zone.h - 3;

  const count = Math.floor(player.movesLeft / GLIDER_COST);
  const step = Math.max(4, Math.floor((zone.h - 3) / Math.max(1, count)));
  for (let i = 0; i < count; i++) {
    if (player.movesLeft < GLIDER_COST) break;

    let rotation = headingRotation(towardRight, i % 2 === 0);
    let y = zone.y + ((i * step) % (zone.h - 3));

    if (target) {
      // A glider moves one cell sideways and one cell vertically together, so
      // it hits the target when |ty - y| equals the horizontal distance.
      const distance = Math.abs(target.x - edgeX);
      const wiggle = ((i >> 1) % 3 - 1) * 2;
      for (const down of i % 2 === 0 ? [true, false] : [false, true]) {
        const launchY = target.y - (down ? distance : -distance) + wiggle;
        if (launchY >= minY && launchY <= maxY) {
          y = launchY;
          rotation = headingRotation(towardRight, down);
          break;
        }
      }
    }

    act({ action: 'place', anchor: [edgeX, y], preset: 'Glider', rotation });
  }

  act({ action: 'submit' });
}
