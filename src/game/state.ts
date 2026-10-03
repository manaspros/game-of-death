import { Grid } from '../engine/grid';
import { Simulation } from '../engine/simulation';
import type { BoardLayout, Owner, Phase, VisibilityMode } from '../engine/types';
import { getBoardLayout, getPreset, type Preset } from './presets';
import { PlayerState } from './player';
import type { RotatedPattern } from './patterns';

export const PHASE = {
  BUILD: 'build',
  SIMULATE: 'simulate',
  RESOLVE: 'resolve',
  GAMEOVER: 'gameover',
} as const satisfies Record<string, Phase>;

export type Winner = 1 | 2 | 'draw' | null;

export interface ResolveResult {
  p1Cells: number;
  p2Cells: number;
  p1Total: number;
  p2Total: number;
  p1Cumulative: number;
  p2Cumulative: number;
  p1HeartHp: number;
  p2HeartHp: number;
  winner: Winner;
  isGameOver: boolean;
}

export interface SimStep {
  grid: Grid;
  generation: number;
  total: number;
  done: boolean;
  p1HeartDamage: number;
  p2HeartDamage: number;
}

export class GameState {
  preset: Preset;
  layout: BoardLayout;
  grid: Grid;
  phase: Phase = PHASE.BUILD;
  round = 1;
  maxRounds: number;
  winner: Winner = null;
  simulation: Simulation | null = null;
  players: PlayerState[];
  visibility: VisibilityMode = 'semi-hidden';
  previousRoundGrid: Grid | null = null;

  constructor(presetName = 'standard') {
    this.preset = getPreset(presetName);
    this.layout = getBoardLayout(this.preset);
    this.grid = new Grid(this.preset.width, this.preset.height);
    this.maxRounds = this.preset.maxRounds;
    this.players = [
      new PlayerState(1, this.preset.movesPerRound),
      new PlayerState(2, this.preset.movesPerRound),
    ];
  }

  get isBuildPhase(): boolean {
    return this.phase === PHASE.BUILD;
  }

  get isSimulating(): boolean {
    return this.phase === PHASE.SIMULATE;
  }

  get isGameOver(): boolean {
    return this.phase === PHASE.GAMEOVER;
  }

  get bothCommitted(): boolean {
    return this.players[0].committed && this.players[1].committed;
  }

  getOwnerAtPosition(x: number, _y?: number): Owner | null {
    const layout = this.layout;
    if (x < layout.p1Build.x + layout.p1Build.w) return 'p1';
    if (x >= layout.p2Build.x) return 'p2';
    return null;
  }

  canPlace(x: number, y: number): boolean {
    if (!this.isBuildPhase) return false;
    const owner = this.getOwnerAtPosition(x, y);
    if (!owner) return false;
    const player = owner === 'p1' ? this.players[0] : this.players[1];
    if (!player.canPlace) return false;
    const cell = this.grid.getCell(x, y);
    if (cell?.alive) return false;
    return true;
  }

  placeCell(x: number, y: number): boolean {
    if (!this.canPlace(x, y)) return false;
    const owner = this.getOwnerAtPosition(x, y);
    if (!owner) return false;
    const player = owner === 'p1' ? this.players[0] : this.players[1];
    const placed = this.grid.placeCell(x, y, owner, this.grid.generation);
    if (placed) player.placeCell();
    return placed;
  }

  removeCell(x: number, y: number): boolean {
    if (!this.isBuildPhase) return false;
    const owner = this.getOwnerAtPosition(x, y);
    if (!owner) return false;
    const cell = this.grid.getCell(x, y);
    if (!cell?.alive) return false;
    if (cell.fixed) return false;
    if (cell.owner !== owner) return false;
    const player = owner === 'p1' ? this.players[0] : this.players[1];
    this.grid.removeCell(x, y);
    player.removeCell();
    return true;
  }

  toggleCell(x: number, y: number): boolean {
    if (!this.isBuildPhase) return false;
    const cell = this.grid.getCell(x, y);
    if (cell?.alive) {
      return this.removeCell(x, y);
    }
    return this.placeCell(x, y);
  }

  stampPattern(anchorX: number, anchorY: number, pattern: RotatedPattern, playerId: number): boolean {
    if (!this.isBuildPhase) return false;
    const owner: Owner = playerId === 1 ? 'p1' : 'p2';
    const zone = playerId === 1 ? this.layout.p1Build : this.layout.p2Build;
    const player = this.players[playerId - 1];
    if (!player || player.committed) return false;

    let deadCount = 0;
    for (const [dx, dy] of pattern.cells) {
      const cx = anchorX + dx;
      const cy = anchorY + dy;
      if (cx < zone.x || cx >= zone.x + zone.w || cy < zone.y || cy >= zone.y + zone.h) return false;
      const cell = this.grid.getCell(cx, cy);
      if (cell?.alive) continue;
      deadCount++;
    }

    if (deadCount === 0) return false;
    if (player.movesLeft < deadCount) return false;

    for (const [dx, dy] of pattern.cells) {
      const cx = anchorX + dx;
      const cy = anchorY + dy;
      const cell = this.grid.getCell(cx, cy);
      if (cell?.alive) continue;
      this.grid.placeCell(cx, cy, owner, this.grid.generation);
      player.placeCell();
    }
    return true;
  }

  placeHeart(anchorX: number, anchorY: number, pattern: RotatedPattern, playerId: number): boolean {
    if (!this.isBuildPhase) return false;
    const owner: Owner = playerId === 1 ? 'p1' : 'p2';
    const zone = playerId === 1 ? this.layout.p1Build : this.layout.p2Build;
    const player = this.players[playerId - 1];
    if (!player || player.committed) return false;
    if (player.heartPlaced) return false;

    for (const [dx, dy] of pattern.cells) {
      const cx = anchorX + dx;
      const cy = anchorY + dy;
      if (cx < zone.x || cx >= zone.x + zone.w || cy < zone.y || cy >= zone.y + zone.h) return false;
      const cell = this.grid.getCell(cx, cy);
      if (cell?.alive) return false;
    }

    for (const [dx, dy] of pattern.cells) {
      const cx = anchorX + dx;
      const cy = anchorY + dy;
      this.grid.placeCell(cx, cy, owner, this.grid.generation, true);
    }

    let minX = anchorX, minY = anchorY;
    let maxX = anchorX, maxY = anchorY;
    for (const [dx, dy] of pattern.cells) {
      const cx = anchorX + dx;
      const cy = anchorY + dy;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
    }

    player.heartPlaced = true;
    player.heartZone = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    return true;
  }

  submitBuild(playerId: number): boolean {
    const player = this.players[playerId - 1];
    if (!player || player.committed) return false;
    player.commit();
    return true;
  }

  startSimulation(): Simulation | null {
    if (!this.bothCommitted) return null;
    this.phase = PHASE.SIMULATE;
    this.previousRoundGrid = this.grid.clone();
    this.grid.generation = 0;
    this.simulation = new Simulation(
      this.grid,
      this.preset.cellMaxAge,
      this.players[0],
      this.players[1],
    );
    return this.simulation;
  }

  advanceSimulation(): SimStep | null {
    if (!this.simulation) return null;
    const result = this.simulation.step();
    this.grid = result;
    return {
      grid: result,
      generation: this.simulation.generation,
      total: this.preset.generationsPerRound,
      done: this.simulation.generation >= this.preset.generationsPerRound,
      p1HeartDamage: this.simulation.p1HeartDamage,
      p2HeartDamage: this.simulation.p2HeartDamage,
    };
  }

  countBattlefieldCells(owner: Owner): number {
    const bf = this.layout.battlefield;
    let count = 0;
    for (let y = bf.y; y < bf.y + bf.h; y++) {
      for (let x = bf.x; x < bf.x + bf.w; x++) {
        const cell = this.grid.getCell(x, y);
        if (cell?.alive && cell.owner === owner) count++;
      }
    }
    return count;
  }

  resolve(): ResolveResult {
    this.phase = PHASE.RESOLVE;

    const p1Cells = this.countBattlefieldCells('p1');
    const p2Cells = this.countBattlefieldCells('p2');
    const p1Total = this.grid.countByOwner('p1');
    const p2Total = this.grid.countByOwner('p2');

    this.players[0].score = p1Cells;
    this.players[1].score = p2Cells;
    this.players[0].totalScore += p1Cells;
    this.players[1].totalScore += p2Cells;

    const p1Hp = this.players[0].heartHp;
    const p2Hp = this.players[1].heartHp;

    if (p1Hp <= 0 && p2Hp <= 0) {
      this.winner = 'draw';
    } else if (p1Hp <= 0) {
      this.winner = 2;
    } else if (p2Hp <= 0) {
      this.winner = 1;
    } else if (this.round >= this.maxRounds) {
      this.winner = p1Hp > p2Hp ? 1 : p2Hp > p1Hp ? 2 : 'draw';
    }

    if (this.winner || this.round >= this.maxRounds) {
      this.phase = PHASE.GAMEOVER;
    }

    return {
      p1Cells,
      p2Cells,
      p1Total,
      p2Total,
      p1Cumulative: this.players[0].totalScore,
      p2Cumulative: this.players[1].totalScore,
      p1HeartHp: p1Hp,
      p2HeartHp: p2Hp,
      winner: this.winner,
      isGameOver: this.phase === PHASE.GAMEOVER,
    };
  }

  nextRound(): boolean {
    if (this.phase !== PHASE.RESOLVE && this.phase !== PHASE.GAMEOVER) return false;
    if (this.phase === PHASE.GAMEOVER) return false;

    this.round++;
    this.phase = PHASE.BUILD;
    this.simulation = null;

    for (const p of this.players) {
      p.resetForNewRound();
    }

    return true;
  }

  reset(presetName?: string): void {
    const preset = getPreset(presetName ?? this.preset.name.toLowerCase());
    this.preset = preset;
    this.layout = getBoardLayout(preset);
    this.grid = new Grid(preset.width, preset.height);
    this.phase = PHASE.BUILD;
    this.round = 1;
    this.maxRounds = preset.maxRounds;
    this.winner = null;
    this.simulation = null;
    this.previousRoundGrid = null;

    this.players = [
      new PlayerState(1, preset.movesPerRound),
      new PlayerState(2, preset.movesPerRound),
    ];
  }
}
