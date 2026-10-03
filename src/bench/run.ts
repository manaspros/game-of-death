import type { PresetName } from '../engine/types';
import { requireEnv } from './config';
import { createClient, getModelEntry } from './llm/registry';
import { createFileLogger, withConsole } from './logger';
import { runMatch, type PlayerController } from './match';
import { startSpectatorServer } from './spectator';

async function main(): Promise<void> {
  const p1Entry = getModelEntry(requireEnv('BENCH_MODEL'));
  const p2Key = process.env.BENCH_MODEL_P2;
  const p2Entry = p2Key ? getModelEntry(p2Key) : null;
  const preset = (process.env.BENCH_PRESET || 'skirmish') as PresetName;

  const p1: PlayerController = createClient(p1Entry);
  const p2: PlayerController = p2Entry ? createClient(p2Entry) : 'baseline';

  const logPath = `bench-logs/match-${p1Entry.key}-vs-${p2Entry?.key ?? 'baseline'}-${Date.now()}.jsonl`;
  const consoleLogger = withConsole(createFileLogger(logPath));
  const spectator = process.env.BENCH_SPECTATE === '1'
    ? startSpectatorServer(Number(process.env.BENCH_SPECTATE_PORT || 8787))
    : null;
  const logger = spectator ? spectator.wrap(consoleLogger) : consoleLogger;
  if (spectator) {
    console.log(`Spectator feed on http://127.0.0.1:${spectator.port}/events`);
    console.log('Watch live: run `npm run dev` and open http://localhost:5173/spectate.html');
  }

  console.log(`Match: P1 ${p1Entry.key} [${p1Entry.provider}/${p1Entry.modelId}] vs P2 ${p2Entry ? `${p2Entry.key} [${p2Entry.provider}/${p2Entry.modelId}]` : 'baseline bot'} on preset "${preset}"`);
  console.log(`Logging to ${logPath}`);

  const roundPauseMs = Number(process.env.BENCH_ROUND_PAUSE_SEC || 8) * 1000;
  const result = await runMatch(preset, p1, p2, logger, { simDelayMs: spectator ? 40 : 0, roundPauseMs });

  if (result.invalid) {
    console.error(`\nMATCH INVALID - not scoreable. P${result.invalid.playerId}'s provider failed:\n  ${result.invalid.reason}`);
    process.exitCode = 2;
  } else {
    console.log('Match finished:', result);
  }
  console.log(`Review it with: npm run summary -- ${logPath}`);
  if (spectator) console.log('Spectator feed still up so the page can show the final state. Ctrl+C to exit.');
}

main().catch(err => {
  console.error('Match failed:', err);
  process.exitCode = 1;
});
