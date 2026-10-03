import { PHASE, type GameState } from '../game/state';

function getButton(id: string): HTMLButtonElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`Missing button #${id}`);
  return el;
}

export class Controls {
  private game: GameState;
  onSubmit: ((playerId: number) => void) | null = null;
  onStart: (() => void) | null = null;
  onSkip: (() => void) | null = null;
  onNextRound: (() => void) | null = null;
  onNewGame: (() => void) | null = null;

  private btnP1Submit: HTMLButtonElement;
  private btnP2Submit: HTMLButtonElement;
  private btnStart: HTMLButtonElement;
  private btnSkip: HTMLButtonElement;
  private btnNextRound: HTMLButtonElement;
  private btnNewGame: HTMLButtonElement;

  constructor(gameState: GameState) {
    this.game = gameState;

    this.btnP1Submit = getButton('btn-p1-submit');
    this.btnP2Submit = getButton('btn-p2-submit');
    this.btnStart = getButton('btn-start');
    this.btnSkip = getButton('btn-skip');
    this.btnNextRound = getButton('btn-next-round');
    this.btnNewGame = getButton('btn-new-game');

    this.btnP1Submit.addEventListener('click', () => this.handleSubmit(1));
    this.btnP2Submit.addEventListener('click', () => this.handleSubmit(2));
    this.btnStart.addEventListener('click', () => this.handleStart());
    this.btnSkip.addEventListener('click', () => this.handleSkip());
    this.btnNextRound.addEventListener('click', () => this.handleNextRound());
    this.btnNewGame.addEventListener('click', () => this.handleNewGame());

    this.update();
  }

  private handleSubmit(playerId: number): void {
    if (this.game.submitBuild(playerId)) {
      this.onSubmit?.(playerId);
    }
    this.update();
  }

  private handleStart(): void {
    if (this.game.bothCommitted) {
      this.onStart?.();
    }
    this.update();
  }

  private handleSkip(): void {
    this.onSkip?.();
  }

  private handleNextRound(): void {
    if (this.game.nextRound()) {
      this.onNextRound?.();
    }
    this.update();
  }

  private handleNewGame(): void {
    this.onNewGame?.();
  }

  update(): void {
    const g = this.game;
    const p1 = g.players[0];
    const p2 = g.players[1];

    this.btnP1Submit.disabled = p1.committed || g.phase !== PHASE.BUILD;
    this.btnP2Submit.disabled = p2.committed || g.phase !== PHASE.BUILD;

    this.btnP1Submit.classList.toggle('committed', p1.committed);
    this.btnP1Submit.textContent = p1.committed ? 'Player 1 ✓' : 'Player 1 Submit';
    this.btnP2Submit.classList.toggle('committed', p2.committed);
    this.btnP2Submit.textContent = p2.committed ? 'Player 2 ✓' : 'Player 2 Submit';

    this.btnStart.disabled = !g.bothCommitted || g.phase !== PHASE.BUILD;
    this.btnStart.classList.toggle('hidden', g.phase !== PHASE.BUILD || !g.bothCommitted);
    this.btnSkip.classList.toggle('hidden', g.phase !== PHASE.SIMULATE);
    this.btnNextRound.classList.toggle('hidden', g.phase !== PHASE.RESOLVE);
    this.btnNewGame.classList.toggle('hidden', g.phase !== PHASE.GAMEOVER);
  }
}
