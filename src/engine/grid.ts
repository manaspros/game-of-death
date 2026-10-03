import { Cell } from './cell';
import type { Owner } from './types';

export class Grid {
  readonly width: number;
  readonly height: number;
  cells: Cell[];
  generation = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Array(width * height);
    this.clear();
  }

  clear(): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = new Cell();
    }
    this.generation = 0;
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  getCell(x: number, y: number): Cell | null {
    if (!this.inBounds(x, y)) return null;
    return this.cells[this.idx(x, y)];
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (!this.inBounds(x, y)) return;
    this.cells[this.idx(x, y)] = cell;
  }

  placeCell(x: number, y: number, owner: Owner, birthGen: number, fixed = false): boolean {
    if (!this.inBounds(x, y)) return false;
    const cell = this.getCell(x, y);
    if (cell?.alive) return false;
    this.setCell(x, y, Cell.create(owner, birthGen, fixed));
    return true;
  }

  removeCell(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    this.cells[this.idx(x, y)] = new Cell();
  }

  toggleCell(x: number, y: number, owner: Owner, birthGen: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const cell = this.getCell(x, y);
    if (cell?.alive) {
      this.removeCell(x, y);
      return false;
    }
    this.placeCell(x, y, owner, birthGen);
    return true;
  }

  countAlive(): number {
    let count = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i].alive) count++;
    }
    return count;
  }

  countByOwner(owner: Owner): number {
    let count = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i].alive && this.cells[i].owner === owner) count++;
    }
    return count;
  }

  clone(): Grid {
    const g = new Grid(this.width, this.height);
    g.generation = this.generation;
    for (let i = 0; i < this.cells.length; i++) {
      g.cells[i] = this.cells[i].clone();
    }
    return g;
  }

  getNeighbors(x: number, y: number): Cell[] {
    const neighbors: Cell[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cell = this.getCell(x + dx, y + dy);
        if (cell) neighbors.push(cell);
      }
    }
    return neighbors;
  }
}
