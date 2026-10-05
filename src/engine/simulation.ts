import { Cell } from './cell';
import { Grid } from './grid';
import { birthOwner, HEART_DAMAGE_CELL_CAP_PER_GEN, HEART_DAMAGE_PER_CELL, shouldSurvive } from './rules';
import type { Owner } from './types';
import type { PlayerState } from '../game/player';

export class Simulation {
  readonly source: Grid;
  current: Grid;
  private buffer: Grid;
  generation = 0;
  readonly cellMaxAge: number;
  private p1: PlayerState;
  private p2: PlayerState;
  p1HeartDamage = 0;
  p2HeartDamage = 0;

  constructor(sourceGrid: Grid, cellMaxAge: number, p1: PlayerState, p2: PlayerState) {
    this.source = sourceGrid;
    this.current = sourceGrid.clone();
    this.buffer = new Grid(sourceGrid.width, sourceGrid.height);
    this.cellMaxAge = cellMaxAge;
    this.p1 = p1;
    this.p2 = p2;
  }

  step(): Grid {
    const src = this.current;
    const dst = this.buffer;
    dst.generation = src.generation + 1;
    const gen = dst.generation;
    const maxAge = this.cellMaxAge;

    let p1Dmg = 0;
    let p2Dmg = 0;

    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const cell = src.getCell(x, y);
        if (!cell) continue;

        // Heart cells are inert: copied through untouched, never counted as neighbors.
        if (cell.alive && cell.fixed) {
          dst.setCell(x, y, cell.clone());
          continue;
        }

        // Each owner follows Life on its own cells: only live neighbors of the same owner count.
        const counts: Record<Owner, number> = { p1: 0, p2: 0, neutral: 0 };
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const n = src.getCell(x + dx, y + dy);
            if (n?.alive && !n.fixed) counts[n.owner ?? 'neutral']++;
          }
        }

        if (cell.alive) {
          if (cell.isExpired(gen, maxAge)) {
            dst.setCell(x, y, new Cell());
          } else if (shouldSurvive(cell, counts[cell.owner ?? 'neutral'])) {
            dst.setCell(x, y, cell.clone());
          } else {
            dst.setCell(x, y, new Cell());
          }
        } else {
          const owner = birthOwner(counts);
          if (owner) {
            dst.setCell(x, y, Cell.create(owner, gen));
          } else {
            dst.setCell(x, y, new Cell());
          }
        }
      }
    }

    this.resolveCollisions(dst);

    // Hit once, then die: every enemy cell inside a Heart zone deals HEART_DAMAGE_PER_CELL damage (at most
    // HEART_DAMAGE_CELL_CAP_PER_GEN cells count per generation) and all of them are removed this generation.
    const p1Hit = this.p1.heartPlaced ? this.removeInvaders(dst, this.p1.heartZone, 'p2') : 0;
    const p2Hit = this.p2.heartPlaced ? this.removeInvaders(dst, this.p2.heartZone, 'p1') : 0;
    p1Dmg = Math.min(p1Hit, HEART_DAMAGE_CELL_CAP_PER_GEN) * HEART_DAMAGE_PER_CELL;
    p2Dmg = Math.min(p2Hit, HEART_DAMAGE_CELL_CAP_PER_GEN) * HEART_DAMAGE_PER_CELL;
    this.p1.heartHp = Math.max(0, this.p1.heartHp - p1Dmg);
    this.p2.heartHp = Math.max(0, this.p2.heartHp - p2Dmg);
    this.p1HeartDamage += p1Dmg;
    this.p2HeartDamage += p2Dmg;

    const tmp = this.current;
    this.current = dst;
    this.buffer = tmp;
    this.generation = gen;
    return this.current;
  }

  /** Remove every live cell of `owner` inside `zone` (Heart cells are never touched); returns how many there were. */
  private removeInvaders(grid: Grid, zone: { x: number; y: number; w: number; h: number } | null, owner: Owner): number {
    if (!zone) return 0;
    let count = 0;
    for (let y = zone.y; y < zone.y + zone.h; y++) {
      for (let x = zone.x; x < zone.x + zone.w; x++) {
        const cell = grid.getCell(x, y);
        if (cell?.alive && !cell.fixed && cell.owner === owner) {
          count++;
          grid.setCell(x, y, new Cell());
        }
      }
    }
    return count;
  }

  private resolveCollisions(grid: Grid): void {
    const toKill: Array<[number, number]> = [];

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const cell = grid.getCell(x, y);
        if (!cell?.alive || cell.fixed) continue;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const neighbor = grid.getCell(x + dx, y + dy);
            if (!neighbor?.alive || neighbor.fixed) continue;

            if (cell.owner === 'p1' && neighbor.owner === 'p2') {
              toKill.push([x, y], [x + dx, y + dy]);
            } else if (cell.owner === 'p2' && neighbor.owner === 'p1') {
              toKill.push([x, y], [x + dx, y + dy]);
            } else if (
              cell.owner === 'neutral' &&
              (neighbor.owner === 'p1' || neighbor.owner === 'p2')
            ) {
              toKill.push([x, y]);
            }
          }
        }
      }
    }

    for (const [kx, ky] of toKill) {
      grid.setCell(kx, ky, new Cell());
    }
  }

  run(generations: number, onStep?: (grid: Grid, gen: number, total: number) => void): Grid {
    for (let i = 0; i < generations; i++) {
      this.step();
      onStep?.(this.current, this.generation, generations);
    }
    return this.current;
  }
}
