import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { MatchLogger } from './logger';
import type { Snapshot } from './snapshot';

/**
 * Server-Sent Events feed for the browser viewers. Late joiners get every
 * past event plus the latest board snapshot.
 */
export interface EventHub {
  /** Handle one SSE request (any path the caller routes here). */
  attach(req: IncomingMessage, res: ServerResponse): void;
  wrap(inner: MatchLogger): MatchLogger;
  /** Forget everything and tell connected viewers to clear their screens (new match). */
  reset(): void;
  closeAll(): void;
}

export function createEventHub(): EventHub {
  const clients = new Set<ServerResponse>();
  /** Events that arrive for a client that is still being caught up; flushed (in order) once its replay is written. */
  const catchingUp = new Map<ServerResponse, string[]>();
  let history: string[] = [];
  let latestSnapshot: string | null = null;

  const send = (res: ServerResponse, payload: string) => res.write(`data: ${payload}\n\n`);
  const broadcast = (payload: string) =>
    clients.forEach(res => {
      const queue = catchingUp.get(res);
      if (queue) queue.push(payload);
      else send(res, payload);
    });

  return {
    attach(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // Register BEFORE replaying so nothing logged during the catch-up can be missed; such events wait in the queue and follow the replay in order.
      const queue: string[] = [];
      catchingUp.set(res, queue);
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        catchingUp.delete(res);
      });
      const replay = history.slice();
      const snapshotAtJoin = latestSnapshot;
      replay.forEach(h => send(res, h));
      if (snapshotAtJoin) send(res, snapshotAtJoin);
      catchingUp.delete(res);
      queue.forEach(q => send(res, q));
    },
    wrap(inner: MatchLogger): MatchLogger {
      return {
        log(entry: Record<string, unknown>) {
          inner.log(entry);
          // The observation is large and the viewers don't need it.
          const { observation: _observation, ...slim } = entry;
          const payload = JSON.stringify({ ...slim, ts: Date.now() });
          history.push(payload);
          broadcast(payload);
        },
        snapshot(snap: Snapshot) {
          inner.snapshot?.(snap);
          latestSnapshot = JSON.stringify({ type: 'snapshot', ...snap });
          broadcast(latestSnapshot);
        },
      };
    },
    reset() {
      history = [];
      latestSnapshot = null;
      broadcast(JSON.stringify({ type: 'reset' }));
    },
    closeAll() {
      clients.forEach(res => res.end());
      clients.clear();
      catchingUp.clear();
    },
  };
}

export interface SpectatorServer {
  readonly port: number;
  wrap(inner: MatchLogger): MatchLogger;
  close(): void;
}

/** Standalone feed for `npm run bench:watch`, at http://127.0.0.1:<port>/events. */
export function startSpectatorServer(port: number): SpectatorServer {
  const hub = createEventHub();
  const server = createServer((req, res) => {
    if (req.url !== '/events') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('gameofdeath spectator feed: connect to /events (SSE)\n');
      return;
    }
    hub.attach(req, res);
  });
  server.listen(port, '127.0.0.1');

  return {
    port,
    wrap: inner => hub.wrap(inner),
    close() {
      hub.closeAll();
      server.close();
    },
  };
}
