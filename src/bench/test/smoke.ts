import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMCallResult, LLMClient } from '../llm/types';
import { createFileLogger } from '../logger';
import { runMatch, type PlayerController } from '../match';
import type { BenchAction, Observation } from '../types';

/**
 * No-network smoke tests for the match orchestration (loop.ts + match.ts +
 * baselineBot.ts) using fake LLMClients in place of real providers. Proves a
 * full match runs to completion end-to-end before spending real API calls.
 */
class FakeClient implements LLMClient {
  readonly provider = 'fake';
  private calls = 0;

  constructor(readonly modelId: string) {}

  async getAction(observation: Observation): Promise<LLMCallResult> {
    this.calls++;
    const start = Date.now();
    const z = observation.you.buildZone;
    let action: BenchAction;

    if (observation.you.heartZone === null) {
      action = { action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' };
    } else if (observation.you.movesLeft >= 5) {
      action = { action: 'place', anchor: [z.x + 6, z.y + 8 + (this.calls % 4) * 6], preset: 'Glider', rotation: 0 };
    } else {
      action = { action: 'submit' };
    }

    return { actions: [action], rationale: `fake rationale #${this.calls}`, latencyMs: Date.now() - start };
  }

  get callCount(): number {
    return this.calls;
  }
}

async function play(label: string, p1: PlayerController, p2: PlayerController): Promise<void> {
  // Scripted players must never leave logs next to real matches.
  const logger = createFileLogger(join(mkdtempSync(join(tmpdir(), 'gameofdeath-smoke-')), `${label}.jsonl`));
  const result = await runMatch('skirmish', p1, p2, logger);
  console.log(`${label}:`, result);

  if (typeof result.rounds !== 'number' || result.rounds < 1) {
    throw new Error(`${label}: expected match to complete at least one round.`);
  }
  if (result.p1HeartHp > 100 || result.p2HeartHp > 100) {
    throw new Error(`${label}: heart HP exceeded max - simulation logic looks wrong.`);
  }
}

async function main(): Promise<void> {
  const a = new FakeClient('fake/a');
  await play('llm-vs-baseline', a, 'baseline');
  if (a.callCount === 0) throw new Error('P1 LLM was never called.');

  const b = new FakeClient('fake/b');
  const c = new FakeClient('fake/c');
  await play('llm-vs-llm', b, c);
  if (b.callCount === 0 || c.callCount === 0) throw new Error('Both LLM seats should have been called.');

  console.log('\nSmoke tests passed.');
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
