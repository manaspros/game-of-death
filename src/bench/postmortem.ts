import { Grid } from '../engine/grid';
import { Simulation } from '../engine/simulation';
import type { Owner, Zone } from '../engine/types';
import { PlayerState } from '../game/player';

export interface PlacedGroup {
  label: string;
  cells: [number, number][];
}

export interface PostMortemInput {
  /** The board as it was when the simulation started (everything both players had built). */
  preGrid: Grid;
  generations: number;
  cellMaxAge: number;
  heartZones: Record<1 | 2, Zone | null>;
  /** Successful placements this round, per player, with the cells they really added. */
  placements: Record<1 | 2, PlacedGroup[]>;
}

interface Run {
  /** Heart damage dealt TO each player over the whole run. */
  damageTo: Record<1 | 2, number>;
  /** Per generation (index 0 = generation 1): damage dealt to each player. */
  damagePerGen: Record<1 | 2, number[]>;
  /** Per generation: the other side's cells inside this player's Heart box. */
  invadersPerGen: Record<1 | 2, number[]>;
  /** Per generation: live cells of each owner (Hearts excluded). */
  aliveByGen: Record<1 | 2, number[]>;
  /** Farthest x reached per owner over the run (min and max). */
  xRange: Record<1 | 2, { min: number; max: number } | null>;
  final: Grid;
}

const OWNER: Record<1 | 2, Owner> = { 1: 'p1', 2: 'p2' };
const KEY = (x: number, y: number) => y * 10_000 + x;

function inBox(box: Zone, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}

/** Replay the round on a copy of the board, optionally without some cells. Pure: touches nothing real. */
function runRound(input: PostMortemInput, keep: (x: number, y: number, owner: Owner) => boolean): Run {
  const grid = input.preGrid.clone();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.getCell(x, y);
      if (cell?.alive && !cell.fixed && !keep(x, y, cell.owner ?? 'neutral')) grid.removeCell(x, y);
    }
  }
  const players = { 1: new PlayerState(1, 0), 2: new PlayerState(2, 0) };
  for (const id of [1, 2] as const) {
    const zone = input.heartZones[id];
    players[id].heartHp = 1_000_000;
    players[id].heartPlaced = zone !== null;
    players[id].heartZone = zone ? { ...zone } : null;
  }
  const sim = new Simulation(grid, input.cellMaxAge, players[1], players[2]);
  const run: Run = {
    damageTo: { 1: 0, 2: 0 },
    damagePerGen: { 1: [], 2: [] },
    invadersPerGen: { 1: [], 2: [] },
    aliveByGen: { 1: [], 2: [] },
    xRange: { 1: null, 2: null },
    final: grid,
  };
  let prev = { 1: 0, 2: 0 };
  for (let g = 0; g < input.generations; g++) {
    const g2 = sim.step();
    const alive = { 1: 0, 2: 0 };
    const invaders = { 1: 0, 2: 0 };
    for (let y = 0; y < g2.height; y++) {
      for (let x = 0; x < g2.width; x++) {
        const cell = g2.getCell(x, y);
        if (!cell?.alive || cell.fixed) continue;
        for (const id of [1, 2] as const) {
          if (cell.owner === OWNER[id]) {
            alive[id]++;
            const r = run.xRange[id];
            if (!r) run.xRange[id] = { min: x, max: x };
            else {
              if (x < r.min) r.min = x;
              if (x > r.max) r.max = x;
            }
          }
          const box = input.heartZones[id === 1 ? 2 : 1];
          if (box && cell.owner === OWNER[id] && inBox(box, x, y)) invaders[id === 1 ? 2 : 1]++;
        }
      }
    }
    const now = { 1: sim.p1HeartDamage, 2: sim.p2HeartDamage };
    for (const id of [1, 2] as const) {
      run.damagePerGen[id].push(now[id] - prev[id]);
      run.invadersPerGen[id].push(invaders[id]);
      run.aliveByGen[id].push(alive[id]);
    }
    prev = now;
    run.final = g2;
  }
  run.damageTo = { 1: sim.p1HeartDamage, 2: sim.p2HeartDamage };
  return run;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstGen = (xs: number[], pred: (n: number) => boolean) => {
  const i = xs.findIndex(pred);
  return i < 0 ? null : i + 1;
};

/**
 * Facts-only report of what really happened this round, per player, built by
 * replaying the round on a copy of the board: once as played, once for every
 * placement alone, and once for every placement removed. Nothing in it is a
 * guess: "alone" vs "in the real round" is a measured difference.
 */
export function buildPostMortem(input: PostMortemInput): Record<1 | 2, string[]> {
  const real = runRound(input, () => true);
  const out: Record<1 | 2, string[]> = { 1: [], 2: [] };

  for (const id of [1, 2] as const) {
    const enemyId = id === 1 ? 2 : 1;
    const mine = OWNER[id];
    const lines = out[id];
    const dealt = real.damageTo[enemyId];
    const took = real.damageTo[id];
    lines.push(`This round you dealt ${dealt} Heart damage and took ${took}.`);

    const enemyBox = input.heartZones[enemyId];
    const groups = input.placements[id];
    const shown = groups.slice(0, 10);
    shown.forEach((group, index) => {
      const own = new Set(group.cells.map(([x, y]) => KEY(x, y)));
      const alone = runRound(input, (x, y, owner) => owner === mine && own.has(KEY(x, y)));
      const without = runRound(input, (x, y, owner) => !(owner === mine && own.has(KEY(x, y))));
      const contribution = dealt - without.damageTo[enemyId];
      const aloneDamage = alone.damageTo[enemyId];

      const parts: string[] = [];
      const gone = firstGen(alone.aliveByGen[id], n => n === 0);
      const range = alone.xRange[id];
      if (gone !== null) parts.push(`alone it dies out by generation ${gone}`);
      else if (range) parts.push(`alone it survives the round and reaches x ${range.min}..${range.max}`);
      const entered = enemyBox ? firstGen(alone.damagePerGen[enemyId], n => n > 0) : null;
      parts.push(
        aloneDamage > 0
          ? `alone it hits their Heart box from generation ${entered} and deals ${aloneDamage}`
          : 'alone it deals 0 damage',
      );
      parts.push(`in the real round it contributed ${contribution}`);
      if (aloneDamage > contribution) parts.push('something on the real board (your other cells, enemy cells or a neighbouring placement) stopped it');
      else if (aloneDamage === 0 && contribution === 0) parts.push('it never reached their Heart box');
      lines.push(`#${index + 1} ${group.label}: ${parts.join('; ')}.`);
    });
    if (groups.length > shown.length) lines.push(`(${plural(groups.length - shown.length, 'more placement')} not listed.)`);
    if (groups.length === 0) lines.push('You placed nothing this round.');

    const myBox = input.heartZones[id];
    const invaders = real.invadersPerGen[id];
    const invadedGens = invaders.filter(n => n > 0).length;
    const lastInvaders = invaders[invaders.length - 1] ?? 0;
    if (myBox && invadedGens > 0) {
      const first = firstGen(invaders, n => n > 0);
      lines.push(
        `Enemy cells were inside YOUR Heart box in ${plural(invadedGens, 'generation')} (first at generation ${first}, peak ${Math.max(...invaders)} cells); at the end ${lastInvaders} are still there${lastInvaders > 0 ? ', so they keep hurting you next round until you destroy or outlast them' : ''}.`,
      );
    } else if (myBox) {
      lines.push('No enemy cell reached YOUR Heart box.');
    }
    const theirs = real.invadersPerGen[enemyId];
    const lastTheirs = theirs[theirs.length - 1] ?? 0;
    if (enemyBox && lastTheirs > 0) {
      lines.push(
        `At the end of the round ${plural(lastTheirs, 'of your cell')} sit inside THEIR Heart box and keep dealing damage each generation (last generation: ${real.damagePerGen[enemyId][real.damagePerGen[enemyId].length - 1] ?? 0}) until they are destroyed.`,
      );
    }
  }
  return out;
}
