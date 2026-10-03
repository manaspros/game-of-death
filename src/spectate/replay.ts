import { buildTimeline, parseJsonl, type CardData, type Caption, type ReplayFrame, type Timeline } from '../bench/replay';
import { COLORS, cellSizeFor, drawBoardAt } from './draw';

/**
 * Deterministic 1280x720 canvas renderer for a finished match. The video
 * exporter drives it frame by frame through `window.__replay`; open it with
 * ?play=1 to watch it in real time in a browser.
 */

const W = 1280;
const H = 720;
// Two bundled pixel fonts: a blocky one for labels/titles, a pixel-sans for reading text.
const HEAD = '"PressStart", monospace';
const BODY = '"PixelBody", monospace';

const params = new URLSearchParams(location.search);
const logUrl = params.get('log') ?? '/__log';
const stage = document.getElementById('stage') as HTMLCanvasElement;
const msg = document.getElementById('msg') as HTMLElement;
const ctx = stage.getContext('2d') as CanvasRenderingContext2D;

let timeline: Timeline;

async function loadFonts(): Promise<void> {
  const press = new FontFace('PressStart', `url(${new URL('../../assets/fonts/PressStart2P.woff2', import.meta.url).href})`);
  const pixel = new FontFace('PixelBody', `url(${new URL('../../assets/fonts/VT323.woff2', import.meta.url).href})`);
  const faces = await Promise.all([press.load(), pixel.load()]);
  faces.forEach(f => document.fonts.add(f));
}

function roundRect(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Largest size (stepping down by `step`) at which `text` fits in `maxWidth`. */
function fitPx(text: string, maxWidth: number, font: (px: number) => string, startPx: number, minPx: number, step: number): number {
  let px = startPx;
  ctx.font = font(px);
  while (px > minPx && ctx.measureText(text).width > maxWidth) {
    px -= step;
    ctx.font = font(px);
  }
  return px;
}

function ellipsize(text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function wrap(text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width <= maxWidth || !line) {
      line = trial;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxWidth);
    return kept;
  }
  return lines;
}

function drawPlayerCard(y: number, id: 1 | 2, frame: ReplayFrame): void {
  const side = id === 1 ? frame.snapshot.p1 : frame.snapshot.p2;
  const label = timeline.players[id - 1];
  const accent = id === 1 ? COLORS.p1 : COLORS.p2;
  const x = 836;
  const w = 416;
  roundRect(x, y, w, 140, 8, '#0f0f16', '#1e1e2a');

  ctx.fillStyle = accent;
  ctx.font = `10px ${HEAD}`;
  ctx.fillText(`PLAYER ${id}`, x + 18, y + 28);

  ctx.fillStyle = '#e8e8ed';
  ctx.font = `28px ${BODY}`;
  ctx.fillText(ellipsize(label.name, w - 36), x + 18, y + 58);
  ctx.fillStyle = '#7d7d95';
  ctx.font = `20px ${BODY}`;
  ctx.fillText(label.provider, x + 18, y + 78);

  roundRect(x + 18, y + 88, w - 36, 12, 3, '#16161f');
  const pct = Math.max(0, Math.min(1, side.hp / 100));
  if (pct > 0) roundRect(x + 18, y + 88, (w - 36) * pct, 12, 3, accent);
  ctx.fillStyle = '#e8e8ed';
  ctx.font = `10px ${HEAD}`;
  ctx.fillText(`HEART ${side.hp}/100`, x + 18, y + 124);
  ctx.fillStyle = '#7d7d95';
  ctx.textAlign = 'right';
  ctx.fillText(side.committed ? 'READY' : `${side.movesLeft} MOVES`, x + w - 18, y + 124);
  ctx.textAlign = 'left';
}

function drawCaptions(captions: Caption[] | undefined, headline: string): void {
  roundRect(28, 618, 1224, 86, 8, '#0f0f16', '#1e1e2a');
  if (!captions || captions.length === 0) {
    ctx.fillStyle = '#7d7d95';
    ctx.font = `10px ${HEAD}`;
    ctx.fillText(headline.toUpperCase(), 48, 666);
    return;
  }
  const single = captions.length === 1;
  const rowHeight = single ? 86 : 43;
  captions.forEach((caption, i) => {
    const top = 618 + i * rowHeight;
    const accent = caption.playerId === 1 ? COLORS.p1 : COLORS.p2;
    const rejected = caption.status === 'rejected';

    ctx.fillStyle = accent;
    ctx.fillRect(46, top + (single ? 16 : 8), 10, 10);

    ctx.fillStyle = rejected ? '#ff6b6b' : '#e8e8ed';
    ctx.font = `${single ? 28 : 24}px ${BODY}`;
    const head = `${caption.who}  ·  ${caption.action}${rejected ? `  —  rejected: ${caption.detail ?? ''}` : ''}`;
    ctx.fillText(ellipsize(head, 1130), 68, top + (single ? 28 : 21));

    const text = caption.rationale ?? (caption.status === 'bot' ? 'scripted move' : '');
    if (text) {
      ctx.fillStyle = '#8a8aa2';
      ctx.font = `${single ? 22 : 20}px ${BODY}`;
      if (single) wrap(text, 1150, 2).forEach((line, n) => ctx.fillText(line, 68, top + 52 + n * 22));
      else ctx.fillText(ellipsize(text, 1150), 68, top + 39);
    }
  });
}

function drawScene(frame: ReplayFrame): void {
  ctx.fillStyle = '#08080d';
  ctx.fillRect(0, 0, W, H);

  const snap = frame.snapshot;

  ctx.fillStyle = '#e8e8ed';
  ctx.font = `16px ${HEAD}`;
  ctx.fillText('GAMEOFDEATH', 28, 40);
  ctx.fillStyle = '#7d7d95';
  ctx.font = `10px ${HEAD}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${timeline.preset.toUpperCase()}  ·  ROUND ${snap.round}/${timeline.maxRounds}`, W - 28, 38);
  ctx.textAlign = 'left';

  roundRect(28, 64, 780, 540, 8, '#0f0f16', '#1e1e2a');
  const cell = cellSizeFor(snap, 760, 520);
  const ox = 28 + (780 - snap.width * cell) / 2;
  const oy = 64 + (540 - snap.height * cell) / 2;
  drawBoardAt(ctx, snap, ox, oy, cell);

  if (frame.kind === 'board' && frame.fresh) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    for (let i = 0; i < frame.fresh.length; i += 2) {
      ctx.strokeRect(ox + frame.fresh[i] * cell - 1, oy + frame.fresh[i + 1] * cell - 1, cell + 1, cell + 1);
    }
  }

  drawPlayerCard(72, 1, frame);
  drawPlayerCard(224, 2, frame);

  roundRect(836, 376, 416, 228, 8, '#0f0f16', '#1e1e2a');
  ctx.fillStyle = '#7d7d95';
  ctx.font = `10px ${HEAD}`;
  ctx.fillText('PHASE', 854, 406);
  ctx.fillStyle = '#e8e8ed';
  ctx.font = `32px ${BODY}`;
  const phaseText =
    snap.phase === 'simulate' ? 'Simulating' : snap.phase === 'build' ? 'Build phase' : snap.phase === 'gameover' ? 'Game over' : 'Round resolved';
  ctx.fillText(phaseText, 854, 440);
  if (snap.phase === 'simulate') {
    roundRect(854, 462, 380, 10, 3, '#16161f');
    roundRect(854, 462, 380 * (snap.generation / snap.totalGenerations), 10, 3, '#8a8aa2');
    ctx.fillStyle = '#7d7d95';
    ctx.font = `10px ${HEAD}`;
    ctx.fillText(`GEN ${snap.generation}/${snap.totalGenerations}`, 854, 498);
  } else {
    ctx.fillStyle = '#7d7d95';
    ctx.font = `10px ${HEAD}`;
    ctx.fillText(`${snap.cells.length / 3} LIVE CELLS`, 854, 470);
  }

  const headline =
    frame.kind === 'board' ? frame.headline : frame.kind === 'analysis' ? `Round ${snap.round} · ${frame.who} is thinking…` : '';
  drawCaptions(frame.kind === 'board' ? frame.captions : undefined, headline);
}

function drawAnalysis(frame: Extract<ReplayFrame, { kind: 'analysis' }>): void {
  roundRect(28, 64, 780, 540, 8, 'rgba(8,8,13,0.95)', '#2a2a3a');
  const accent = frame.playerId === 1 ? COLORS.p1 : COLORS.p2;

  ctx.fillStyle = accent;
  ctx.fillRect(52, 94, 12, 12);
  ctx.font = `10px ${HEAD}`;
  ctx.fillText(`PLAYER ${frame.playerId} · ANALYSIS`, 76, 104);

  ctx.fillStyle = '#e8e8ed';
  ctx.font = `28px ${BODY}`;
  ctx.fillText(ellipsize(frame.who, 720), 52, 146);

  ctx.fillStyle = '#9a9ab2';
  ctx.font = `22px ${BODY}`;
  wrap(frame.text, 730, 16).forEach((line, i) => ctx.fillText(line, 52, 190 + i * 25));
}

function drawCard(card: CardData, alpha: number): void {
  ctx.fillStyle = `rgba(8,8,13,${0.96 * alpha})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = alpha;

  const accent = card.accent === 'p1' ? COLORS.p1 : card.accent === 'p2' ? COLORS.p2 : '#e8e8ed';
  ctx.textAlign = 'center';

  // Vertical centring: measure the block first, then draw it.
  const titlePx = fitPx(card.title, 1100, px => `${px}px ${HEAD}`, 56, 16, 8);
  const subPx = card.subtitle ? fitPx(card.subtitle, 1100, px => `${px}px ${BODY}`, 40, 20, 2) : 0;
  const bodyLines: string[] = [];
  ctx.font = `30px ${BODY}`;
  card.lines.forEach((line, i) => {
    if (line === '') bodyLines.push('');
    else wrap(card.title === 'HOW IT WORKS' ? `${i + 1}.  ${line}` : line, 1040, 2).forEach(l => bodyLines.push(l));
  });
  const bodyHeight = bodyLines.reduce((h, l) => h + (l === '' ? 16 : 40), 0);
  const total = titlePx + (subPx ? subPx + 30 : 0) + (bodyLines.length ? 46 + bodyHeight : 0);
  let y = (H - total) / 2 + titlePx;

  ctx.fillStyle = accent;
  ctx.font = `${titlePx}px ${HEAD}`;
  ctx.fillText(card.title, W / 2, y);

  if (card.subtitle) {
    y += 30 + subPx;
    ctx.fillStyle = '#aaaac0';
    ctx.font = `${subPx}px ${BODY}`;
    ctx.fillText(card.subtitle, W / 2, y);
  }

  if (bodyLines.length) {
    y += 46;
    ctx.fillStyle = '#8a8aa2';
    ctx.font = `30px ${BODY}`;
    for (const line of bodyLines) {
      if (line === '') {
        y += 16;
        continue;
      }
      ctx.fillText(line, W / 2, y);
      y += 40;
    }
  }

  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

function draw(i: number): void {
  const frame = timeline.frames[i];
  drawScene(frame);
  if (frame.kind === 'card') drawCard(frame.card, frame.alpha);
  else if (frame.kind === 'analysis') drawAnalysis(frame);
}

async function start(): Promise<void> {
  await loadFonts();
  const res = await fetch(logUrl);
  if (!res.ok) throw new Error(`Could not load log (${res.status}) from ${logUrl}`);
  timeline = buildTimeline(parseJsonl(await res.text()));
  stage.hidden = false;
  msg.hidden = true;

  (window as unknown as Record<string, unknown>).__replay = {
    ready: true,
    frameCount: timeline.frames.length,
    durations: timeline.frames.map(f => f.durationMs),
    fps: timeline.fps,
    warnings: timeline.warnings,
    totalMs: timeline.totalMs,
    width: W,
    height: H,
    draw,
    frameDataUrl: (i: number) => {
      draw(i);
      return stage.toDataURL('image/png');
    },
  };

  draw(0);
  if (params.get('play') === '1') {
    let i = 0;
    const next = (): void => {
      draw(i);
      const wait = timeline.frames[i].durationMs;
      i = (i + 1) % timeline.frames.length;
      window.setTimeout(next, wait);
    };
    next();
  }
}

start().catch(err => {
  msg.hidden = false;
  stage.hidden = true;
  msg.textContent = `Replay failed: ${err instanceof Error ? err.message : String(err)}`;
});
