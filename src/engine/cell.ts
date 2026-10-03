import type { Owner } from './types';

export class Cell {
  alive = false;
  owner: Owner | null;
  birthGen: number;
  /** Heart cells: never change, die, or expire, and are ignored by every Game of Life rule. */
  fixed = false;

  constructor(owner: Owner | null = null, birthGen = 0) {
    this.owner = owner;
    this.birthGen = birthGen;
  }

  static create(owner: Owner, birthGen: number, fixed = false): Cell {
    const cell = new Cell(owner, birthGen);
    cell.alive = true;
    cell.fixed = fixed;
    return cell;
  }

  age(currentGen: number): number {
    return currentGen - this.birthGen;
  }

  isExpired(currentGen: number, maxAge: number): boolean {
    return this.alive && this.age(currentGen) >= maxAge;
  }

  clone(): Cell {
    const c = new Cell(this.owner, this.birthGen);
    c.alive = this.alive;
    c.fixed = this.fixed;
    return c;
  }
}
