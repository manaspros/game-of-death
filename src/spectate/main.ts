import type { Snapshot } from '../bench/snapshot';
import { INTRO } from '../bench/copy';
import { cellSizeFor, drawBoardAt } from './draw';

type BenchEvent = { type: string } & Record<string, unknown>;

const params = new URLSearchParams(location.search);
const feedUrl = params.get('feed') ?? `http://127.0.0.1:${params.get('port') ?? '8787'}/events`;

// Static deploys (e.g. Vercel) have no live bench to stream from: show a recorded match instead.
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (!isLocalHost && !params.has('feed')) {
  const log = '/api/tournaments/frontier-5r-2026-10-04/log/match-6-litellm-claude-opus-5-5-vs-litellm-gemini-3.1-pro.jsonl';
  location.replace(`/replay.html?log=${encodeURIComponent(log)}&play=1`);
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const canvas = el<HTMLCanvasElement>('board');
const box = el('board-box');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('No 2d context');

let lastSnapshot: Snapshot | null = null;
let lastEventAt = 0;
let connected = false;

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

function drawBoard(s: Snapshot): void {
  const cell = cellSizeFor(s, box.clientWidth - 16, box.clientHeight - 16);
  canvas.width = s.width * cell;
  canvas.height = s.height * cell;
  drawBoardAt(ctx!, s, 0, 0, cell);
}

function applySnapshot(s: Snapshot): void {
  lastSnapshot = s;
  drawBoard(s);
  setText('round', `Round ${s.round}`);
  const phase =
    s.phase === 'simulate' ? `simulating — gen ${s.generation}/${s.totalGenerations}` : s.phase === 'build' ? 'build phase' : s.phase;
  setText('phase', phase);
  el('progress').style.width = s.phase === 'simulate' ? `${(s.generation / s.totalGenerations) * 100}%` : '0';
  for (const [key, side] of [['p1', s.p1], ['p2', s.p2]] as const) {
    setText(`${key}-hp`, `${side.hp}/100`);
    el(`${key}-bar`).style.width = `${side.hp}%`;
    setText(`${key}-moves`, String(side.movesLeft));
  }
}

const logEl = el('log');
function addLog(text: string, cls = ''): void {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const row = document.createElement('div');
  row.className = cls;
  row.textContent = text;
  logEl.appendChild(row);
  while (logEl.childElementCount > 400) logEl.firstElementChild?.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function addAnalysis(text: string, notes?: string): void {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const box = document.createElement('details');
  box.className = 'analysis';
  const head = document.createElement('summary');
  head.textContent = 'analysis';
  const body = document.createElement('div');
  body.textContent = notes ? `${text}\n\nnotes for next call: ${notes}` : text;
  box.append(head, body);
  logEl.appendChild(box);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function describeAction(a: { action: string; anchor?: number[]; preset?: string; rotation?: number; cells?: unknown[]; name?: string }): string {
  if (a.action === 'submit') return 'submit turn';
  if (a.action === 'clear') { const r = (a as unknown as { region: { x: number; y: number; w: number; h: number } }).region; return `clear own cells in box (${r.x}, ${r.y}, ${r.w}x${r.h})`; }
  if (a.action === 'save_blueprint') return `save blueprint "${a.name}" (${a.cells?.length ?? 0} cells)`;
  const what = a.preset ? `${a.preset}${a.rotation ? ` ↻${a.rotation * 90}°` : ''}` : `custom (${a.cells?.length ?? 0} cells)`;
  return `place ${what} @ (${a.anchor?.join(', ')})`;
}

const overlay = el('overlay');
let overlayTimer: number | null = null;

function showOverlay(title: string, subtitle: string, lines: string[], accent: 'p1' | 'p2' | 'neutral' = 'neutral'): void {
  overlay.className = `overlay ${accent}`;
  overlay.innerHTML = '';
  const add = (tag: string, cls: string, text: string) => {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    overlay.appendChild(node);
  };
  add('div', 'ov-title', title);
  if (subtitle) add('div', 'ov-sub', subtitle);
  for (const line of lines) add('div', 'ov-line', line);
  overlay.hidden = false;
}

function hideOverlay(): void {
  if (overlayTimer !== null) window.clearInterval(overlayTimer);
  overlayTimer = null;
  overlay.hidden = true;
}

function showRoundBreak(e: BenchEvent): void {
  const pauseMs = Number(e.pauseMs ?? 0);
  const endsAt = Date.now() + pauseMs;
  const lines = [
    `Cells  P1 ${e.p1Cells} · P2 ${e.p2Cells}`,
    `Heart HP  P1 ${e.p1HeartHp} · P2 ${e.p2HeartHp}`,
  ];
  const render = () => {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    showOverlay(`ROUND ${e.round} COMPLETE`, `Next: round ${e.nextRound}${pauseMs > 0 ? ` starts in ${left}s` : ''}`, lines);
  };
  hideOverlay();
  if (pauseMs <= 0) return;
  render();
  overlayTimer = window.setInterval(render, 250);
}

function showRoundStart(e: BenchEvent): void {
  hideOverlay();
  showOverlay(`ROUND ${e.round}`, `of ${e.maxRounds}`, [`Heart HP  P1 ${e.p1HeartHp} · P2 ${e.p2HeartHp}`]);
  overlayTimer = window.setTimeout(hideOverlay, 2200) as unknown as number;
}

const waitingRows = new Map<number, HTMLElement>();
function setWaiting(playerId: number, text: string | null): void {
  const existing = waitingRows.get(playerId);
  if (text === null) {
    existing?.remove();
    waitingRows.delete(playerId);
    return;
  }
  const row = existing ?? document.createElement('div');
  if (!existing) {
    row.className = 'sys';
    logEl.appendChild(row);
    waitingRows.set(playerId, row);
  }
  row.textContent = text;
  logEl.scrollTop = logEl.scrollHeight;
}

function showIntro(): void {
  showOverlay(INTRO.title, INTRO.tagline, [...INTRO.steps.map((s, i) => `${i + 1}. ${s}`), '', 'Waiting for a match to start…']);
}

function handle(e: BenchEvent): void {
  lastEventAt = Date.now();
  if (e.type === 'reset') {
    logEl.textContent = '';
    showIntro();
    return;
  }
  if (e.type === 'match_start') hideOverlay();
  const pid = Number(e.playerId ?? 0);
  if (e.type === 'turn' || e.type === 'llm_error') setWaiting(pid, null);
  switch (e.type) {
    case 'attempt_failed':
      addLog(
        `P${pid} call #${e.callIndex} attempt ${e.attempt}/${e.maxAttempts} failed after ${Math.round((e.elapsedMs as number) / 1000)}s: ${e.reason}${e.willRetry ? ` — retrying in ${Math.round(((e.retryInMs as number) ?? 0) / 1000)}s` : ' — giving up'}`,
        'rej',
      );
      break;
    case 'call_waiting':
      setWaiting(pid, `… P${pid} call #${e.callIndex} still waiting on model (${Math.round((e.elapsedMs as number) / 1000)}s, attempt ${e.attempt})`);
      break;
    case 'snapshot':
      applySnapshot(e as unknown as Snapshot);
      break;
    case 'match_start':
      {
        const label = (p: unknown): string => {
          const x = p as { provider: string; modelId: string } | null;
          return x ? `${x.provider}/${x.modelId}` : 'baseline bot';
        };
        setText('p1-who', label(e.p1));
        setText('p2-who', label(e.p2));
        setText('preset', `preset: ${e.preset}`);
        addLog(`match start — P1 ${label(e.p1)} vs P2 ${label(e.p2)}`, 'sys');
      }
      break;
    case 'turn': {
      const r = e.applyResult as { ok: boolean; error?: string };
      const text = `R${e.round} P${pid} #${e.callIndex}${Number(e.batchSize) > 1 ? `.${Number(e.batchIndex) + 1}/${e.batchSize}` : ''}  ${describeAction(e.action as never)}  (${((e.latencyMs as number) / 1000).toFixed(1)}s)`;
      addLog(r.ok ? text : `${text}\n   ✗ ${r.error}`, r.ok ? 'ok' : 'rej');
      if (typeof e.rationale === 'string') addLog(`why: ${e.rationale}`, 'why');
      if (typeof e.analysis === 'string') addAnalysis(e.analysis, typeof e.notes === 'string' ? e.notes : undefined);
      break;
    }
    case 'llm_error':
      addLog(`P${pid} LLM error: ${e.error}`, 'rej');
      break;
    case 'llm_bad_response':
      addLog(`P${pid} unusable model response: ${e.error}`, 'rej');
      break;
    case 'match_error':
      addLog(`MATCH ERROR: ${e.reason}`, 'rej');
      showOverlay('MATCH ERROR', 'the harness hit an unexpected error', [String(e.reason ?? '').slice(0, 160)]);
      break;
    case 'match_invalid':
      addLog(`MATCH INVALID (P${pid}, round ${e.round}) — not scoreable: ${e.reason}`, 'rej');
      showOverlay('MATCH INVALID', 'not scoreable', [`Player ${pid}'s provider failed in round ${e.round}.`]);
      break;
    case 'auto_skip':
      addLog(`auto-skip after repeated illegal actions: ${e.reason}`, 'rej');
      break;
    case 'force_submit':
      addLog(`turn force-submitted (moves left ${e.movesLeft})`, 'sys');
      break;
    case 'simulation_start':
      addLog(`round ${e.round}: both committed, simulating…`, 'sys');
      break;
    case 'round_resolved':
      addLog(`round ${e.round} done — cells ${e.p1Cells}/${e.p2Cells}, heart HP ${e.p1HeartHp}/${e.p2HeartHp}`, 'round');
      break;
    case 'round_break':
      showRoundBreak(e);
      break;
    case 'round_start':
      showRoundStart(e);
      break;
    case 'match_end': {
      addLog(`MATCH OVER — winner: ${String(e.winner)}`, 'round');
      const w = e.winner;
      showOverlay('MATCH OVER', w === 1 || w === 2 ? `Player ${w} wins` : 'Draw', [`Heart HP  P1 ${e.p1HeartHp} · P2 ${e.p2HeartHp}`], w === 1 ? 'p1' : w === 2 ? 'p2' : 'neutral');
      break;
    }
  }
}

function connect(): void {
  const source = new EventSource(feedUrl);
  source.onopen = () => {
    connected = true;
    logEl.textContent = '';
  };
  source.onmessage = msg => handle(JSON.parse(msg.data) as BenchEvent);
  source.onerror = () => {
    connected = false;
  };
}

showIntro();

setInterval(() => {
  const status = el('status');
  status.className = connected ? 'status live' : 'status down';
  if (!connected) {
    status.textContent = `waiting for bench at ${feedUrl}`;
    return;
  }
  const idle = lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : 0;
  status.textContent = idle > 3 ? `live — waiting on model (${idle}s)` : 'live';
}, 500);

window.addEventListener('resize', () => lastSnapshot && drawBoard(lastSnapshot));
connect();
