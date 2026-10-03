import type { GameState } from '../game/state';
import type { RotatedPattern } from '../game/patterns';

const COLORS = {
  p1: '#4a9eff',
  p2: '#ff6b8a',
  neutral: '#ffffff',
  dead: '#0c0c14',
  p1BuildBg: 'rgba(74, 158, 255, 0.05)',
  p2BuildBg: 'rgba(255, 107, 138, 0.05)',
  battlefieldBg: '#0a0a10',
  previousP1: 'rgba(74, 158, 255, 0.18)',
  previousP2: 'rgba(255, 107, 138, 0.18)',
  ghostValidP1: 'rgba(74, 158, 255, 0.3)',
  ghostValidP2: 'rgba(255, 107, 138, 0.3)',
  ghostInvalid: 'rgba(220, 60, 60, 0.25)',
  heartP1: 'rgba(74, 158, 255, 0.15)',
  heartP2: 'rgba(255, 107, 138, 0.15)',
  heartBorderP1: 'rgba(74, 158, 255, 0.5)',
  heartBorderP2: 'rgba(255, 107, 138, 0.5)',
  heartCellP1: 'rgba(74, 158, 255, 0.7)',
  heartCellP2: 'rgba(255, 107, 138, 0.7)',
} as const;

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private game: GameState;
  private cellSize = 0;
  private onResize = (): void => this.resize();
  previewPattern: RotatedPattern | null = null;
  previewCell: { x: number; y: number } | null = null;
  previewPlayerId: number | null = null;

  constructor(canvas: HTMLCanvasElement, gameState: GameState) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.ctx = ctx;
    this.game = gameState;

    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  resize(): void {
    const container = this.canvas.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const maxW = rect.width - 16;
    const maxH = rect.height - 16;

    const gw = this.game.preset.width;
    const gh = this.game.preset.height;

    this.cellSize = Math.floor(Math.min(maxW / gw, maxH / gh));
    this.cellSize = Math.max(this.cellSize, 2);

    this.canvas.width = gw * this.cellSize * dpr;
    this.canvas.height = gh * this.cellSize * dpr;
    this.canvas.style.width = `${gw * this.cellSize}px`;
    this.canvas.style.height = `${gh * this.cellSize}px`;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  cellAtPixel(px: number, py: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((px - rect.left) / this.cellSize);
    const y = Math.floor((py - rect.top) / this.cellSize);
    if (this.game.grid.inBounds(x, y)) {
      return { x, y };
    }
    return null;
  }

  render(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const grid = this.game.grid;
    const layout = this.game.layout;
    const w = grid.width * cs;
    const h = grid.height * cs;

    ctx.fillStyle = COLORS.dead;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = COLORS.p1BuildBg;
    ctx.fillRect(
      layout.p1Build.x * cs,
      layout.p1Build.y * cs,
      layout.p1Build.w * cs,
      layout.p1Build.h * cs,
    );

    ctx.fillStyle = COLORS.p2BuildBg;
    ctx.fillRect(
      layout.p2Build.x * cs,
      layout.p2Build.y * cs,
      layout.p2Build.w * cs,
      layout.p2Build.h * cs,
    );

    ctx.fillStyle = COLORS.battlefieldBg;
    ctx.fillRect(
      layout.battlefield.x * cs,
      layout.battlefield.y * cs,
      layout.battlefield.w * cs,
      layout.battlefield.h * cs,
    );

    if (
      this.game.isBuildPhase &&
      this.game.visibility === 'semi-hidden' &&
      this.game.previousRoundGrid
    ) {
      this.renderPreviousRound();
    }

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        this.renderCell(x, y);
      }
    }

    this.renderHeartZones();

    ctx.strokeStyle = 'rgba(74, 158, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      layout.p1Build.x * cs,
      layout.p1Build.y * cs,
      layout.p1Build.w * cs,
      layout.p1Build.h * cs,
    );

    ctx.strokeStyle = 'rgba(255, 107, 138, 0.3)';
    ctx.strokeRect(
      layout.p2Build.x * cs,
      layout.p2Build.y * cs,
      layout.p2Build.w * cs,
      layout.p2Build.h * cs,
    );

    this.renderZoneLabels();

    if (this.previewPattern && this.previewCell && this.game.isBuildPhase) {
      this.renderPreview();
    }
  }

  private renderCell(x: number, y: number): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const cell = this.game.grid.getCell(x, y);
    if (!cell) return;
    const px = x * cs;
    const py = y * cs;

    if (cell.alive) {
      const color = cell.owner === 'p1' ? COLORS.p1 : cell.owner === 'p2' ? COLORS.p2 : COLORS.neutral;
      ctx.fillStyle = color;
      ctx.fillRect(px, py, cs, cs);
    } else {
      const owner = this.game.getOwnerAtPosition(x, y);
      ctx.fillStyle =
        owner === 'p1' ? COLORS.p1BuildBg : owner === 'p2' ? COLORS.p2BuildBg : COLORS.battlefieldBg;
      ctx.fillRect(px, py, cs, cs);
    }
  }

  private renderHeartZones(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;

    for (const player of this.game.players) {
      if (!player.heartPlaced || !player.heartZone) continue;
      const hz = player.heartZone;
      const isP1 = player.id === 1;

      ctx.fillStyle = isP1 ? COLORS.heartP1 : COLORS.heartP2;
      ctx.fillRect(hz.x * cs, hz.y * cs, hz.w * cs, hz.h * cs);

      ctx.strokeStyle = isP1 ? COLORS.heartBorderP1 : COLORS.heartBorderP2;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(hz.x * cs, hz.y * cs, hz.w * cs, hz.h * cs);
      ctx.setLineDash([]);

      const fontSize = Math.max(8, Math.floor(cs * 0.9));
      ctx.font = `700 ${fontSize}px 'Inter', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isP1 ? COLORS.p1 : COLORS.p2;
      ctx.globalAlpha = 0.6;
      ctx.fillText(
        `♥ ${player.heartHp}`,
        (hz.x + hz.w / 2) * cs,
        (hz.y + hz.h / 2) * cs,
      );
      ctx.globalAlpha = 1;
    }
  }

  private renderZoneLabels(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const layout = this.game.layout;
    const fontSize = Math.max(10, Math.floor(cs * 1.2));
    ctx.font = `600 ${fontSize}px 'Inter', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.25;

    const p1cx = (layout.p1Build.x + layout.p1Build.w / 2) * cs;
    const p1cy = (layout.p1Build.y + layout.p1Build.h / 2) * cs;
    ctx.fillStyle = COLORS.p1;
    ctx.fillText('P1 BUILD', p1cx, p1cy);

    const bfx = (layout.battlefield.x + layout.battlefield.w / 2) * cs;
    const bfy = (layout.battlefield.y + layout.battlefield.h / 2) * cs;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('BATTLEFIELD', bfx, bfy);

    const p2cx = (layout.p2Build.x + layout.p2Build.w / 2) * cs;
    const p2cy = (layout.p2Build.y + layout.p2Build.h / 2) * cs;
    ctx.fillStyle = COLORS.p2;
    ctx.fillText('P2 BUILD', p2cx, p2cy);

    ctx.globalAlpha = 1;
  }

  private renderPreviousRound(): void {
    if (!this.game.previousRoundGrid) return;
    if (this.game.visibility === 'visible') return;

    const grid = this.game.previousRoundGrid;
    const cs = this.cellSize;
    const ctx = this.ctx;

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const cell = grid.getCell(x, y);
        if (cell?.alive) {
          ctx.fillStyle = cell.owner === 'p1' ? COLORS.previousP1 : COLORS.previousP2;
          ctx.fillRect(x * cs, y * cs, cs, cs);
        }
      }
    }
  }

  private renderPreview(): void {
    const pattern = this.previewPattern!;
    const anchor = this.previewCell!;
    const cs = this.cellSize;
    const ctx = this.ctx;
    const layout = this.game.layout;
    const playerId = this.previewPlayerId;

    if (playerId === null) return;

    const zone = playerId === 1 ? layout.p1Build : layout.p2Build;

    let valid = true;
    const player = this.game.players[playerId - 1];
    let deadCount = 0;
    for (const [dx, dy] of pattern.cells) {
      const cx = anchor.x + dx;
      const cy = anchor.y + dy;
      if (cx < zone.x || cx >= zone.x + zone.w || cy < zone.y || cy >= zone.y + zone.h) {
        valid = false;
        break;
      }
      const cell = this.game.grid.getCell(cx, cy);
      if (cell?.alive) continue;
      deadCount++;
    }
    if (valid && (deadCount === 0 || player.movesLeft < deadCount)) {
      valid = false;
    }

    ctx.globalAlpha = 1;
    for (const [dx, dy] of pattern.cells) {
      const cx = anchor.x + dx;
      const cy = anchor.y + dy;
      const px = cx * cs;
      const py = cy * cs;

      if (!valid) {
        ctx.fillStyle = COLORS.ghostInvalid;
      } else if (playerId === 1) {
        ctx.fillStyle = COLORS.ghostValidP1;
      } else {
        ctx.fillStyle = COLORS.ghostValidP2;
      }
      ctx.fillRect(px, py, cs, cs);

      ctx.strokeStyle = valid ? 'rgba(255,255,255,0.15)' : 'rgba(220,60,60,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, cs - 1, cs - 1);
    }
  }
}
