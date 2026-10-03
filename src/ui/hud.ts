import { PHASE, type GameState, type Winner } from '../game/state';

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export class HUD {
  private game: GameState;
  private roundDisplay: HTMLElement;
  private phaseDisplay: HTMLElement;
  private p1Moves: HTMLElement;
  private p2Moves: HTMLElement;
  private p1Hp: HTMLElement;
  private p2Hp: HTMLElement;
  private simBar: HTMLElement;
  private simProgressBar: HTMLElement;
  private simGenDisplay: HTMLElement;

  constructor(gameState: GameState) {
    this.game = gameState;
    this.roundDisplay = getEl('round-display');
    this.phaseDisplay = getEl('phase-display');
    this.p1Moves = getEl('p1-moves');
    this.p2Moves = getEl('p2-moves');
    this.p1Hp = getEl('p1-hp');
    this.p2Hp = getEl('p2-hp');
    this.simBar = getEl('simulation-bar');
    this.simProgressBar = getEl('sim-progress-bar');
    this.simGenDisplay = getEl('sim-gen-display');

    this.update();
  }

  update(): void {
    const g = this.game;
    this.roundDisplay.textContent = `Round ${g.round}/${g.maxRounds}`;
    this.phaseDisplay.textContent = this.getPhaseText();
    this.phaseDisplay.className = this.getPhaseClass();

    this.p1Moves.textContent = String(g.players[0].movesLeft);
    this.p2Moves.textContent = String(g.players[1].movesLeft);

    this.p1Hp.textContent = `${g.players[0].heartHp}`;
    this.p2Hp.textContent = `${g.players[1].heartHp}`;

    this.p1Hp.style.color = g.players[0].heartHp <= 25 ? 'var(--p2)' : '';
    this.p2Hp.style.color = g.players[1].heartHp <= 25 ? 'var(--p1)' : '';
  }

  private getPhaseText(): string {
    switch (this.game.phase) {
      case PHASE.BUILD:
        return 'BUILD PHASE';
      case PHASE.SIMULATE:
        return 'SIMULATING';
      case PHASE.RESOLVE:
        return 'RESOLVED';
      case PHASE.GAMEOVER:
        return 'GAME OVER';
    }
  }

  private getPhaseClass(): string {
    switch (this.game.phase) {
      case PHASE.SIMULATE:
        return 'simulating';
      case PHASE.RESOLVE:
        return 'resolve';
      case PHASE.GAMEOVER:
        return 'gameover';
      default:
        return '';
    }
  }

  showSimulation(): void {
    this.simBar.classList.remove('hidden');
  }

  hideSimulation(): void {
    this.simBar.classList.add('hidden');
  }

  updateSimulation(generation: number, total: number): void {
    const pct = (generation / total) * 100;
    this.simProgressBar.style.width = `${pct}%`;
    this.simGenDisplay.textContent = `Gen ${generation}/${total}`;
  }

  showGameOver(
    winner: Winner,
    _p1Score: number,
    _p2Score: number,
    p1Total: number,
    p2Total: number,
    _p1Cumulative: number,
    _p2Cumulative: number,
    p1HeartHp: number,
    p2HeartHp: number,
  ): void {
    const modal = getEl('game-over-modal');
    const winnerText = getEl('winner-text');
    const stats = getEl('final-stats');

    if (winner === 'draw') {
      winnerText.textContent = "It's a Draw!";
      winnerText.style.color = 'var(--text-primary)';
    } else {
      winnerText.textContent = `Player ${winner} Wins!`;
      winnerText.style.color = winner === 1 ? 'var(--p1)' : 'var(--p2)';
    }

    stats.innerHTML = `
      <div>Player 1 — Heart: <strong style="color:var(--p1)">${p1HeartHp}</strong> HP</div>
      <div>Player 2 — Heart: <strong style="color:var(--p2)">${p2HeartHp}</strong> HP</div>
      <div style="margin-top:8px;opacity:0.5;font-size:0.7rem">Cells — P1: ${p1Total} | P2: ${p2Total}</div>
    `;

    modal.classList.remove('hidden');
  }

  hideGameOver(): void {
    getEl('game-over-modal').classList.add('hidden');
  }
}
