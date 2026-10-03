import { INTRO } from '../bench/copy';

interface ModelInfo { key: string; provider: string; modelId: string; notes: string; hasKey: boolean }
interface PresetInfo { key: string; name: string; width: number; height: number; maxRounds: number; generationsPerRound: number; movesPerRound: number }
interface Config {
  models: ModelInfo[];
  presets: PresetInfo[];
  defaults: { preset: string; roundPauseSec: number };
  /** Absent when talking to an older server that has not been restarted yet. */
  limits?: { maxRounds: number };
}
interface MatchInfo {
  id: string; startedAt: number; preset: string; p1: string; p2: string;
  status: 'running' | 'finished' | 'invalid' | 'incomplete'; winner: string | null;
  rounds: number; p1HeartHp: number | null; p2HeartHp: number | null; hasVideo: boolean;
}
interface ExportState { state: 'none' | 'running' | 'done' | 'error'; done: number; total: number; error?: string }

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const p1Select = el<HTMLSelectElement>('p1');
const p2Select = el<HTMLSelectElement>('p2');
const presetSelect = el<HTMLSelectElement>('preset');
const roundsInput = el<HTMLInputElement>('rounds');
const pauseInput = el<HTMLInputElement>('pause');
const startBtn = el<HTMLButtonElement>('start');
const startMsg = el('start-msg');
const matchesBox = el('matches');
const stage = el<HTMLIFrameElement>('stage');
const stageTitle = el('stage-title');

let config: Config | null = null;
let matches: MatchInfo[] = [];
const exports = new Map<string, ExportState>();
const polling = new Set<string>();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function option(value: string, text: string, disabled = false): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  o.disabled = disabled;
  return o;
}

function fillModelSelect(select: HTMLSelectElement, includeBaseline: boolean): void {
  select.innerHTML = '';
  if (includeBaseline) select.appendChild(option('baseline', 'Baseline bot (scripted)'));
  for (const m of config?.models ?? []) {
    select.appendChild(option(m.key, `${m.modelId} · ${m.provider}${m.hasKey ? '' : ' (no API key)'}`, !m.hasKey));
  }
}

/** Picking an arena resets the rounds field to that arena's default; edit it afterwards to override. */
function applyPresetDefaults(): void {
  const p = config?.presets.find(x => x.key === presetSelect.value);
  if (p) roundsInput.value = String(p.maxRounds);
}

function showPresetInfo(): void {
  const p = config?.presets.find(x => x.key === presetSelect.value);
  el('preset-info').textContent = p
    ? `${p.width}×${p.height} · ${p.movesPerRound} moves · ${p.generationsPerRound} gens · default ${p.maxRounds} rounds`
    : '';
}

function setStage(src: string, title: string): void {
  stage.src = src;
  stageTitle.textContent = `Showing: ${title}`;
}

function shortName(label: string): string {
  return label.includes('/') ? label.split('/').slice(1).join('/') : label;
}

function resultText(m: MatchInfo): string {
  if (m.status === 'running') return 'in progress';
  if (m.status === 'invalid') return 'invalid (provider failed)';
  if (m.status === 'incomplete') return 'incomplete';
  const hp = m.p1HeartHp !== null ? ` · HP ${m.p1HeartHp}/${m.p2HeartHp}` : '';
  return m.winner === '1' ? `P1 wins${hp}` : m.winner === '2' ? `P2 wins${hp}` : `draw${hp}`;
}

async function pollExport(id: string): Promise<void> {
  if (polling.has(id)) return;
  polling.add(id);
  try {
    for (;;) {
      const s = await api<ExportState>(`/api/matches/${id}/export`);
      exports.set(id, s);
      render();
      if (s.state !== 'running') break;
      await new Promise(r => setTimeout(r, 1000));
    }
  } finally {
    polling.delete(id);
    await refreshMatches();
  }
}

async function startExport(id: string): Promise<void> {
  exports.set(id, { state: 'running', done: 0, total: 0 });
  render();
  try {
    await api(`/api/matches/${id}/export`, { method: 'POST' });
    void pollExport(id);
  } catch (err) {
    exports.set(id, { state: 'error', done: 0, total: 0, error: err instanceof Error ? err.message : String(err) });
    render();
  }
}

function button(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function render(): void {
  matchesBox.innerHTML = '';
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No matches yet. Start one above.';
    matchesBox.appendChild(empty);
    return;
  }

  for (const m of matches) {
    const box = document.createElement('div');
    box.className = 'match';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${shortName(m.p1)}  vs  ${shortName(m.p2)}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const chip = document.createElement('span');
    chip.className = `chip ${m.status}`;
    chip.textContent = m.status;
    meta.append(chip, ` ${m.preset} · ${new Date(m.startedAt).toLocaleString()} · ${resultText(m)}`);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (m.status === 'running') {
      actions.appendChild(button('Watch live', () => setStage('/spectate.html?feed=/api/live/events', 'Live view')));
    } else {
      actions.appendChild(
        button('Replay', () => setStage(`/replay.html?log=/api/matches/${m.id}/log&play=1`, `Replay · ${shortName(m.p1)} vs ${shortName(m.p2)}`)),
      );
      const job = exports.get(m.id);
      if (job?.state === 'running') {
        const bar = document.createElement('div');
        bar.className = 'bar';
        const fill = document.createElement('div');
        fill.style.width = job.total > 0 ? `${Math.round((job.done / job.total) * 100)}%` : '3%';
        bar.appendChild(fill);
        const pct = document.createElement('span');
        pct.className = 'muted';
        pct.textContent = job.total > 0 ? `Rendering ${Math.round((job.done / job.total) * 100)}%` : 'Starting…';
        actions.append(bar, pct);
      } else if (m.hasVideo || job?.state === 'done') {
        actions.appendChild(button('Play video', () => setStage(`/api/matches/${m.id}/video`, `Video · ${shortName(m.p1)} vs ${shortName(m.p2)}`)));
        const dl = document.createElement('a');
        dl.className = 'btn';
        dl.href = `/api/matches/${m.id}/video`;
        dl.download = `${m.id}.mp4`;
        dl.appendChild(button('Download MP4', () => undefined));
        actions.appendChild(dl);
        actions.appendChild(button('Re-export', () => void startExport(m.id)));
      } else {
        actions.appendChild(button('Export video', () => void startExport(m.id)));
      }
      if (job?.state === 'error') {
        const err = document.createElement('div');
        err.className = 'muted';
        err.style.color = 'var(--bad)';
        err.textContent = job.error ?? 'Export failed.';
        box.append(title, meta, actions, err);
        matchesBox.appendChild(box);
        continue;
      }
    }
    box.append(title, meta, actions);
    matchesBox.appendChild(box);
  }
}

async function refreshMatches(): Promise<void> {
  try {
    matches = (await api<{ matches: MatchInfo[] }>('/api/matches')).matches;
    startBtn.disabled = matches.some(m => m.status === 'running');
    if (startBtn.disabled) startBtn.textContent = 'A match is running…';
    else startBtn.textContent = 'Start match';
    render();
  } catch {
    /* server restarting; try again on the next tick */
  }
}

startBtn.addEventListener('click', async () => {
  startMsg.className = '';
  startMsg.textContent = 'Starting…';
  try {
    await api('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p1: p1Select.value,
        p2: p2Select.value,
        preset: presetSelect.value,
        maxRounds: Number(roundsInput.value),
        roundPauseSec: Number(pauseInput.value),
      }),
    });
    startMsg.className = 'ok';
    startMsg.textContent = 'Match started. Watch it live on the right.';
    setStage('/spectate.html?feed=/api/live/events', 'Live view');
    await refreshMatches();
  } catch (err) {
    startMsg.className = 'err';
    startMsg.textContent = err instanceof Error ? err.message : String(err);
  }
});

el('live-btn').addEventListener('click', () => setStage('/spectate.html?feed=/api/live/events', 'Live view'));
presetSelect.addEventListener('change', () => {
  applyPresetDefaults();
  showPresetInfo();
});

const WELCOMED_KEY = 'gameofdeath.welcomed';
const welcome = el('welcome');

function setupWelcome(): void {
  el('w-title').textContent = INTRO.title;
  el('w-tag').textContent = INTRO.tagline;
  const steps = el('w-steps');
  for (const text of INTRO.steps) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.appendChild(li);
  }
  const close = (): void => {
    welcome.hidden = true;
    try {
      localStorage.setItem(WELCOMED_KEY, '1');
    } catch {
      /* private mode: the intro just shows again next visit */
    }
  };
  el('w-go').addEventListener('click', close);
  el('how-btn').addEventListener('click', () => (welcome.hidden = false));
  let seen = false;
  try {
    seen = localStorage.getItem(WELCOMED_KEY) === '1';
  } catch {
    /* ignore */
  }
  welcome.hidden = seen;
}

async function init(): Promise<void> {
  setupWelcome();
  config = await api<Config>('/api/config');
  fillModelSelect(p1Select, false);
  fillModelSelect(p2Select, true);
  for (const p of config.presets) presetSelect.appendChild(option(p.key, p.name));
  presetSelect.value = config.defaults.preset;
  pauseInput.value = String(config.defaults.roundPauseSec);
  roundsInput.max = String(config.limits?.maxRounds ?? 30);
  applyPresetDefaults();
  const firstUsable = config.models.find(m => m.hasKey);
  if (firstUsable) p1Select.value = firstUsable.key;
  else {
    startMsg.className = 'err';
    startMsg.textContent = 'No model has an API key. Add one to .env and restart the studio.';
  }
  showPresetInfo();
  await refreshMatches();
  setInterval(() => void refreshMatches(), 3000);
}

init().catch(err => {
  startMsg.className = 'err';
  startMsg.textContent = `Could not reach the studio server: ${err instanceof Error ? err.message : String(err)}`;
});
