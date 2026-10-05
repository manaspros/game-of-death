import { HEART_DAMAGE_CELL_CAP_PER_GEN, HEART_DAMAGE_PER_CELL } from '../engine/rules';
import { Grid } from '../engine/grid';
import { Simulation } from '../engine/simulation';
import type { Owner, Zone } from '../engine/types';
import { PlayerState } from '../game/player';

export interface PlacedGroup {
  label: string;
  cells: [number, number][];
  /** Set when only some of the shape's cells landed (the rest were already occupied). */
  partial?: { placed: number; total: number; skipped: { x: number; y: number; reason: string }[] };
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
  /** Per generation: live cells of each owner (Hearts excluded). */
  aliveByGen: Record<1 | 2, number[]>;
  /** Farthest x reached per owner over the run (min and max). */
  xRange: Record<1 | 2, { min: number; max: number } | null>;
  /** Same for y. */
  yRange: Record<1 | 2, { min: number; max: number } | null>;
  /** Live cells of each owner in the last generation in which that owner still had any (Hearts excluded). */
  lastCells: Record<1 | 2, [number, number][]>;
  /** First generation in which a live cell of each owner touched (was within 1 of) that owner's own Heart box. */
  ownHeartGen: Record<1 | 2, number | null>;
  /** First generation in which a live cell of each owner stood on the outermost row or column of the board. */
  edgeGen: Record<1 | 2, number | null>;
  /** First generation in which a live cell of each owner touched (was within 1 of) a fixed cell of the ENEMY Heart, and which one. */
  enemyHeartTouch: Record<1 | 2, { gen: number; x: number; y: number } | null>;
  final: Grid;
}

const OWNER: Record<1 | 2, Owner> = { 1: 'p1', 2: 'p2' };
const KEY = (x: number, y: number) => y * 10_000 + x;

/** Replay the round on a copy of the board, optionally without some cells. Pure: touches nothing real. */
function runRound(input: PostMortemInput, keep: (x: number, y: number, owner: Owner) => boolean): Run {
  const grid = input.preGrid.clone();
  // The real round restarts its generation counter at 0 (GameState.startSimulation); the copy taken before that
  // still carries last round's count, which would make the age clock differ from the real one.
  grid.generation = 0;
  const heartKeys: Record<1 | 2, Map<number, [number, number]>> = { 1: new Map(), 2: new Map() };
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.getCell(x, y);
      if (cell?.alive && !cell.fixed && !keep(x, y, cell.owner ?? 'neutral')) grid.removeCell(x, y);
      if (cell?.alive && cell.fixed) heartKeys[cell.owner === 'p1' ? 1 : 2].set(KEY(x, y), [x, y]);
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
    aliveByGen: { 1: [], 2: [] },
    xRange: { 1: null, 2: null },
    yRange: { 1: null, 2: null },
    lastCells: { 1: [], 2: [] },
    ownHeartGen: { 1: null, 2: null },
    edgeGen: { 1: null, 2: null },
    enemyHeartTouch: { 1: null, 2: null },
    final: grid,
  };
  let prev = { 1: 0, 2: 0 };
  for (let g = 0; g < input.generations; g++) {
    const g2 = sim.step();
    const alive = { 1: 0, 2: 0 };
    const cells: Record<1 | 2, [number, number][]> = { 1: [], 2: [] };
    for (let y = 0; y < g2.height; y++) {
      for (let x = 0; x < g2.width; x++) {
        const cell = g2.getCell(x, y);
        if (!cell?.alive || cell.fixed) continue;
        for (const id of [1, 2] as const) {
          if (cell.owner === OWNER[id]) {
            alive[id]++;
            cells[id].push([x, y]);
            const own = input.heartZones[id];
            // Only the Heart's fixed cells are obstacles: merely passing near the (mostly empty) bounding box is not a collision.
            if (run.ownHeartGen[id] === null && own && distanceToBox(own, x, y) <= 1 && touchedFixedCell(heartKeys[id], x, y)) run.ownHeartGen[id] = g + 1;
            const foe = input.heartZones[id === 1 ? 2 : 1];
            if (run.enemyHeartTouch[id] === null && foe && distanceToBox(foe, x, y) <= 1) {
              const hit = touchedFixedCell(heartKeys[id === 1 ? 2 : 1], x, y);
              if (hit) run.enemyHeartTouch[id] = { gen: g + 1, x: hit[0], y: hit[1] };
            }
            if (run.edgeGen[id] === null && (x === 0 || y === 0 || x === g2.width - 1 || y === g2.height - 1)) run.edgeGen[id] = g + 1;
            const r = run.xRange[id];
            if (!r) run.xRange[id] = { min: x, max: x };
            else {
              if (x < r.min) r.min = x;
              if (x > r.max) r.max = x;
            }
            const ry = run.yRange[id];
            if (!ry) run.yRange[id] = { min: y, max: y };
            else {
              if (y < ry.min) ry.min = y;
              if (y > ry.max) ry.max = y;
            }
          }
        }
      }
    }
    const now = { 1: sim.p1HeartDamage, 2: sim.p2HeartDamage };
    for (const id of [1, 2] as const) {
      run.damagePerGen[id].push(now[id] - prev[id]);
      run.aliveByGen[id].push(alive[id]);
      if (alive[id] > 0) run.lastCells[id] = cells[id];
    }
    prev = now;
    run.final = g2;
  }
  run.damageTo = { 1: sim.p1HeartDamage, 2: sim.p2HeartDamage };
  return run;
}

/** A fixed Heart cell among the 8 neighbours of (x, y) (or at it), if any. */
function touchedFixedCell(keys: Map<number, [number, number]>, x: number, y: number): [number, number] | null {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const hit = keys.get(KEY(x + dx, y + dy));
      if (hit) return hit;
    }
  }
  return null;
}

/** Chebyshev distance from a cell to a box (0 when inside). */
function distanceToBox(box: Zone, x: number, y: number): number {
  return Math.max(box.x - x, 0, x - (box.x + box.w - 1), box.y - y, 0, y - (box.y + box.h - 1));
}

const span = (r: { min: number; max: number }) => (r.min === r.max ? `${r.min}` : `${r.min}..${r.max}`);

/** Why a placement that survives on its own never damaged their Heart: compare where it went with their Heart box. */
function missCause(box: Zone | null, mine: 1 | 2, alone: Run): string {
  const xs = alone.xRange[mine];
  const ys = alone.yRange[mine];
  if (!box) return 'their Heart box is not known yet';
  if (!xs || !ys) return 'it never reached their Heart box';
  const boxX = `x ${box.x}..${box.x + box.w - 1}`;
  const boxY = `y ${box.y}..${box.y + box.h - 1}`;
  if (ys.max < box.y || ys.min > box.y + box.h - 1) return `its rows y ${span(ys)} never overlap their Heart rows ${boxY}`;
  if (xs.max < box.x || xs.min > box.x + box.w - 1) return `its columns x ${span(xs)} never reach their Heart columns ${boxX}`;
  return `its path (x ${span(xs)}, y ${span(ys)}) passes beside their Heart box (${boxX}, ${boxY})`;
}

/**
 * Why a placement that did no damage on its own ended or went astray, most specific first: it expired (maxAge),
 * it ran into your own Heart box, it missed their Heart's rows/columns, it hit the board edge, or it burnt out by itself.
 * Returns the causes as short clauses (empty when nothing is determinable).
 */
function missCauses(input: PostMortemInput, mine: 1 | 2, alone: Run, gone: number | null, groupCells: [number, number][]): string[] {
  const out: string[] = [];
  const own = input.heartZones[mine];
  const startedNearOwn = own !== null && groupCells.some(([x, y]) => distanceToBox(own, x, y) <= 1);
  if (gone !== null && gone >= input.cellMaxAge) return [`expired: cells live at most ${input.cellMaxAge} generations`];
  const ownGen = alone.ownHeartGen[mine] !== null && !startedNearOwn ? alone.ownHeartGen[mine] : null;
  const foeTouch = alone.enemyHeartTouch[mine];
  let brokeOnHeart = true;
  if (ownGen !== null && (foeTouch === null || ownGen <= foeTouch.gen)) {
    out.push(`it ran into your own Heart box (generation ${ownGen}): Heart cells are fixed and always occupied, so a pattern that touches them loses cells`);
  } else if (foeTouch !== null) {
    out.push(`it ran into their Heart cells at (${foeTouch.x}, ${foeTouch.y}) (generation ${foeTouch.gen}) before delivering any damage: Heart cells are fixed and always occupied, so nothing can be born on them and the pattern breaks up there`);
  } else {
    brokeOnHeart = false;
    out.push(missCause(input.heartZones[mine === 1 ? 2 : 1], mine, alone));
  }
  if (alone.edgeGen[mine] !== null) out.push(`it reached the board edge (generation ${alone.edgeGen[mine]})`);
  else if (gone !== null && !brokeOnHeart) out.push('it burnt out by itself');
  return out;
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
      const rangeY = alone.yRange[id];
      if (gone !== null) parts.push(`alone it dies out by generation ${gone}`);
      else if (range && rangeY) parts.push(`alone it survives the round and reaches x ${span(range)}, y ${span(rangeY)}`);
      const entered = enemyBox ? firstGen(alone.damagePerGen[enemyId], n => n > 0) : null;
      if (group.partial) {
        const skipped = group.partial.skipped.map(c => `(${c.x}, ${c.y}) ${c.reason}`).join(', ');
        parts.push(`only ${group.partial.placed} of ${group.partial.total} cells were placed (skipped ${skipped}), so it is not the full shape`);
      }
      parts.push(
        aloneDamage > 0
          ? `alone it hits their Heart box from generation ${entered} and deals ${aloneDamage}`
          : 'alone it deals 0 damage',
      );
      parts.push(`in the real round it contributed ${contribution}`);
      if (aloneDamage > contribution) {
        // Keep only this placement plus everything that is not yours: if it is still stopped, the enemy cells did it.
        const vsEnemy = runRound(input, (x, y, owner) => owner !== mine || own.has(KEY(x, y)));
        parts.push(vsEnemy.damageTo[enemyId] < aloneDamage ? 'stopped by enemy cells (contact rule)' : 'stopped by your own other cells or placements');
      } else if (aloneDamage === 0 && contribution === 0) {
        const causes = missCauses(input, id, alone, gone, group.cells);
        if (causes.length > 0) parts.push(`no damage because ${causes.join('; ')}`);
      }
      lines.push(`#${index + 1} ${group.label}: ${parts.join('; ')}.`);
    });
    if (groups.length > shown.length) lines.push(`(${plural(groups.length - shown.length, 'more placement')} not listed.)`);
    if (groups.length === 0) lines.push('You placed nothing this round.');

    const myBox = input.heartZones[id];
    const hits = real.damagePerGen[id];
    const hitGens = hits.filter(n => n > 0).length;
    if (myBox && hitGens > 0) {
      lines.push(
        `Enemy cells reached YOUR Heart box in ${plural(hitGens, 'generation')} (first at generation ${firstGen(hits, n => n > 0)}) and cost you ${took} HP; each cell that reaches a Heart box deals ${HEART_DAMAGE_PER_CELL} damage (at most ${HEART_DAMAGE_CELL_CAP_PER_GEN} cells per generation) and is destroyed.`,
      );
    } else if (myBox) {
      lines.push('No enemy cell reached YOUR Heart box.');
    }
  }
  return out;
}
