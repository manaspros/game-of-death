import type { GameState } from '../game/state';
import type { RotatedPattern } from '../game/patterns';
import type { CanvasRenderer } from '../ui/canvas';

export class MouseInput {
  private canvas: HTMLCanvasElement;
  private game: GameState;
  private renderer: CanvasRenderer;
  private isDragging = false;
  private dragMode: 'place' | 'remove' = 'place';
  private lastDragCell: { x: number; y: number } | null = null;
  selectedPattern: RotatedPattern | null = null;
  selectedPlayerId: number | null = null;
  hoverCell: { x: number; y: number } | null = null;
  onCellToggle: ((x: number, y: number) => void) | null = null;
  onPatternStamp: ((playerId: number) => void) | null = null;
  onHover: ((cell: { x: number; y: number } | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, gameState: GameState, renderer: CanvasRenderer) {
    this.canvas = canvas;
    this.game = gameState;
    this.renderer = renderer;

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    window.addEventListener('mousemove', (e) => this.handleWindowMouseMove(e));
    window.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handleMouseDown(e: MouseEvent): void {
    if (!this.game.isBuildPhase) return;
    if (e.button !== 0 && e.button !== 2) return;

    const pos = this.renderer.cellAtPixel(e.clientX, e.clientY);
    if (!pos) return;

    if (this.selectedPattern && e.button === 0) {
      if (this.selectedPlayerId === null) return;
      const owner = this.game.getOwnerAtPosition(pos.x, pos.y);
      const ownerPlayerId = owner === 'p1' ? 1 : owner === 'p2' ? 2 : 0;
      if (ownerPlayerId !== this.selectedPlayerId) return;

      const stamped =
        this.selectedPattern.category === 'special'
          ? this.game.placeHeart(pos.x, pos.y, this.selectedPattern, this.selectedPlayerId)
          : this.game.stampPattern(pos.x, pos.y, this.selectedPattern, this.selectedPlayerId);
      if (stamped) {
        this.onPatternStamp?.(this.selectedPlayerId);
        this.onCellToggle?.(pos.x, pos.y);
      }
      return;
    }

    this.isDragging = true;
    this.lastDragCell = pos;

    const cell = this.game.grid.getCell(pos.x, pos.y);
    if (e.button === 0) {
      this.dragMode = cell?.alive ? 'remove' : 'place';
    } else {
      this.dragMode = 'remove';
    }

    this.applyDragCell(pos.x, pos.y);
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.isDragging) return;
    if (!this.game.isBuildPhase) return;

    const pos = this.renderer.cellAtPixel(e.clientX, e.clientY);
    if (!pos) {
      if (this.hoverCell) {
        this.hoverCell = null;
        this.onHover?.(null);
      }
      return;
    }
    if (this.hoverCell && pos.x === this.hoverCell.x && pos.y === this.hoverCell.y) return;

    this.hoverCell = pos;
    this.onHover?.(pos);
  }

  private handleWindowMouseMove(e: MouseEvent): void {
    if (!this.isDragging) return;
    if (!this.game.isBuildPhase) return;

    const pos = this.renderer.cellAtPixel(e.clientX, e.clientY);
    if (!pos) return;
    if (this.lastDragCell && pos.x === this.lastDragCell.x && pos.y === this.lastDragCell.y) return;

    this.lastDragCell = pos;
    this.applyDragCell(pos.x, pos.y);
  }

  private handleMouseLeave(): void {
    if (this.isDragging) return;
    if (this.hoverCell) {
      this.hoverCell = null;
      this.onHover?.(null);
    }
  }

  private handleMouseUp(_e: MouseEvent): void {
    this.isDragging = false;
    this.lastDragCell = null;
  }

  private applyDragCell(x: number, y: number): void {
    let changed = false;
    if (this.dragMode === 'place') {
      changed = this.game.placeCell(x, y);
    } else {
      changed = this.game.removeCell(x, y);
    }
    if (changed) this.onCellToggle?.(x, y);
  }
}
