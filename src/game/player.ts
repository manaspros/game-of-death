import type { Zone } from '../engine/types';

export class PlayerState {
  readonly id: number;
  movesPerRound: number;
  movesLeft: number;
  committed = false;
  score = 0;
  totalScore = 0;
  kills = 0;
  cellsPlaced = 0;

  heartHp = 100;
  heartMaxHp = 100;
  heartPlaced = false;
  heartZone: Zone | null = null;

  constructor(id: number, movesPerRound: number) {
    this.id = id;
    this.movesPerRound = movesPerRound;
    this.movesLeft = movesPerRound;
  }

  reset(movesPerRound: number): void {
    this.movesPerRound = movesPerRound;
    this.movesLeft = movesPerRound;
    this.committed = false;
  }

  resetForNewRound(): void {
    this.movesPerRound = this.movesPerRound;
    this.movesLeft = this.movesPerRound;
    this.committed = false;
  }

  placeCell(): boolean {
    if (this.movesLeft <= 0) return false;
    this.movesLeft--;
    this.cellsPlaced++;
    return true;
  }

  removeCell(): void {
    this.movesLeft++;
    this.cellsPlaced--;
  }

  commit(): void {
    this.committed = true;
  }

  get canPlace(): boolean {
    return this.movesLeft > 0 && !this.committed;
  }
}
