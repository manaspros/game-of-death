import './style.css';
import { GameState, PHASE } from './game/state';
import type { SimSpeed, VisibilityMode } from './engine/types';
import type { RotatedPattern } from './game/patterns';
import { CanvasRenderer } from './ui/canvas';
import { Controls } from './ui/controls';
import { HUD } from './ui/hud';
import { MouseInput } from './input/mouse';
import { PresetsPanel } from './ui/presets-panel';

const SPEEDS: Record<SimSpeed, number> = {
  fast: 16,
  normal: 50,
  slow: 150,
};

class Game {
  private gameState: GameState;
  private canvas: HTMLCanvasElement;
  private renderer: CanvasRenderer;
  private controls: Controls;
  private hud: HUD;
  private input: MouseInput;
  private presetsP1: PresetsPanel;
  private presetsP2: PresetsPanel;
  private simInterval: number | null = null;
  private simSpeed = SPEEDS.normal;

  constructor() {
    this.gameState = new GameState('standard');
    const canvas = document.getElementById('grid-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing #grid-canvas');
    this.canvas = canvas;
    this.renderer = new CanvasRenderer(this.canvas, this.gameState);
    this.controls = new Controls(this.gameState);
    this.hud = new HUD(this.gameState);
    this.input = new MouseInput(this.canvas, this.gameState, this.renderer);

    const p1Container = document.getElementById('p1-presets');
    const p2Container = document.getElementById('p2-presets');
    if (!p1Container || !p2Container) throw new Error('Missing preset containers');
    this.presetsP1 = new PresetsPanel(p1Container, 1, this.gameState);
    this.presetsP2 = new PresetsPanel(p2Container, 2, this.gameState);

    this.setupCallbacks();
    this.setupSettings();
    this.updatePresets();
    this.renderer.render();
  }

  private updatePreview(): void {
    const activeP1 = this.presetsP1.selectedPattern;
    const activeP2 = this.presetsP2.selectedPattern;
    const active = activeP1 ?? activeP2;

    this.renderer.previewPattern = active;
    this.renderer.previewCell = this.input.hoverCell;

    if (activeP1) {
      this.renderer.previewPlayerId = 1;
    } else if (activeP2) {
      this.renderer.previewPlayerId = 2;
    } else {
      this.renderer.previewPlayerId = null;
    }

    this.renderer.render();
  }

  private setupCallbacks(): void {
    this.input.onCellToggle = () => {
      this.hud.update();
      this.updatePresets();
      this.updatePreview();
    };

    this.input.onPatternStamp = (playerId: number) => {
      if (this.gameState.players[playerId - 1].heartPlaced && this.input.selectedPattern?.category === 'special') {
        this.presetsP1.deselect();
        this.presetsP2.deselect();
        this.input.selectedPattern = null;
        this.input.selectedPlayerId = null;
      }
      this.hud.update();
      this.updatePresets();
      this.updatePreview();
    };

    this.input.onHover = () => {
      this.updatePreview();
    };

    this.presetsP1.onPatternSelect = (pattern: RotatedPattern | null) => {
      this.presetsP2.deselect();
      this.input.selectedPattern = pattern;
      this.input.selectedPlayerId = pattern ? 1 : null;
      this.updatePreview();
    };

    this.presetsP2.onPatternSelect = (pattern: RotatedPattern | null) => {
      this.presetsP1.deselect();
      this.input.selectedPattern = pattern;
      this.input.selectedPlayerId = pattern ? 2 : null;
      this.updatePreview();
    };

    const onRotate = () => {
      const activeP1 = this.presetsP1.selectedPattern;
      const activeP2 = this.presetsP2.selectedPattern;
      this.input.selectedPattern = activeP1 ?? activeP2;
      this.input.selectedPlayerId = activeP1 ? 1 : activeP2 ? 2 : null;
      this.updatePreview();
    };
    this.presetsP1.onPatternRotate = onRotate;
    this.presetsP2.onPatternRotate = onRotate;

    this.controls.onSubmit = () => {
      this.hud.update();
      this.updatePresets();
    };

    this.controls.onStart = () => {
      this.startSimulation();
    };

    this.controls.onSkip = () => {
      this.skipSimulation();
    };

    this.controls.onNextRound = () => {
      this.hud.update();
      this.updatePresets();
      this.renderer.render();
      this.controls.update();
    };

    this.controls.onNewGame = () => {
      this.newGame();
    };

    document.getElementById('btn-play-again')?.addEventListener('click', () => {
      this.newGame();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.presetsP1.deselect();
        this.presetsP2.deselect();
        this.input.selectedPattern = null;
        this.input.selectedPlayerId = null;
        this.updatePreview();
      }
      if (e.key === 'r' || e.key === 'R') {
        this.presetsP1.rotateSelected();
        this.presetsP2.rotateSelected();
        const activeP1 = this.presetsP1.selectedPattern;
        const activeP2 = this.presetsP2.selectedPattern;
        this.input.selectedPattern = activeP1 ?? activeP2;
        this.input.selectedPlayerId = activeP1 ? 1 : activeP2 ? 2 : null;
        this.updatePreview();
      }
    });
  }

  private setupSettings(): void {
    const presetSelect = document.getElementById('preset-select');
    const speedSelect = document.getElementById('sim-speed');
    const visSelect = document.getElementById('visibility-mode');
    if (
      !(presetSelect instanceof HTMLSelectElement) ||
      !(speedSelect instanceof HTMLSelectElement) ||
      !(visSelect instanceof HTMLSelectElement)
    ) {
      throw new Error('Missing settings selects');
    }

    presetSelect.addEventListener('change', () => {
      if (this.gameState.phase === PHASE.BUILD && this.gameState.round === 1) {
        this.newGame(presetSelect.value);
      }
    });

    speedSelect.addEventListener('change', () => {
      this.simSpeed = SPEEDS[speedSelect.value as SimSpeed] ?? SPEEDS.normal;
      if (this.simInterval !== null) {
        window.clearInterval(this.simInterval);
        this.startSimInterval();
      }
    });

    visSelect.addEventListener('change', () => {
      this.gameState.visibility = visSelect.value as VisibilityMode;
      this.renderer.render();
    });
  }

  private updatePresets(): void {
    this.presetsP1.update();
    this.presetsP2.update();
  }

  private startSimulation(): void {
    const sim = this.gameState.startSimulation();
    if (!sim) return;

    this.input.selectedPattern = null;
    this.input.selectedPlayerId = null;
    this.renderer.previewPattern = null;
    this.renderer.previewPlayerId = null;

    this.hud.showSimulation();
    this.renderer.render();
    this.hud.update();
    this.controls.update();
    this.startSimInterval();
  }

  private startSimInterval(): void {
    this.simInterval = window.setInterval(() => {
      const result = this.gameState.advanceSimulation();
      if (!result) {
        this.finishSimulation();
        return;
      }

      this.hud.updateSimulation(result.generation, result.total);
      this.renderer.render();

      if (result.done) {
        this.finishSimulation();
      }
    }, this.simSpeed);
  }

  private skipSimulation(): void {
    if (this.simInterval === null) return;
    window.clearInterval(this.simInterval);
    this.simInterval = null;

    while (
      this.gameState.simulation &&
      this.gameState.simulation.generation < this.gameState.preset.generationsPerRound
    ) {
      this.gameState.advanceSimulation();
    }

    this.finishSimulation();
  }

  private finishSimulation(): void {
    if (this.simInterval !== null) {
      window.clearInterval(this.simInterval);
      this.simInterval = null;
    }

    const result = this.gameState.resolve();
    this.hud.hideSimulation();
    this.renderer.render();
    this.hud.update();
    this.controls.update();

    if (result.isGameOver) {
      this.hud.showGameOver(
        result.winner,
        result.p1Cells,
        result.p2Cells,
        result.p1Total,
        result.p2Total,
        result.p1Cumulative,
        result.p2Cumulative,
        result.p1HeartHp,
        result.p2HeartHp,
      );
    }
  }

  private newGame(presetName?: string): void {
    if (this.simInterval !== null) {
      window.clearInterval(this.simInterval);
      this.simInterval = null;
    }
    const presetSelect = document.getElementById('preset-select');
    const preset = presetName ?? (presetSelect instanceof HTMLSelectElement ? presetSelect.value : 'standard');
    this.gameState.reset(preset);
    this.hud.hideGameOver();
    this.hud.update();
    this.updatePresets();
    this.renderer.resize();
    this.renderer.render();
    this.controls.update();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const game = new Game();
  (window as unknown as { __game: Game }).__game = game;
});
