import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { latestLogPath } from '../logFiles';
import { buildTimeline, parseJsonl } from '../replay';

/**
 * Renders a finished match log to an MP4: the replay page draws each frame on
 * a canvas inside headless Chrome (driven over the DevTools protocol), the
 * frames are saved as PNGs, and ffmpeg stitches them with their durations.
 * No third-party dependencies.
 *
 *   npm run export-video -- [bench-logs/match-....jsonl] [--out video.mp4] [--fps 30] [--no-build]
 */

const WIDTH = 1280;
const HEIGHT = 720;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface ExportOptions {
  logPath: string;
  outPath: string;
  fps: number;
  build: boolean;
  onProgress?: (done: number, total: number) => void;
}

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome'];
  for (const dir of (process.env.PATH ?? '').split(':')) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Chrome/Chromium not found. Install it or set CHROME_PATH to its executable.');
}

function ensureFfmpeg(): void {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) throw new Error('ffmpeg not found on PATH. Install ffmpeg to export videos.');
}

function serve(distDir: string, logPath: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/__log') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(logPath));
      return;
    }
    const file = resolve(distDir, `.${url === '/' ? '/index.html' : url}`);
    if (!file.startsWith(resolve(distDir)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(resolvePort => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePort({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function launchChrome(userDataDir: string): Promise<{ proc: ChildProcess; debugPort: number }> {
  const proc = spawn(
    findChrome(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 20s.')), 20_000);
    let buffer = '';
    proc.stderr?.on('data', chunk => {
      buffer += String(chunk);
      const m = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolvePort({ proc, debugPort: Number(m[1]) });
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code}).`));
    });
  });
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

async function connectCdp(debugPort: number): Promise<Cdp> {
  const listRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = (await listRes.json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('Chrome has no page target to drive.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error('Could not connect to Chrome DevTools.'));
  });

  let nextId = 1;
  const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (msg.id === undefined) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.fail(new Error(msg.error.message));
    else waiter.ok(msg.result ?? {});
  };

  return {
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const res = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  if (res.exceptionDetails) {
    throw new Error(`Page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value as T;
}

/** Kill a child and wait until it has really exited, so its files are no longer being written. */
function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise(done => {
    if (proc.exitCode !== null || proc.signalCode !== null) return done();
    const timer = setTimeout(done, 4000);
    proc.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    proc.kill('SIGKILL');
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr?.on('data', c => (err += String(c)));
    proc.on('exit', code => (code === 0 ? ok() : fail(new Error(`ffmpeg failed (code ${code}): ${err.slice(-600)}`))));
  });
}

export async function exportVideo(opts: ExportOptions): Promise<{ outPath: string; seconds: number; frames: number }> {
  ensureFfmpeg();
  if (!existsSync(opts.logPath)) throw new Error(`Log not found: ${opts.logPath}`);

  const timeline = buildTimeline(parseJsonl(readFileSync(opts.logPath, 'utf8')));
  if (timeline.warnings.length > 0) {
    console.warn(`Replay differs from the log in ${timeline.warnings.length} place(s):`);
    timeline.warnings.slice(0, 5).forEach(w => console.warn(`  - ${w}`));
  }

  const distDir = resolve('dist');
  if (opts.build || !existsSync(join(distDir, 'replay.html'))) {
    console.log('Building the replay page...');
    const build = spawnSync(resolve('node_modules/.bin/vite'), ['build'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`vite build failed:\n${build.stdout}\n${build.stderr}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'gameofdeath-video-'));
  const framesDir = join(work, 'frames');
  mkdirSync(framesDir);
  const { server, port } = await serve(distDir, opts.logPath);
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;

  try {
    const launched = await launchChrome(join(work, 'profile'));
    chrome = launched.proc;
    cdp = await connectCdp(launched.debugPort);

    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/replay.html` });

    const deadline = Date.now() + 30_000;
    while (!(await evaluate<boolean>(cdp, 'Boolean(window.__replay && window.__replay.ready)'))) {
      if (Date.now() > deadline) {
        const text = await evaluate<string>(cdp, "document.getElementById('msg')?.textContent ?? ''");
        throw new Error(`Replay page did not become ready. ${text}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const frameCount = await evaluate<number>(cdp, 'window.__replay.frameCount');
    const durations = await evaluate<number[]>(cdp, 'window.__replay.durations');
    const sourceFps = await evaluate<number>(cdp, 'window.__replay.fps');
    console.log(`Rendering ${frameCount} frames (${(timeline.totalMs / 1000).toFixed(0)}s of video)...`);

    const listLines: string[] = [];
    for (let i = 0; i < frameCount; i++) {
      const dataUrl = await evaluate<string>(cdp, `window.__replay.frameDataUrl(${i})`);
      const name = `f${String(i).padStart(5, '0')}.png`;
      writeFileSync(join(framesDir, name), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      // Whole output frames only, so playback cadence is perfectly even.
      const outputFrames = Math.max(1, Math.round((durations[i] / 1000) * sourceFps));
      listLines.push(`file '${name}'`, `duration ${(outputFrames / sourceFps).toFixed(6)}`);
      if (i % 25 === 0 || i === frameCount - 1) opts.onProgress?.(i + 1, frameCount);
    }
    listLines.push(`file 'f${String(frameCount - 1).padStart(5, '0')}.png'`);
    writeFileSync(join(framesDir, 'list.txt'), listLines.join('\n'));

    mkdirSync(resolve(opts.outPath, '..'), { recursive: true });
    console.log('Encoding with ffmpeg...');
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', join(framesDir, 'list.txt'),
      '-vf', `fps=${opts.fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', String(opts.fps),
      '-movflags', '+faststart',
      opts.outPath,
    ]);
    return { outPath: opts.outPath, seconds: timeline.totalMs / 1000, frames: frameCount };
  } finally {
    cdp?.close();
    if (chrome) await stopProcess(chrome);
    server.close();
    // Best effort: a leftover temp folder must never turn a finished export into a failure.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      /* the OS temp cleaner will get it */
    }
  }
}

function parseArgs(argv: string[]): ExportOptions {
  const positional: string[] = [];
  let out: string | undefined;
  let fps = 30;
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--fps') fps = Number(argv[++i]);
    else if (a === '--no-build') build = false;
    else positional.push(a);
  }
  const logPath = positional[0] ?? latestLogPath();
  return {
    logPath,
    outPath: out ?? join('videos', `${basename(logPath, '.jsonl')}.mp4`),
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    build,
    onProgress: (done, total) => console.log(`PROGRESS ${done}/${total}`),
  };
}

if (require.main === module) {
  exportVideo(parseArgs(process.argv.slice(2)))
    .then(r => console.log(`DONE ${r.outPath} (${r.seconds.toFixed(0)}s, ${r.frames} frames)`))
    .catch(err => {
      console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
