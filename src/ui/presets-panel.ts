import { PATTERNS, rotatePattern, type Pattern, type RotatedPattern } from '../game/patterns';
import type { GameState } from '../game/state';

const CELL_PX = 7;

export class PresetsPanel {
  private container: HTMLElement;
  private playerId: number;
  private game: GameState;
  private buttons: HTMLElement[] = [];
  private rotations: Map<string, number> = new Map();
  selectedPattern: RotatedPattern | null = null;
  onPatternSelect: ((pattern: RotatedPattern | null) => void) | null = null;
  onPatternRotate: (() => void) | null = null;

  constructor(container: HTMLElement, playerId: number, gameState: GameState) {
    this.container = container;
    this.playerId = playerId;
    this.game = gameState;
    this.render();
  }

  private getRotation(name: string): number {
    return this.rotations.get(name) ?? 0;
  }

  rotateSelected(): void {
    if (!this.selectedPattern) return;
    if (this.selectedPattern.category === 'special') return;
    const base = PATTERNS.find(p => p.name === this.selectedPattern!.name);
    if (!base) return;
    const current = this.getRotation(base.name);
    this.rotations.set(base.name, (current + 1) % 4);
    this.selectedPattern = rotatePattern(base, this.getRotation(base.name));

    for (const btn of this.buttons) {
      if (btn.dataset.pattern === base.name) {
        this.renderThumbnail(btn, base);
      }
    }
    this.onPatternRotate?.();
  }

  private renderThumbnail(btn: HTMLElement, pattern: Pattern): void {
    btn.innerHTML = '';
    const rotation = this.getRotation(pattern.name);
    const rotated = rotatePattern(pattern, rotation);

    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'preset-thumb-row';

    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    grid.style.gridTemplateColumns = `repeat(${rotated.width}, ${CELL_PX}px)`;
    grid.style.gridTemplateRows = `repeat(${rotated.height}, ${CELL_PX}px)`;

    const aliveSet = new Set(rotated.cells.map(([x, y]) => `${x},${y}`));
    for (let y = 0; y < rotated.height; y++) {
      for (let x = 0; x < rotated.width; x++) {
        const cell = document.createElement('div');
        cell.className = aliveSet.has(`${x},${y}`) ? 'preset-cell alive' : 'preset-cell';
        grid.appendChild(cell);
      }
    }

    const rotateBtn = document.createElement('button');
    rotateBtn.className = 'preset-rotate-btn';
    rotateBtn.textContent = '\u21BB';
    rotateBtn.title = 'Rotate';
    rotateBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    rotateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pattern.category === 'special') return;
      const current = this.getRotation(pattern.name);
      this.rotations.set(pattern.name, (current + 1) % 4);
      this.renderThumbnail(btn, pattern);
      if (this.selectedPattern?.name === pattern.name) {
        this.selectedPattern = rotatePattern(pattern, this.getRotation(pattern.name));
        this.onPatternRotate?.();
      }
    });

    gridWrapper.appendChild(grid);
    if (pattern.category !== 'special') {
      gridWrapper.appendChild(rotateBtn);
    }

    const info = document.createElement('div');
    info.className = 'preset-info';
    const rotLabel = rotation > 0 && pattern.category !== 'special' ? ` ${rotation * 90}\u00B0` : '';
    info.innerHTML = `<span class="preset-name">${pattern.name}${rotLabel}</span><span class="preset-cost">${pattern.cells.length}</span>`;

    btn.appendChild(gridWrapper);
    btn.appendChild(info);
  }

  private render(): void {
    this.container.innerHTML = '';
    this.buttons = [];

    const player = this.game.players[this.playerId - 1];

    const label = document.createElement('div');
    label.className = 'presets-label';
    label.textContent = player.heartPlaced ? 'PRESETS' : 'PLACE YOUR HEART FIRST';
    this.container.appendChild(label);

    const hint = document.createElement('div');
    hint.className = 'presets-hint';
    hint.textContent = player.heartPlaced ? 'Click to select, R to rotate' : 'Select Heart then click on grid';
    this.container.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'presets-list';

    const patternsToShow = player.heartPlaced
      ? PATTERNS.filter(p => p.category !== 'special')
      : PATTERNS.filter(p => p.category === 'special');

    for (const pattern of patternsToShow) {
      const btn = document.createElement('div');
      btn.className = 'preset-thumb';
      btn.dataset.pattern = pattern.name;

      this.renderThumbnail(btn, pattern);

      btn.addEventListener('click', () => {
        if (this.selectedPattern?.name === pattern.name) {
          this.deselect();
          this.onPatternSelect?.(null);
        } else {
          const rotation = this.getRotation(pattern.name);
          this.selectedPattern = rotatePattern(pattern, rotation);
          for (const b of this.buttons) {
            b.classList.toggle('selected', b.dataset.pattern === pattern.name);
          }
          this.onPatternSelect?.(this.selectedPattern);
        }
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pattern.category === 'special') return;
        const current = this.getRotation(pattern.name);
        this.rotations.set(pattern.name, (current + 1) % 4);
        this.renderThumbnail(btn, pattern);
        if (this.selectedPattern?.name === pattern.name) {
          this.selectedPattern = rotatePattern(pattern, this.getRotation(pattern.name));
          this.onPatternRotate?.();
        }
      });

      list.appendChild(btn);
      this.buttons.push(btn);
    }

    this.container.appendChild(list);
  }

  deselect(): void {
    this.selectedPattern = null;
    for (const btn of this.buttons) {
      btn.classList.remove('selected');
    }
  }

  update(): void {
    const player = this.game.players[this.playerId - 1];
    if (!player) return;

    for (const btn of this.buttons) {
      const pattern = PATTERNS.find(p => p.name === btn.dataset.pattern);
      if (!pattern) continue;
      const canAfford = player.movesLeft >= pattern.cells.length;
      btn.classList.toggle('muted', !canAfford);
    }

    this.render();
  }
}
