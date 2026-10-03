import { Cell } from './cell';
import { Grid } from './grid';
import { determineOwner, HEART_DAMAGE_CAP_PER_GEN, shouldSurvive } from './rules';
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

        let aliveCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const n = src.getCell(x + dx, y + dy);
            if (n?.alive && !n.fixed) aliveCount++;
          }
        }

        if (cell.alive) {
          if (cell.isExpired(gen, maxAge)) {
            dst.setCell(x, y, new Cell());
          } else if (shouldSurvive(cell, aliveCount)) {
            dst.setCell(x, y, cell.clone());
          } else {
            dst.setCell(x, y, new Cell());
          }
        } else {
          if (aliveCount === 3) {
            const neighbors = src.getNeighbors(x, y).filter(n => !n.fixed);
            const owner = determineOwner(neighbors);
            dst.setCell(x, y, Cell.create(owner, gen));
          } else {
            dst.setCell(x, y, new Cell());
          }
        }
      }
    }

    this.resolveCollisions(dst);

    for (let y = 0; y < dst.height; y++) {
      for (let x = 0; x < dst.width; x++) {
        const cell = dst.getCell(x, y);
        if (!cell?.alive) continue;

        if (this.p1.heartZone && this.p1.heartPlaced) {
          const hz = this.p1.heartZone;
          if (x >= hz.x && x < hz.x + hz.w && y >= hz.y && y < hz.y + hz.h) {
            if (cell.owner === 'p2') {
              p1Dmg++;
            }
          }
        }

        if (this.p2.heartZone && this.p2.heartPlaced) {
          const hz = this.p2.heartZone;
          if (x >= hz.x && x < hz.x + hz.w && y >= hz.y && y < hz.y + hz.h) {
            if (cell.owner === 'p1') {
              p2Dmg++;
            }
          }
        }
      }
    }

    p1Dmg = Math.min(p1Dmg, HEART_DAMAGE_CAP_PER_GEN);
    p2Dmg = Math.min(p2Dmg, HEART_DAMAGE_CAP_PER_GEN);
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
