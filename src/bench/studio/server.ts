import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { PRESETS } from '../../game/presets';
import { API_KEY_ENV, createClient, getModelEntry, MODEL_REGISTRY } from '../llm/registry';
import { isSafeId, leaderboardResponse, listTournaments, TournamentNotFoundError } from '../leaderboard';
import { listLogs, LOG_DIR } from '../logFiles';
import { createFileLogger, withConsole } from '../logger';
import { runMatch, type MatchResult, type PlayerController } from '../match';
import { parseJsonl, type LogEvent } from '../replay';
import { createEventHub } from '../spectator';
import { TOURNAMENT_DIR, TOURNAMENT_VIDEO_DIR } from '../tournament';

/**
 * Local control panel backend: start matches, watch them live, browse past
 * ones and export videos. Serves the built UI from dist/ plus a small JSON API.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
};

/** Upper bound for the studio's rounds field (a round is ~160 generations plus API calls). */
const MAX_ROUNDS_LIMIT = 30;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface StudioOptions {
  port: number;
  distDir?: string;
  logDir?: string;
  videoDir?: string;
  /** Root of tournament folders (default bench-logs/tournaments). */
  tournamentDir?: string;
  /** Root of tournament videos (default videos/tournaments), served next to the leaderboard's match list. */
  tournamentVideoDir?: string;
  /** Start rendering a match's video as soon as it finishes (default: on, unless env STUDIO_AUTO_EXPORT=0). */
  autoExport?: boolean;
  /** Test hook: the exporter script spawned for video jobs (default: the real exporter next to this server). */
  exporterPath?: string;
  /** Suppress the per-event console lines (used by tests). */
  quiet?: boolean;
  /** Pause between simulated generations in live viewers (ms). */
  simDelayMs?: number;
  /** Test hook: build the controllers instead of using the model registry. */
  controllerFactory?: (p1Key: string, p2Key: string | null) => { p1: PlayerController; p2: PlayerController };
}

interface CurrentMatch {
  id: string;
  running: boolean;
  startedAt: number;
  result?: MatchResult;
  error?: string;
}

interface ExportJob {
  state: 'running' | 'done' | 'error';
  done: number;
  total: number;
  error?: string;
}

interface MatchSummary {
  id: string;
  startedAt: number;
  preset: string;
  p1: string;
  p2: string;
  status: 'running' | 'finished' | 'invalid' | 'incomplete';
  winner: string | null;
  rounds: number;
  p1HeartHp: number | null;
  p2HeartHp: number | null;
  /** Real LLM spend so far in USD (sum of logged costUsd). */
  costUsd: number;
  hasVideo: boolean;
}

export interface StudioHandle {
  server: Server;
  port: number;
  close(): void;
}

function label(raw: unknown): string {
  const p = raw as { provider?: string; modelId?: string } | null | undefined;
  return p?.modelId ? `${p.provider}/${p.modelId}` : 'Baseline bot';
}

export function startStudio(options: StudioOptions): Promise<StudioHandle> {
  const distDir = resolve(options.distDir ?? 'dist');
  const logDir = options.logDir ?? LOG_DIR;
  const videoDir = options.videoDir ?? 'videos';
  const tournamentDir = options.tournamentDir ?? TOURNAMENT_DIR;
  const tournamentVideoDir = options.tournamentVideoDir ?? TOURNAMENT_VIDEO_DIR;
  const autoExport = options.autoExport ?? process.env.STUDIO_AUTO_EXPORT !== '0';
  const exporterPath = options.exporterPath ?? join(__dirname, '..', 'video', 'export.js');
  const hub = createEventHub();
  const jobs = new Map<string, ExportJob>();
  let current: CurrentMatch | null = null;

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((ok, fail) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        try {
          ok(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          fail(new HttpError(400, 'Request body must be valid JSON.'));
        }
      });
    });

  const hasKey = (provider: keyof typeof API_KEY_ENV) => Boolean(process.env[API_KEY_ENV[provider]]);

  const summarize = (id: string, path: string, mtimeMs: number): MatchSummary => {
    let events: LogEvent[] = [];
    try {
      events = parseJsonl(readFileSync(path, 'utf8'));
    } catch {
      /* a half-written last line just means the match is still running */
    }
    const start = events.find(e => e.type === 'match_start');
    const end = events.find(e => e.type === 'match_end');
    const invalid = events.find(e => e.type === 'match_invalid' || e.type === 'match_cost_cap');
    const costUsd = events.reduce((sum, e) => sum + (e.type === 'turn' || e.type === 'llm_usage' ? Number(e.costUsd) || 0 : 0), 0);
    const lastRound = [...events].reverse().find(e => e.type === 'round_resolved');
    const running = current?.running === true && current.id === id;
    const winner = end?.winner;
    return {
      id,
      startedAt: mtimeMs,
      preset: String(start?.preset ?? '?'),
      p1: label(start?.p1),
      p2: label(start?.p2),
      status: running ? 'running' : end ? 'finished' : invalid ? 'invalid' : 'incomplete',
      winner: winner === undefined || winner === null ? null : String(winner),
      rounds: Number(lastRound?.round ?? 0),
      p1HeartHp: lastRound ? Number(lastRound.p1HeartHp) : null,
      p2HeartHp: lastRound ? Number(lastRound.p2HeartHp) : null,
      costUsd,
      hasVideo: existsSync(join(videoDir, `${id}.mp4`)),
    };
  };

  const startMatch = async (body: Record<string, unknown>) => {
    if (current?.running) throw new HttpError(409, 'A match is already running. Wait for it to finish.');

    const p1Key = String(body.p1 ?? '');
    const p2Raw = String(body.p2 ?? 'baseline');
    const p2Key = p2Raw === 'baseline' ? null : p2Raw;
    const preset = String(body.preset ?? 'skirmish');
    if (!(preset in PRESETS)) throw new HttpError(400, `Unknown preset "${preset}".`);
    let maxRounds: number | undefined;
    if (body.maxRounds !== undefined && body.maxRounds !== null && body.maxRounds !== '') {
      maxRounds = Number(body.maxRounds);
      if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_LIMIT) {
        throw new HttpError(400, `maxRounds must be a whole number from 1 to ${MAX_ROUNDS_LIMIT}.`);
      }
    }
    const pauseSec = Number(body.roundPauseSec ?? 8);
    if (!Number.isFinite(pauseSec) || pauseSec < 0 || pauseSec > 120) {
      throw new HttpError(400, 'roundPauseSec must be between 0 and 120.');
    }

    let maxUsd: number | undefined;
    if (body.maxUsd !== undefined && body.maxUsd !== null && body.maxUsd !== '') {
      maxUsd = Number(body.maxUsd);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new HttpError(400, 'maxUsd must be a positive number.');
    }

    let controllers: { p1: PlayerController; p2: PlayerController };
    try {
      if (options.controllerFactory) {
        controllers = options.controllerFactory(p1Key, p2Key);
      } else {
        const p1Entry = getModelEntry(p1Key);
        const p2Entry = p2Key ? getModelEntry(p2Key) : null;
        for (const entry of [p1Entry, p2Entry]) {
          if (entry && !hasKey(entry.provider)) {
            throw new Error(`${API_KEY_ENV[entry.provider]} is not set, so "${entry.key}" cannot run. Add it to .env and restart.`);
          }
        }
        controllers = { p1: createClient(p1Entry), p2: p2Entry ? createClient(p2Entry) : 'baseline' };
      }
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }

    mkdirSync(logDir, { recursive: true });
    const id = `match-${p1Key}-vs-${p2Key ?? 'baseline'}-${Date.now()}`;
    const fileLogger = createFileLogger(join(logDir, `${id}.jsonl`));
    const logger = hub.wrap(options.quiet ? fileLogger : withConsole(fileLogger));
    hub.reset();
    const match: CurrentMatch = { id, running: true, startedAt: Date.now() };
    current = match;

    runMatch(preset as keyof typeof PRESETS, controllers.p1, controllers.p2, logger, {
      simDelayMs: options.simDelayMs ?? 40,
      maxRounds,
      roundPauseMs: pauseSec * 1000,
      maxUsd,
    })
      .then(result => {
        match.result = result;
      })
      .catch(err => {
        match.error = err instanceof Error ? err.message : String(err);
        logger.log({ type: 'match_error', reason: match.error });
      })
      .finally(() => {
        match.running = false;
        // A finished match (not an aborted / invalid / errored one) gets its video rendered right away, through the same job the Export button uses.
        if (autoExport && match.result && !match.result.invalid && !match.result.aborted) {
          try {
            startExport(id);
          } catch (err) {
            logger.log({ type: 'video_export_error', reason: err instanceof Error ? err.message : String(err) });
          }
        }
      });

    return { id };
  };

  const startExport = (id: string) => {
    const logPath = join(logDir, `${id}.jsonl`);
    if (!/^[\w.-]+$/.test(id) || !existsSync(logPath)) throw new HttpError(404, 'Unknown match.');
    if (jobs.get(id)?.state === 'running') return;
    if (current?.running && current.id === id) throw new HttpError(409, 'That match is still running.');

    mkdirSync(videoDir, { recursive: true });
    const job: ExportJob = { state: 'running', done: 0, total: 0 };
    jobs.set(id, job);
    const child = spawn(process.execPath, [exporterPath, logPath, '--out', join(videoDir, `${id}.mp4`), '--no-build'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        const m = line.match(/^PROGRESS (\d+)\/(\d+)/);
        if (m) {
          job.done = Number(m[1]);
          job.total = Number(m[2]);
        }
      }
    });
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('exit', code => {
      if (code === 0) job.state = 'done';
      else {
        job.state = 'error';
        job.error = stderr.trim().split('\n').slice(-3).join(' ') || `exporter exited with code ${code}`;
      }
    });
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse, file: string) => {
    const size = statSync(file).size;
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/config' && method === 'GET') {
      sendJson(res, 200, {
        models: MODEL_REGISTRY.map(m => ({
          key: m.key,
          provider: m.provider,
          modelId: m.modelId,
          notes: m.notes ?? '',
          hasKey: hasKey(m.provider),
        })),
        presets: Object.entries(PRESETS).map(([key, p]) => ({
          key,
          name: p.name,
          width: p.width,
          height: p.height,
          maxRounds: p.maxRounds,
          generationsPerRound: p.generationsPerRound,
          movesPerRound: p.movesPerRound,
        })),
        defaults: { preset: 'skirmish', roundPauseSec: 8 },
        limits: { maxRounds: MAX_ROUNDS_LIMIT },
      });
      return;
    }

    if (path === '/api/matches' && method === 'GET') {
      sendJson(res, 200, { matches: listLogs(logDir).map(l => summarize(l.id, l.path, l.mtimeMs)) });
      return;
    }
    if (path === '/api/matches' && method === 'POST') {
      sendJson(res, 201, await startMatch(await readBody(req)));
      return;
    }
    if (path === '/api/live/events' && method === 'GET') {
      hub.attach(req, res);
      return;
    }

    if (path === '/api/tournaments' && method === 'GET') {
      sendJson(res, 200, { tournaments: listTournaments(tournamentDir) });
      return;
    }
    if (path === '/api/leaderboard' && method === 'GET') {
      try {
        sendJson(res, 200, leaderboardResponse(url.searchParams.get('id'), tournamentDir, {}, tournamentVideoDir));
      } catch (err) {
        throw new HttpError(err instanceof TournamentNotFoundError ? 404 : 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const tourneyLog = path.match(/^\/api\/tournaments\/([\w.-]+)\/log\/([\w.-]+\.jsonl)$/);
    if (tourneyLog && method === 'GET') {
      const [, id, name] = tourneyLog;
      const file = join(tournamentDir, id, name);
      if (!isSafeId(id) || !isSafeId(name) || !existsSync(file)) throw new HttpError(404, 'Unknown match log.');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(file));
      return;
    }

    const tourneyVideo = path.match(/^\/api\/tournaments\/([\w.-]+)\/video\/([\w.-]+\.mp4)$/);
    if (tourneyVideo && method === 'GET') {
      const [, id, name] = tourneyVideo;
      const file = join(tournamentVideoDir, id, name);
      if (!isSafeId(id) || !isSafeId(name) || !existsSync(file)) throw new HttpError(404, 'No video for that match.');
      serveFile(req, res, file);
      return;
    }

    const logMatch = path.match(/^\/api\/matches\/([\w.-]+)\/log$/);
    if (logMatch && method === 'GET') {
      const file = join(logDir, `${logMatch[1]}.jsonl`);
      if (!existsSync(file)) throw new HttpError(404, 'Unknown match.');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(readFileSync(file));
      return;
    }

    const exportMatch = path.match(/^\/api\/matches\/([\w.-]+)\/export$/);
    if (exportMatch && method === 'POST') {
      startExport(exportMatch[1]);
      sendJson(res, 202, { ok: true });
      return;
    }
    if (exportMatch && method === 'GET') {
      const job = jobs.get(exportMatch[1]);
      const hasFile = existsSync(join(videoDir, `${exportMatch[1]}.mp4`));
      sendJson(res, 200, job ?? { state: hasFile ? 'done' : 'none', done: 0, total: 0 });
      return;
    }

    const videoMatch = path.match(/^\/api\/matches\/([\w.-]+)\/video$/);
    if (videoMatch && method === 'GET') {
      const file = join(videoDir, `${videoMatch[1]}.mp4`);
      if (!existsSync(file)) throw new HttpError(404, 'No video exported for that match yet.');
      serveFile(req, res, file);
      return;
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'Unknown API route.');

    const target = resolve(distDir, `.${path === '/' ? '/studio.html' : path}`);
    if (target.startsWith(distDir) && existsSync(target) && statSync(target).isFile()) {
      serveFile(req, res, target);
      return;
    }
    throw new HttpError(404, 'Not found. Did you build the UI (npm run studio does this for you)?');
  };

  const server = createServer((req, res) => {
    route(req, res).catch(err => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  return new Promise(ok => {
    server.listen(options.port, '127.0.0.1', () => {
      const addr = server.address();
      ok({
        server,
        port: typeof addr === 'object' && addr ? addr.port : options.port,
        close() {
          hub.closeAll();
          server.close();
        },
      });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.STUDIO_PORT || 8790);
  startStudio({ port }).then(h => {
    console.log(`\ngameofdeath studio running at http://127.0.0.1:${h.port}/`);
    console.log('Pick models, start a match, watch it live, and export videos from the page. Ctrl+C to stop.\n');
  });
}
