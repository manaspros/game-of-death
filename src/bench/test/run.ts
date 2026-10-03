import { GameState } from '../../game/state';
import { applyBenchAction } from '../action';
import { buildGeminiBody } from '../llm/aistudio';
import type { ThinkingLevel } from '../llm/aistudio';
import type { BenchAction } from '../types';
import { createServer } from 'node:http';
import type { AttemptFailure, LLMCallResult, LLMClient } from '../llm/types';
import { runLLMBuildPhase } from '../loop';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMatch, type PlayerController } from '../match';
import { startStudio } from '../studio/server';
import { MinIntervalLimiter } from '../llm/rateLimiter';
import { buildTimeline, parseJsonl, type LogEvent } from '../replay';
import { isFatalProviderError, ModelResponseError, ProviderRequestError, ProviderUnavailableError, QuotaExhaustedError } from '../llm/errors';
import { postJsonWithRetry } from '../llm/http';
import { createClient, getModelEntry, MODEL_REGISTRY } from '../llm/registry';
import { buildUserMessage, extractAnalysis, extractNotes, GAP, extractRationale, SYSTEM_PROMPT, TOOL_DEFS, toolCallToAction, toolCallToActions } from '../llm/tools';
import { BlueprintBook, MAX_BATCH, MAX_BLUEPRINTS } from '../blueprints';
import { compactAction, HISTORY_ROUNDS, MAX_NOTES_CHARS, MAX_TURN_NOTES_CHARS, MatchMemory } from '../memory';
import { buildPostMortem } from '../postmortem';
import { PATTERNS, rotatePattern } from '../../game/patterns';
import { runBaselineBotBuildPhase } from '../baselineBot';
import { serializeObservation } from '../observation';
import { buildSnapshot } from '../snapshot';

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

test('observation: fresh board has no alive cells and full move budget', () => {
  const state = new GameState('quick');
  const obs = serializeObservation(state, 1);
  assert(obs.you.cells.length === 0 && obs.you.intruders.length === 0, 'expected no alive cells at game start');
  assert(obs.you.movesLeft === state.preset.movesPerRound, 'movesLeft should equal full budget');
  assert(obs.battlefield.zone.x === state.layout.battlefield.x, 'battlefield zone should match layout');
  assert(obs.battlefield.yours.length + obs.battlefield.theirs.length + obs.battlefield.neutral.length === 0, 'battlefield should start empty');
});

test('action: other patterns are rejected before the Heart is placed', () => {
  const state = new GameState('quick');
  const result = applyBenchAction(state, 1, { action: 'place', anchor: [5, 5], preset: 'Glider' });
  assert(!result.ok, 'expected glider placement to fail before heart is placed');
});

test('action: placing the Heart via preset succeeds and sets heartPlaced', () => {
  const state = new GameState('quick');
  const zone = state.layout.p1Build;
  const result = applyBenchAction(state, 1, {
    action: 'place',
    anchor: [zone.x + 2, zone.y + 2],
    preset: 'Heart',
  });
  assert(result.ok, `expected heart placement to succeed, got: ${result.error}`);
  assert(state.players[0].heartPlaced, 'heartPlaced should be true after placing the heart');
  assert(state.players[0].heartZone !== null, 'heartZone should be set after placing the heart');
});

test('action: heart cannot be placed twice', () => {
  const state = new GameState('quick');
  const zone = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  const second = applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 8, zone.y + 8], preset: 'Heart' });
  assert(!second.ok, 'expected second heart placement to be rejected');
});

test('action: custom cells respect the bounding-box cap', () => {
  const state = new GameState('quick');
  const zone = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  const oversized: [number, number][] = [[0, 0], [13, 13]];
  const result = applyBenchAction(state, 1, {
    action: 'place',
    anchor: [zone.x + 4, zone.y + 10],
    cells: oversized,
  });
  assert(!result.ok, 'expected oversized custom bounding box to be rejected');
});

test('action: a small custom cell list places correctly', () => {
  const state = new GameState('quick');
  const zone = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  const before = state.players[0].movesLeft;
  const result = applyBenchAction(state, 1, {
    action: 'place',
    anchor: [zone.x + 10, zone.y + 10],
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
  });
  assert(result.ok, `expected custom placement to succeed, got: ${result.error}`);
  assert(state.players[0].movesLeft === before - 4, 'expected move budget to drop by cell count');
});

test('action: submit commits the player', () => {
  const state = new GameState('quick');
  const zone = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  const result = applyBenchAction(state, 1, { action: 'submit' });
  assert(result.ok && result.submitted, 'expected submit to succeed');
  assert(state.players[0].committed, 'player should be committed after submit');
});

test('observation: semi-hidden mode hides the opponent\'s in-progress build', () => {
  const state = new GameState('quick');
  const zone = state.layout.p2Build;
  applyBenchAction(state, 2, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  applyBenchAction(state, 2, { action: 'place', anchor: [zone.x + 8, zone.y + 8], preset: 'Block' });
  const obs = serializeObservation(state, 1);
  assert(obs.opponent.visibleCells.length === 0, "expected no visibility into the opponent's current-round build under semi-hidden");
  assert(obs.opponent.heartZone === null, 'their heart is unknown in round 1 under semi-hidden');
});

test('observation: visible mode shows the opponent\'s current build and heart box', () => {
  const state = new GameState('quick');
  state.visibility = 'visible';
  const zone = state.layout.p2Build;
  applyBenchAction(state, 2, { action: 'place', anchor: [zone.x + 2, zone.y + 2], preset: 'Heart' });
  applyBenchAction(state, 2, { action: 'place', anchor: [zone.x + 8, zone.y + 8], preset: 'Block' });
  const obs = serializeObservation(state, 1);
  assert(obs.opponent.visibleCells.length === 4, 'the opponent\'s Block (4 cells) should be visible; Heart cells are reported via heartZone');
  assert(obs.opponent.heartZone?.w === 5 && obs.opponent.heartZone.h === 4, 'their heart box should be visible');
});

test('observation and action work across all presets', () => {
  for (const preset of ['quick', 'standard', 'epic', 'skirmish'] as const) {
    const state = new GameState(preset);
    const zone = state.layout.p1Build;
    const result = applyBenchAction(state, 1, {
      action: 'place',
      anchor: [zone.x + 2, zone.y + 2],
      preset: 'Heart',
    });
    assert(result.ok, `heart placement failed on preset "${preset}": ${result.error}`);
    const obs = serializeObservation(state, 1);
    assert(obs.you.heartZone?.w === 5 && obs.you.cells.length === 0, `heart box expected, and no listed cells, on preset "${preset}"`);
  }
});

test('registry: entries have unique keys and valid providers', () => {
  const keys = new Set<string>();
  for (const m of MODEL_REGISTRY) {
    assert(!keys.has(m.key), `duplicate registry key "${m.key}"`);
    keys.add(m.key);
    assert(['openrouter', 'groq', 'aistudio'].includes(m.provider), `bad provider on "${m.key}"`);
    assert(m.modelId.length > 0, `empty modelId on "${m.key}"`);
  }
  assert(MODEL_REGISTRY.length > 0, 'registry should not be empty');
});

test('registry: unknown key lists the known keys', () => {
  let message = '';
  try {
    getModelEntry('nope');
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.includes('Unknown model key'), 'expected an unknown-key error');
  assert(message.includes(MODEL_REGISTRY[0].key), 'error should list known keys');
});

test('registry: createClient builds the right client per provider and needs its key', () => {
  const envNames = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY'];
  const saved = envNames.map(n => process.env[n]);
  try {
    for (const m of MODEL_REGISTRY) {
      for (const n of envNames) delete process.env[n];
      let threw = false;
      try {
        createClient(m);
      } catch {
        threw = true;
      }
      assert(threw, `createClient("${m.key}") should throw when its API key is missing`);
    }

    process.env.OPENROUTER_API_KEY = 'x';
    process.env.GROQ_API_KEY = 'x';
    process.env.GOOGLE_AI_STUDIO_API_KEY = 'x';
    for (const m of MODEL_REGISTRY) {
      const client = createClient(m);
      assert(client.provider === m.provider, `provider mismatch for "${m.key}"`);
      assert(client.modelId === m.modelId, `modelId mismatch for "${m.key}"`);
    }
  } finally {
    envNames.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  }
});

test('registry: nativeToolCalling=false is rejected until the fallback exists', () => {
  const entry = { ...MODEL_REGISTRY[0], nativeToolCalling: false };
  let threw = false;
  try {
    createClient(entry);
  } catch {
    threw = true;
  }
  assert(threw, 'expected createClient to reject non-tool-calling models');
});

test('tools: toolCallToAction parses preset, cells, submit and rejects junk', () => {
  const preset = toolCallToAction('place_pattern', { anchor: [3, 4], preset: 'Glider', rotation: 2 });
  assert(preset.action === 'place' && 'preset' in preset && preset.preset === 'Glider', 'preset parse failed');

  const cells = toolCallToAction('place_pattern', { anchor: ['3', '4'], cells: [['0', '0'], [1, 0]] });
  assert(
    cells.action === 'place' && 'cells' in cells && cells.anchor[0] === 3 && cells.cells[0][0] === 0,
    'cells parse/coercion failed',
  );

  assert(toolCallToAction('submit_turn', {}).action === 'submit', 'submit parse failed');

  for (const bad of [
    () => toolCallToAction('place_pattern', { preset: 'Glider' }),
    () => toolCallToAction('place_pattern', { anchor: [1, 2] }),
    () => toolCallToAction('mystery', {}),
  ]) {
    let threw = false;
    try {
      bad();
    } catch {
      threw = true;
    }
    assert(threw, 'expected malformed tool call to throw');
  }
});

test('aistudio: request body is Gemini-safe (no enum, ANY mode, rationale required)', () => {
  const obs = serializeObservation(new GameState('quick'), 1);
  const body = buildGeminiBody(obs, ['Glider']);
  assert(!JSON.stringify(body.tools).includes('"enum"'), 'numeric enum must be stripped for Gemini');

  const decls = (body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0].functionDeclarations;
  const submit = decls.find(d => d.name === 'end_turn');
  assert(submit !== undefined && 'parameters' in submit, 'end_turn carries a rationale parameter');
  const place = decls.find(d => d.name === 'place');
  assert(place !== undefined && 'parameters' in place, 'place must keep its parameters');

  const mode = (body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode;
  assert(mode === 'ANY', 'function calling should be forced');
});

test('observation: exposes both players\' build zones', () => {
  const state = new GameState('quick');
  const obs = serializeObservation(state, 2);
  assert(obs.you.buildZone.x === state.layout.p2Build.x, 'own buildZone should be the P2 zone for player 2');
  assert(obs.opponent.buildZone.x === state.layout.p1Build.x, 'opponent buildZone should be the P1 zone');
});

test('tools: user message carries the previous rejection only when there is one', () => {
  const obs = serializeObservation(new GameState('quick'), 1);
  const clean = JSON.parse(buildUserMessage(obs, ['Glider']));
  assert(!('previousActionRejected' in clean), 'no rejection field expected on a clean call');
  const retry = JSON.parse(buildUserMessage(obs, ['Glider'], 'Illegal heart placement.'));
  assert(String(retry.previousActionRejected).includes('Illegal heart placement.'), 'rejection text missing');
});

test('loop: a rejected action is fed back to the model on the next call', async () => {
  const seen: (string | undefined)[] = [];
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/feedback',
    async getAction(obs, _presets, previousRejection): Promise<LLMCallResult> {
      seen.push(previousRejection);
      if (seen.length === 1) {
        return { actions: [{ action: 'place', anchor: [90, 40], preset: 'Heart' }], latencyMs: 0 };
      }
      const z = obs.you.buildZone;
      if (obs.you.heartZone === null) {
        return { actions: [{ action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' }], latencyMs: 0 };
      }
      return { actions: [{ action: 'submit' }], latencyMs: 0 };
    },
  };
  const state = new GameState('quick');
  await runLLMBuildPhase(state, 1, client, { log() {} });
  assert(seen[0] === undefined, 'first call should have no rejection');
  assert(typeof seen[1] === 'string' && seen[1].length > 0, 'second call should carry the rejection reason');
  assert(seen[2] === undefined, 'rejection should clear after a successful action');
  assert(state.players[0].heartPlaced && state.players[0].committed, 'model should recover and submit');
});

test('snapshot: flat cell list carries owners, zones, and heart zone', () => {
  const state = new GameState('skirmish');
  const z1 = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z1.x + 2, z1.y + 2], preset: 'Heart' });
  const z2 = state.layout.p2Build;
  applyBenchAction(state, 2, { action: 'place', anchor: [z2.x + 2, z2.y + 2], preset: 'Heart' });
  const snap = buildSnapshot(state);
  assert(snap.cells.length % 3 === 0, 'cells must be a flat x,y,owner list');
  assert(snap.cells.length / 3 === 20, 'two 10-cell hearts expected');
  const owners = new Set(snap.cells.filter((_, i) => i % 3 === 2));
  assert(owners.has(4) && owners.has(5) && owners.size === 2, 'heart cells should be reported as owner codes 4 and 5');
  assert(snap.p1.heartZone !== null && snap.p2.heartZone !== null, 'heart zones should be reported');
  assert(snap.width === state.preset.width && snap.totalGenerations === state.preset.generationsPerRound, 'dimensions mismatch');
});

test('http: failed attempts are reported through hooks and then retried', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(429);
      res.end('rate limited by upstream');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const failures: AttemptFailure[] = [];
  try {
    const { value } = await postJsonWithRetry<{ ok: boolean }, boolean>(
      'test',
      `http://127.0.0.1:${port}/`,
      {},
      {},
      json => json.ok,
      { attemptFailed: info => failures.push(info) },
      { retryDelaysMs: [20] },
    );
    assert(value === true, 'second attempt should succeed');
    assert(failures.length === 1, 'exactly one failed attempt should be reported');
    assert(failures[0].reason.includes('429') && failures[0].reason.includes('rate limited'), 'reason should carry status and body');
    assert(failures[0].willRetry && failures[0].attempt === 1, 'first failure should be marked as retried');
  } finally {
    server.close();
  }
});

test('tools: the system prompt asks for aggressive, concrete, reasoned play', () => {
  assert(/aggressive/i.test(SYSTEM_PROMPT), 'prompt should ask for aggressive play');
  assert(/whole move budget/i.test(SYSTEM_PROMPT), 'prompt should discourage wasting moves');
  assert(/reason concretely/i.test(SYSTEM_PROMPT) && /generations/i.test(SYSTEM_PROMPT), 'prompt should demand trajectory reasoning');
  assert(/between rounds/i.test(SYSTEM_PROMPT), 'prompt should ask the model to adapt between rounds');
});

test('tools: every tool requires a rationale and extractRationale is tolerant', () => {
  for (const tool of TOOL_DEFS) {
    assert(tool.parameters.required?.includes('rationale'), `${tool.name} must require a rationale`);
  }
  assert(extractRationale({ rationale: '  block the glider lane  ' }) === 'block the glider lane', 'should trim');
  assert(extractRationale({}) === undefined, 'missing rationale should be undefined, not an error');
  assert(extractRationale({ rationale: 'x'.repeat(900) })?.length === 500, 'should cap length');
});

// ---------- Heart rules ----------

function twoHeartGame(): GameState {
  const state = new GameState('skirmish');
  for (const id of [1, 2] as const) {
    const z = id === 1 ? state.layout.p1Build : state.layout.p2Build;
    const r = applyBenchAction(state, id, { action: 'place', anchor: [z.x + 4, z.y + 15], preset: 'Heart' });
    assert(r.ok, `heart placement failed for P${id}: ${r.error}`);
    applyBenchAction(state, id, { action: 'submit' });
  }
  return state;
}

test('heart: fixed cells survive indefinitely and nothing is born around them', () => {
  const state = twoHeartGame();
  state.startSimulation();
  for (let g = 0; g < 60; g++) state.advanceSimulation();
  assert(state.grid.countByOwner('p1') === 10, 'P1 should still have exactly its 10 heart cells (no deaths, no births)');
  assert(state.grid.countByOwner('p2') === 10, 'P2 should still have exactly its 10 heart cells');
  const hz = state.players[0].heartZone!;
  let alive = 0;
  for (let y = hz.y; y < hz.y + hz.h; y++) for (let x = hz.x; x < hz.x + hz.w; x++) if (state.grid.getCell(x, y)?.alive) alive++;
  assert(alive === 10, 'all 10 heart cells must remain in the heart zone');
});

test('heart: enemy cells touching a heart neither kill it nor are killed by it', () => {
  const state = twoHeartGame();
  const hz = state.players[0].heartZone!;
  // A stable enemy block pressed against the heart zone's edge.
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) state.grid.placeCell(hz.x + hz.w + dx, hz.y + dy, 'p2', 0);
  state.startSimulation();
  for (let g = 0; g < 20; g++) state.advanceSimulation();
  assert(state.grid.countByOwner('p1') === 10, 'heart cells must be untouched by adjacent enemy cells');
  assert(state.grid.getCell(hz.x + hz.w, hz.y)?.alive === true, 'enemy block should not be destroyed by touching a heart');
});

test('heart: cannot be removed by the owner', () => {
  const state = new GameState('skirmish');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 4, z.y + 15], preset: 'Heart' });
  const movesBefore = state.players[0].movesLeft;
  const hz = state.players[0].heartZone!;
  let removedAny = false;
  for (let y = hz.y; y < hz.y + hz.h; y++) for (let x = hz.x; x < hz.x + hz.w; x++) removedAny = state.removeCell(x, y) || removedAny;
  assert(!removedAny, 'removeCell must refuse heart cells');
  assert(state.grid.countByOwner('p1') === 10, 'heart cells should all still exist');
  assert(state.players[0].movesLeft === movesBefore, 'no free move refund from heart cells');
});

test('heart: damage per generation is capped', () => {
  const state = new GameState('skirmish');
  state.players[0].heartPlaced = true;
  state.players[0].heartZone = { x: 20, y: 5, w: 8, h: 2 };
  for (const x0 of [20, 23, 26]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) state.grid.placeCell(x0 + dx, 5 + dy, 'p2', 0);
  state.players[0].commit();
  state.players[1].commit();
  state.startSimulation();
  state.advanceSimulation();
  assert(state.players[0].heartHp === 95, `12 enemy cells in the zone must cost exactly 5 HP, got ${100 - state.players[0].heartHp}`);
});

test('observation: Heart cells are left out of the cell lists and reported as a box', () => {
  const state = new GameState('skirmish');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 4, z.y + 15], preset: 'Heart' });
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 10, z.y + 5], preset: 'Block' });
  const you = serializeObservation(state, 1).you;
  assert(you.cells.length === 4, 'only the block should be listed as cells');
  assert(you.heartZone !== null && you.heartZone.x === z.x + 4 && you.heartZone.y === z.y + 15, 'the heart box should match where it was placed');
});

// ---------- Provider failure handling ----------

async function withServer(
  handler: (hit: number) => { status: number; body: string },
  run: (url: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let hits = 0;
  const server = createServer((_req, res) => {
    const { status, body } = handler(++hits);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  try {
    await run(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`, () => hits);
  } finally {
    server.close();
  }
}

async function expectThrows(fn: () => Promise<unknown>, check: (e: unknown) => boolean, msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert(check(e), `${msg} (got ${String(e)})`);
    return;
  }
  throw new Error(`${msg} (nothing was thrown)`);
}

test('http: a daily-quota 429 fails fast as QuotaExhaustedError without retrying', async () => {
  await withServer(
    () => ({ status: 429, body: '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}' }),
    async (url, hits) => {
      await expectThrows(
        () => postJsonWithRetry('t', url, {}, {}, j => j, undefined, { retryDelaysMs: [10, 10] }),
        e => e instanceof QuotaExhaustedError && isFatalProviderError(e),
        'expected QuotaExhaustedError',
      );
      assert(hits() === 1, 'a quota error must not be retried');
    },
  );
});

test('http: a persistent 503 spends every retry then throws ProviderUnavailableError', async () => {
  await withServer(
    () => ({ status: 503, body: '{"error":"high demand"}' }),
    async (url, hits) => {
      const failures: AttemptFailure[] = [];
      await expectThrows(
        () => postJsonWithRetry('t', url, {}, {}, j => j, { attemptFailed: i => failures.push(i) }, { retryDelaysMs: [10, 10, 10] }),
        e => e instanceof ProviderUnavailableError && isFatalProviderError(e),
        'expected ProviderUnavailableError',
      );
      assert(hits() === 4, 'one attempt plus three retries expected');
      assert(failures.length === 4 && !failures[3].willRetry && failures[0].retryInMs === 10, 'failures should carry retry timing');
    },
  );
});

test('http: a bad request (4xx) is a fatal ProviderRequestError, not retried', async () => {
  await withServer(
    () => ({ status: 400, body: '{"error":"bad model"}' }),
    async (url, hits) => {
      await expectThrows(
        () => postJsonWithRetry('t', url, {}, {}, j => j, undefined, { retryDelaysMs: [10] }),
        e => e instanceof ProviderRequestError && isFatalProviderError(e),
        'expected ProviderRequestError',
      );
      assert(hits() === 1, 'a 4xx must not be retried');
    },
  );
});

test('http: an unusable-but-delivered response becomes ModelResponseError (not fatal)', async () => {
  await withServer(
    () => ({ status: 200, body: '{"nope":true}' }),
    async (url, hits) => {
      await expectThrows(
        () =>
          postJsonWithRetry('t', url, {}, {}, () => {
            throw new Error('no tool call');
          }, undefined, { retryDelaysMs: [10, 10, 10, 10] }),
        e => e instanceof ModelResponseError && !isFatalProviderError(e),
        'expected ModelResponseError',
      );
      assert(hits() === 3, 'unusable responses get 3 quick attempts, not the full outage schedule');
    },
  );
});

test('loop: a provider outage throws instead of forfeiting the turn', async () => {
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/down',
    async getAction(): Promise<LLMCallResult> {
      throw new ProviderUnavailableError('stub unavailable');
    },
  };
  const state = new GameState('skirmish');
  await expectThrows(
    () => runLLMBuildPhase(state, 1, client, { log() {} }),
    e => e instanceof ProviderUnavailableError,
    'loop must propagate the outage',
  );
  assert(!state.players[0].committed, 'the player must NOT be force-submitted on an outage');
});

test('loop: an unusable model response is fed back like a rejection', async () => {
  const seen: (string | undefined)[] = [];
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/sloppy',
    async getAction(obs, _p, previousRejection): Promise<LLMCallResult> {
      seen.push(previousRejection);
      if (seen.length === 1) throw new ModelResponseError('no tool call');
      const z = obs.you.buildZone;
      return obs.you.heartZone !== null
        ? { actions: [{ action: 'submit' }], latencyMs: 0 }
        : { actions: [{ action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' }], latencyMs: 0 };
    },
  };
  const state = new GameState('skirmish');
  await runLLMBuildPhase(state, 1, client, { log() {} });
  assert(typeof seen[1] === 'string' && seen[1].includes('unusable'), 'second call should be told the last response was unusable');
  assert(state.players[0].committed && state.players[0].heartPlaced, 'model should recover');
});

test('match: a provider outage marks the match invalid instead of scoring it', async () => {
  const down: LLMClient = {
    provider: 'stub',
    modelId: 'stub/down',
    async getAction(): Promise<LLMCallResult> {
      throw new QuotaExhaustedError('daily quota exhausted');
    },
  };
  const events: string[] = [];
  const result = await runMatch('skirmish', down, 'baseline', { log: e => events.push(String(e.type)) });
  assert(result.invalid !== undefined && result.invalid.playerId === 1, 'result must be flagged invalid for P1');
  assert(result.winner === null, 'an invalid match has no winner');
  assert(events.includes('match_invalid') && !events.includes('round_resolved'), 'must log match_invalid and never resolve a round');
});


// ---------- Pacing, replay ----------

function scriptedClient(modelId: string): LLMClient {
  let calls = 0;
  return {
    provider: 'fake',
    modelId,
    async getAction(obs): Promise<LLMCallResult> {
      calls++;
      const z = obs.you.buildZone;
      if (obs.you.heartZone === null) {
        return { actions: [{ action: 'place', anchor: [z.x + 2, z.y + 16], preset: 'Heart' }], rationale: 'heart first', latencyMs: 1 };
      }
      if (obs.you.movesLeft >= 5) {
        return {
          actions: [{ action: 'place', anchor: [z.x + 6, z.y + 4 + (calls % 5) * 6], preset: 'Glider', rotation: 0 }],
          rationale: `launch #${calls}`,
          latencyMs: 1,
        };
      }
      return { actions: [{ action: 'submit' }], latencyMs: 1 };
    },
  };
}

async function recordMatch(p1: PlayerController, p2: PlayerController, roundPauseMs = 1): Promise<{ events: LogEvent[]; rounds: number }> {
  const events: LogEvent[] = [];
  const result = await runMatch('skirmish', p1, p2, { log: e => events.push({ ...e, type: String(e.type) }) }, { roundPauseMs });
  return { events, rounds: result.rounds };
}

test('limiter: calls are spaced by the minimum interval, even when issued together', async () => {
  const limiter = new MinIntervalLimiter(80);
  const t0 = Date.now();
  const waits = await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  const elapsed = Date.now() - t0;
  assert(waits[0] === 0 && waits[1] >= 60 && waits[2] >= 140, `waits should be about 0/80/160, got ${waits.join('/')}`);
  assert(elapsed >= 150, 'the third call must really have been delayed');
});

test('match: emits round_start for every round and round_break between rounds with the configured pause', async () => {
  const { events, rounds } = await recordMatch(scriptedClient('fake/a'), 'baseline', 7);
  const starts = events.filter(e => e.type === 'round_start');
  const breaks = events.filter(e => e.type === 'round_break');
  assert(starts.length === rounds, `expected ${rounds} round_start events, got ${starts.length}`);
  assert(breaks.length === rounds - 1, 'a break between every pair of rounds, none after the last');
  assert(breaks.every(b => b.pauseMs === 7), 'break events must carry the configured pause');
  assert(events.some(e => e.type === 'bot_turn'), 'baseline bot moves must be logged so replays can rebuild them');
});

test('replay: an LLM-vs-baseline log replays to exactly the logged result', async () => {
  const { events } = await recordMatch(scriptedClient('fake/a'), 'baseline');
  const timeline = buildTimeline(events);
  assert(timeline.warnings.length === 0, `replay diverged: ${timeline.warnings.join(' | ')}`);
  assert(timeline.frames[0].kind === 'card' && timeline.players[1].name === 'Baseline bot', 'starts on an intro card');
  const last = timeline.frames[timeline.frames.length - 1];
  assert(last.kind === 'card' && last.card.title === 'MATCH OVER', 'ends on the match-over card');
  assert(timeline.frames.some(f => f.kind === 'card' && f.card.title.endsWith('COMPLETE')), 'a between-round card must exist');
  assert(timeline.frames.some(f => f.kind === 'board' && f.captions?.some(c => c.rationale === 'heart first')), 'rationales must appear as captions');
});

test('replay: an LLM-vs-LLM log replays cleanly and survives a JSONL round trip', async () => {
  const { events } = await recordMatch(scriptedClient('fake/a'), scriptedClient('fake/b'));
  const roundTripped = parseJsonl(events.map(e => JSON.stringify(e)).join('\n'));
  const timeline = buildTimeline(roundTripped);
  assert(timeline.warnings.length === 0, `replay diverged: ${timeline.warnings.join(' | ')}`);
  assert(timeline.totalMs > 10_000, 'a full match should make a video of more than 10 seconds');
  assert(timeline.frames.some(f => f.kind === 'board' && f.captions?.length === 2), 'both players\' simultaneous moves should share one frame');
});

test('replay: video timing is frame-exact, paced independently of model latency, and starts with the intro', async () => {
  const { events } = await recordMatch(scriptedClient('fake/a'), scriptedClient('fake/b'));
  const timeline = buildTimeline(events);
  const frameMs = 1000 / timeline.fps;
  for (const f of timeline.frames) {
    const n = f.durationMs / frameMs;
    assert(Math.abs(n - Math.round(n)) < 1e-6 && n >= 1, `frame duration ${f.durationMs}ms is not a whole number of ${timeline.fps}fps frames`);
  }
  const cards = timeline.frames.filter(f => f.kind === 'card' && f.alpha === 1).map(f => (f.kind === 'card' ? f.card.title : ''));
  assert(cards[0] === 'GAMEOFDEATH' && cards[1] === 'HOW IT WORKS' && cards[2] === 'TODAY', `intro order wrong: ${cards.slice(0, 3).join(' > ')}`);
  const how = timeline.frames.find(f => f.kind === 'card' && f.card.title === 'HOW IT WORKS');
  assert(how?.kind === 'card' && how.card.lines.length === 4, 'the how-it-works card should carry the four short steps');
  assert(timeline.frames.slice(0, 5).every(f => f.kind === 'card' && f.alpha < 1), 'cards should fade in');
  assert(timeline.frames.some(f => f.kind === 'board' && (f.fresh?.length ?? 0) > 0), 'freshly placed cells should be flagged for highlighting');
  const slowLatency = events.map(e => (e.type === 'turn' ? { ...e, latencyMs: 90_000 } : e));
  assert(buildTimeline(slowLatency).totalMs === timeline.totalMs, 'video length must not depend on how long the models really took');
  assert(timeline.totalMs < 4 * 60_000, `a full match should be well under 4 minutes, got ${(timeline.totalMs / 1000).toFixed(0)}s`);
});

test('replay: a tampered log is detected instead of silently replayed', async () => {
  const { events } = await recordMatch(scriptedClient('fake/a'), 'baseline');
  const tampered = events.map(e => (e.type === 'round_resolved' && e.round === 1 ? { ...e, p1HeartHp: 1 } : e));
  assert(buildTimeline(tampered).warnings.length > 0, 'a mismatching round result must produce a warning');
});

test('replay: a log with no match_start is rejected clearly', () => {
  let message = '';
  try {
    buildTimeline([{ type: 'turn' }]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.includes('match_start'), 'expected a clear error about the missing match_start');
});


// ---------- Studio server ----------

async function withStudio(
  run: (base: string) => Promise<void>,
  slowMs = 0,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
  const handle = await startStudio({
    port: 0,
    distDir: join(dir, 'dist'),
    logDir: join(dir, 'logs'),
    videoDir: join(dir, 'videos'),
    simDelayMs: 0,
    quiet: true,
    controllerFactory: (p1Key, p2Key) => {
      const slow = (c: LLMClient): LLMClient => ({
        provider: c.provider,
        modelId: c.modelId,
        getAction: async (...args) => {
          if (slowMs) await new Promise(r => setTimeout(r, slowMs));
          return c.getAction(...args);
        },
      });
      return { p1: slow(scriptedClient(p1Key)), p2: p2Key ? slow(scriptedClient(p2Key)) : 'baseline' };
    },
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    handle.close();
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('studio: config lists models with key availability and the presets', async () => {
  await withStudio(async base => {
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as {
      models: { key: string; hasKey: boolean }[];
      presets: { key: string }[];
      defaults: { preset: string };
    };
    assert(cfg.models.length > 0 && cfg.models.every(m => typeof m.hasKey === 'boolean'), 'models should report key availability');
    assert(cfg.presets.some(p => p.key === 'skirmish') && cfg.defaults.preset === 'skirmish', 'presets and default expected');
  });
});

test('studio: starts a match, lists it, serves its log and live feed, and refuses a second concurrent match', async () => {
  await withStudio(async base => {
    const post = (body: unknown) =>
      fetch(`${base}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const started = await post({ p1: 'model-a', p2: 'model-b', preset: 'skirmish', roundPauseSec: 0 });
    assert(started.status === 201, `expected 201, got ${started.status}`);
    const { id } = (await started.json()) as { id: string };

    const second = await post({ p1: 'model-a', p2: 'baseline', preset: 'skirmish', roundPauseSec: 0 });
    assert(second.status === 409, 'a second match while one is running must be refused (409)');

    type Summary = { id: string; status: string; winner: string | null; rounds: number; p1: string; p2: string };
    const list = async () => ((await (await fetch(`${base}/api/matches`)).json()) as { matches: Summary[] }).matches;
    await waitFor(async () => (await list()).find(m => m.id === id)?.status === 'finished', 'the match to finish');

    const summary = (await list()).find(m => m.id === id)!;
    assert(summary.rounds === 8 && summary.p1.includes('model-a') && summary.p2.includes('model-b'), 'summary should describe the match');

    const log = await (await fetch(`${base}/api/matches/${id}/log`)).text();
    assert(buildTimeline(parseJsonl(log)).warnings.length === 0, 'the served log must replay cleanly');

    const abort = new AbortController();
    const live = await fetch(`${base}/api/live/events`, { signal: abort.signal });
    const reader = live.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    assert(first.includes('match_start'), 'late viewers should get the replayed event history');
  }, 25);
});

test('studio: a custom number of rounds is honoured, logged, and replays with the right length', async () => {
  await withStudio(async base => {
    const post = (body: unknown) =>
      fetch(`${base}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const started = await post({ p1: 'model-a', p2: 'baseline', preset: 'skirmish', roundPauseSec: 0, maxRounds: 2 });
    assert(started.status === 201, `expected 201, got ${started.status}`);
    const { id } = (await started.json()) as { id: string };
    type Summary = { id: string; status: string; rounds: number };
    const get = async () => ((await (await fetch(`${base}/api/matches`)).json()) as { matches: Summary[] }).matches.find(m => m.id === id);
    await waitFor(async () => (await get())?.status === 'finished', 'the 2-round match to finish');
    assert((await get())?.rounds === 2, 'the match must stop after 2 rounds');

    const events = parseJsonl(await (await fetch(`${base}/api/matches/${id}/log`)).text());
    assert(events.find(e => e.type === 'match_start')?.maxRounds === 2, 'match_start must record the round count');
    assert(events.filter(e => e.type === 'round_start').length === 2, 'exactly two rounds should have been played');
    const timeline = buildTimeline(events);
    assert(timeline.maxRounds === 2 && timeline.warnings.length === 0, 'the replay must use the logged round count and match the log');

    const cfg = (await (await fetch(`${base}/api/config`)).json()) as { limits: { maxRounds: number } };
    assert(cfg.limits.maxRounds >= 8, 'the config should tell the UI the upper limit');
  });
});

test('studio: an invalid round count is a clear 400', async () => {
  await withStudio(async base => {
    for (const bad of [0, -3, 2.5, 31, 'many']) {
      const res = await fetch(`${base}/api/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p1: 'model-a', p2: 'baseline', preset: 'skirmish', maxRounds: bad }),
      });
      const body = (await res.json()) as { error: string };
      assert(res.status === 400 && body.error.includes('maxRounds'), `maxRounds=${String(bad)} should be a 400 naming the field, got ${res.status}`);
    }
  });
});

test('studio: rejects bad requests clearly', async () => {
  await withStudio(async base => {
    const post = (body: unknown) =>
      fetch(`${base}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const badPreset = await post({ p1: 'model-a', p2: 'baseline', preset: 'nope' });
    assert(badPreset.status === 400, 'unknown preset must be a 400');
    const badPause = await post({ p1: 'model-a', p2: 'baseline', preset: 'skirmish', roundPauseSec: 9999 });
    assert(badPause.status === 400, 'absurd pause must be a 400');
    const unknownExport = await fetch(`${base}/api/matches/does-not-exist/export`, { method: 'POST' });
    assert(unknownExport.status === 404, 'exporting an unknown match must be a 404');
    const noVideo = await fetch(`${base}/api/matches/does-not-exist/video`);
    assert(noVideo.status === 404, 'a missing video must be a 404');
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert(traversal.status === 404, 'path traversal must not escape the dist dir');
  });
});

test('studio: starting with a model whose API key is missing explains what to add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
  const handle = await startStudio({ port: 0, distDir: join(dir, 'dist'), logDir: join(dir, 'logs'), videoDir: join(dir, 'videos') });
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const groq = MODEL_REGISTRY.find(m => m.provider === 'groq')!;
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p1: groq.key, p2: 'baseline', preset: 'skirmish' }),
    });
    const body = (await res.json()) as { error: string };
    assert(res.status === 400 && body.error.includes('GROQ_API_KEY'), `expected a clear missing-key error, got ${res.status} ${body.error}`);
  } finally {
    if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    handle.close();
  }
});


// ---------- Blueprints and batched placement ----------

function heartedGame(): { state: GameState; book: BlueprintBook; zone: { x: number; y: number } } {
  const state = new GameState('skirmish');
  const book = new BlueprintBook();
  const zone = state.layout.p1Build;
  assert(applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 1, zone.y + 15], preset: 'Heart' }, book).ok, 'heart placement');
  return { state, book, zone };
}

test('blueprints: save rules (names, reserved words, shape limits, cap, replacement, normalisation)', () => {
  const book = new BlueprintBook();
  assert(book.save('Wall', [[0, 0], [1, 0], [2, 0]]).ok, 'a valid blueprint should save');
  for (const bad of ['1wall', 'has space', '', 'x'.repeat(25), 'glider', 'GLIDER', 'Heart', 'custom']) {
    assert(!book.save(bad, [[0, 0]]).ok, `name "${bad}" should be rejected`);
  }
  assert(!book.save('Empty', []).ok && !book.save('Floaty', [[0.5, 1]]).ok, 'empty and non-integer shapes are rejected');
  assert(!book.save('Wide', [[0, 0], [12, 0]]).ok, 'wider than 12 is rejected');
  assert(!book.save('Huge', Array.from({ length: 41 }, (_, i) => [i % 10, Math.floor(i / 10)])).ok, 'more than 40 cells is rejected');
  assert(book.save('Off', [[5, 5], [6, 5]]).ok, 'offset shapes save');
  assert(JSON.stringify(book.list().find(b => b.name === 'Off')?.cells) === '[[0,0],[1,0]]', 'shapes are normalised to their top-left');
  for (let i = 0; i < MAX_BLUEPRINTS; i++) book.save(`B${i}`, [[0, 0]]);
  const full = book.save('OneTooMany', [[0, 0]]);
  assert(!full.ok && full.error.includes(String(MAX_BLUEPRINTS)), 'a full book must refuse a new name');
  assert(book.save('b0', [[0, 0], [1, 1]]).ok && book.list().find(b => b.name.toLowerCase() === 'b0')?.cost === 2, 'saving under an existing name (any case) replaces it');
});

test('blueprints: deploying costs exactly its live cells, supports rotation, and respects the heart-first rule', () => {
  const { state, book, zone } = heartedGame();
  assert(applyBenchAction(state, 1, { action: 'save_blueprint', name: 'Wedge', cells: [[0, 0], [1, 0], [0, 1]] }, book).ok, 'save');
  const movesBefore = state.players[0].movesLeft;
  const placed = applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 6, zone.y + 4], preset: 'Wedge' }, book);
  assert(placed.ok && state.players[0].movesLeft === movesBefore - 3, `deploy should cost its 3 live cells, got ${movesBefore - state.players[0].movesLeft}`);
  const rotated = applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 6, zone.y + 10], preset: 'wedge', rotation: 1 }, book);
  assert(rotated.ok && state.players[0].movesLeft === movesBefore - 6, 'a rotated deploy (any name case) costs the same');
  const unknown = applyBenchAction(state, 1, { action: 'place', anchor: [zone.x + 6, zone.y + 20], preset: 'Nope' }, book);
  assert(!unknown.ok && unknown.error!.includes('blueprint'), 'unknown names should mention blueprints');

  const fresh = new GameState('skirmish');
  const freshBook = new BlueprintBook();
  freshBook.save('Early', [[0, 0]]);
  assert(!applyBenchAction(fresh, 1, { action: 'place', anchor: [1, 1], preset: 'Early' }, freshBook).ok, 'blueprints cannot skip the heart-first rule');
});

test('observation: shows the player\'s saved blueprints (the model has no memory between calls)', () => {
  const { state, book } = heartedGame();
  book.save('Wedge', [[0, 0], [1, 0], [0, 1]]);
  const obs = serializeObservation(state, 1, book);
  assert(obs.you.blueprints.length === 1 && obs.you.blueprints[0].cost === 3, 'the blueprint and its cost must be visible');
  assert(obs.you.blueprints[0].cells.length === 3, 'its cells must be visible so the model can recall it');
  assert(serializeObservation(state, 2, new BlueprintBook()).you.blueprints.length === 0, 'the opponent must not see them');
});

test('tools: place_many, save_blueprint and end_turn parse; oversize and empty batches are refused', () => {
  const many = toolCallToActions('place_many', {
    placements: [{ anchor: [1, 2], preset: 'Glider' }, { anchor: [5, 6], cells: [[0, 0], [1, 0]] }],
    end_turn: true,
  });
  assert(many.length === 3 && many[2].action === 'submit', 'two placements plus an end-of-turn submit expected');
  assert(toolCallToActions('place_many', { placements: [{ anchor: [1, 2], preset: 'Glider' }] }).length === 1, 'no submit without end_turn');
  const save = toolCallToActions('save_blueprint', { name: 'Wall', cells: [['0', '0'], [1, 0]] })[0];
  assert(save.action === 'save_blueprint' && save.cells[0][0] === 0, 'save_blueprint should coerce and parse');
  const tooMany = Array.from({ length: MAX_BATCH + 1 }, () => ({ anchor: [1, 1], preset: 'Block' }));
  for (const bad of [{ placements: tooMany }, { placements: [] }, {}]) {
    let threw = false;
    try {
      toolCallToActions('place_many', bad as Record<string, unknown>);
    } catch {
      threw = true;
    }
    assert(threw, 'a bad batch must throw so it is treated as an unusable response');
  }
  assert(['place', 'save_blueprint', 'end_turn'].every(n => TOOL_DEFS.some(t => t.name === n)), 'all three tools must be offered');
  assert(/- place:/.test(SYSTEM_PROMPT) && /save_blueprint/.test(SYSTEM_PROMPT) && /end_turn/.test(SYSTEM_PROMPT), 'the prompt must explain the tools');
});

test('loop: a place_many call applies every placement, logs each, and counts as one call', async () => {
  const { state, book, zone } = heartedGame();
  const seen: (string | undefined)[] = [];
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/batch',
    async getAction(_obs, _presets, previousRejection): Promise<LLMCallResult> {
      seen.push(previousRejection);
      if (seen.length === 1) {
        return {
          actions: [
            { action: 'place', anchor: [zone.x + 6, zone.y + 4], preset: 'Glider' },
            { action: 'place', anchor: [zone.x + 40, zone.y + 4], preset: 'Glider' },
            { action: 'place', anchor: [zone.x + 6, zone.y + 10], preset: 'Glider' },
          ],
          rationale: 'three lanes at once',
          latencyMs: 900,
        };
      }
      return { actions: [{ action: 'place', anchor: [zone.x + 6, zone.y + 16], preset: 'Block' }, { action: 'submit' }], latencyMs: 400 };
    },
  };
  const events: LogEvent[] = [];
  await runLLMBuildPhase(state, 1, client, { log: e => events.push({ ...e, type: String(e.type) }) }, undefined, book);

  assert(seen.length === 2, `two calls expected, got ${seen.length}`);
  assert(seen[1]?.includes('outside') || seen[1]?.includes('zone'), 'the failed placement must be reported back, with its action');
  const turns = events.filter(e => e.type === 'turn');
  assert(turns.length === 5, `every placement is logged on its own, got ${turns.length}`);
  assert(turns[0].batchIndex === 0 && turns[2].batchIndex === 2 && turns[0].batchSize === 3, 'batch position must be logged');
  assert(turns[0].latencyMs === 900 && turns[1].latencyMs === 0 && turns[1].observation === undefined, 'call-level data is stored once');
  assert(state.players[0].committed && state.players[0].movesLeft === 30 - 5 - 5 - 4, 'two gliders and a block placed, then the turn ended');
});

test('replay: blueprints and batched calls replay to exactly the logged result', async () => {
  const batchClient = (modelId: string): LLMClient => ({
    provider: 'fake',
    modelId,
    async getAction(obs): Promise<LLMCallResult> {
      const z = obs.you.buildZone;
      if (obs.you.heartZone === null) return { actions: [{ action: 'place', anchor: [z.x + 1, z.y + 16], preset: 'Heart' }], latencyMs: 1 };
      if (obs.you.blueprints.length === 0) {
        return { actions: [{ action: 'save_blueprint', name: 'Wedge', cells: [[0, 0], [1, 0], [0, 1]] }], rationale: 'save a cheap attacker', latencyMs: 1 };
      }
      if (obs.you.movesLeft >= 6) {
        const y = z.y + 3 + (obs.you.movesLeft % 6) * 5;
        return {
          actions: [
            { action: 'place', anchor: [z.x + z.w - 4, y], preset: 'Wedge', rotation: 0 },
            { action: 'place', anchor: [z.x + 2, y + 2], preset: 'Wedge', rotation: 1 },
          ],
          rationale: 'two wedges in one call',
          latencyMs: 1,
        };
      }
      return { actions: [{ action: 'submit' }], latencyMs: 1 };
    },
  });
  const { events } = await recordMatch(batchClient('fake/a'), batchClient('fake/b'));
  assert(events.some(e => e.type === 'turn' && (e.action as { action: string }).action === 'save_blueprint'), 'the log must contain the save');
  assert(events.some(e => e.type === 'turn' && e.batchSize === 2), 'the log must contain batched placements');
  const timeline = buildTimeline(events);
  assert(timeline.warnings.length === 0, `replay diverged: ${timeline.warnings.join(' | ')}`);
  assert(timeline.frames.some(f => f.kind === 'board' && f.captions?.some(c => c.action.startsWith('save blueprint'))), 'saves should appear as captions');
});


// ---------- Clear instructions: pattern facts, rejection reasons, observation, size ----------

/** Minimal B3/S23 on an unbounded board, for checking what presets really do. */
function simulate(cells: [number, number][], generations: number): { cells: Set<string>; at: (g: number) => Set<string> } {
  const snaps = new Map<number, Set<string>>();
  let live = new Set(cells.map(([x, y]) => `${x},${y}`));
  snaps.set(0, live);
  for (let g = 1; g <= generations; g++) {
    const counts = new Map<string, number>();
    for (const k of live) {
      const [x, y] = k.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) counts.set(`${x + dx},${y + dy}`, (counts.get(`${x + dx},${y + dy}`) ?? 0) + 1);
    }
    const next = new Set<string>();
    for (const [k, c] of counts) if (c === 3 || (c === 2 && live.has(k))) next.add(k);
    live = next;
    snaps.set(g, live);
  }
  return { cells: live, at: g => snaps.get(g) ?? new Set() };
}

const centre = (s: Set<string>): [number, number] => {
  let sx = 0;
  let sy = 0;
  for (const k of s) {
    const [x, y] = k.split(',').map(Number);
    sx += x;
    sy += y;
  }
  return [sx / s.size, sy / s.size];
};

test('patterns: every preset does what the prompt table claims (checked by simulation)', () => {
  const place = (name: string, rot = 0) => rotatePattern(PATTERNS.find(p => p.name === name)!, rot).cells.map(([x, y]) => [x + 50, y + 50] as [number, number]);
  for (const name of ['Block', 'Beehive', 'Boat', 'Ship', 'Tub']) {
    const start = new Set(place(name).map(([x, y]) => `${x},${y}`));
    const end = simulate(place(name), 160).cells;
    assert(end.size === start.size && [...end].every(k => start.has(k)), `${name} must be a still life`);
  }
  for (const [name, n] of [['Blinker', 3], ['Toad', 6], ['Beacon', 6]] as const) {
    const sim = simulate(place(name), 160);
    const [x0, y0] = centre(sim.at(0));
    const [x1, y1] = centre(sim.at(160));
    assert(sim.cells.size === n && Math.abs(x1 - x0) < 1 && Math.abs(y1 - y0) < 1, `${name} must oscillate in place`);
  }
  const headings: [string, number, number, number][] = [
    ['Glider', 0, 10, 10], ['Glider', 1, -10, 10], ['Glider', 2, -10, -10], ['Glider', 3, 10, -10],
    ['LWSS', 0, 20, 0], ['LWSS', 1, 0, 20], ['LWSS', 2, -20, 0], ['LWSS', 3, 0, -20],
    ['MWSS', 0, 20, 0], ['MWSS', 1, 0, 20], ['MWSS', 2, -20, 0], ['MWSS', 3, 0, -20],
    ['HWSS', 0, 20, 0], ['HWSS', 1, 0, 20], ['HWSS', 2, -20, 0], ['HWSS', 3, 0, -20],
  ];
  for (const [name, rot, dx, dy] of headings) {
    const sim = simulate(place(name, rot), 40);
    const [x0, y0] = centre(sim.at(0));
    const [x1, y1] = centre(sim.at(40));
    assert(Math.abs(x1 - x0 - dx) < 0.6 && Math.abs(y1 - y0 - dy) < 0.6, `${name} rotation ${rot} must move (${dx}, ${dy}) in 40 generations, moved (${(x1 - x0).toFixed(1)}, ${(y1 - y0).toFixed(1)})`);
  }
  assert(simulate(place('R-pentomino'), 160).cells.size > 150, 'R-pentomino must grow big');
  assert(simulate(place('Acorn'), 160).cells.size > 100, 'Acorn must grow big');
  assert(simulate(place('Pi-heptomino'), 160).cells.size > 80, 'Pi-heptomino must grow big');
  assert(simulate(place('Thunderbird'), 160).cells.size > 100, 'Thunderbird must grow big');
  const penta = simulate(place('Pentadecathlon'), 30);
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(k => b.has(k));
  assert(same(penta.at(0), penta.at(15)) && !same(penta.at(0), penta.at(5)), 'Pentadecathlon must have period 15');
  const diehard = simulate(place('Diehard'), 140);
  assert(diehard.at(120).size > 0 && diehard.at(140).size === 0, 'Diehard must die out around generation 130');
  for (const p of PATTERNS.filter(q => q.name !== 'Heart')) {
    assert(SYSTEM_PROMPT.includes(`- ${p.name}: ${p.cells.length} cells, ${p.width}x${p.height}`), `the prompt table must list ${p.name} with its real size`);
  }
  for (const line of ['rotation 0 moves down-right, 1 down-left, 2 up-left, 3 up-right', '0 moves right, 1 down, 2 left, 3 up']) {
    assert(SYSTEM_PROMPT.includes(line), `the prompt must state the headings: ${line}`);
  }
});

test('actions: rejections say exactly what is wrong and how to fix it', () => {
  const state = new GameState('skirmish');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 1, z.y + 15], preset: 'Heart' });
  const why = (a: Parameters<typeof applyBenchAction>[2]) => applyBenchAction(state, 1, a).error ?? 'accepted';

  const outside = why({ action: 'place', anchor: [z.x + z.w - 1, z.y + 4], preset: 'Glider' });
  assert(outside.includes('outside your buildZone') && outside.includes('x 0-13') && outside.includes('anchor x in 0..11'), `out-of-zone message lacks bounds/range: ${outside}`);
  assert(applyBenchAction(state, 1, { action: 'place', anchor: [4, 4], preset: 'Block' }).ok, 'setup block');
  const nothing = why({ action: 'place', anchor: [4, 4], preset: 'Block' });
  assert(nothing.includes('already alive'), `nothing-new message wrong: ${nothing}`);
  state.players[0].movesLeft = 2;
  const poor = why({ action: 'place', anchor: [8, 20], preset: 'Beehive' });
  assert(poor.includes('needs 6 moves') && poor.includes('only have 2'), `moves message lacks the numbers: ${poor}`);
  const heartAgain = why({ action: 'place', anchor: [8, 30], preset: 'Heart' });
  assert(heartAgain.includes('already placed'), `second heart message wrong: ${heartAgain}`);
  state.submitBuild(1);
  assert(why({ action: 'place', anchor: [8, 20], preset: 'Block' }).includes('already ended your turn'), 'committed message wrong');
});

test('observation: side, attack direction, intruders, raiders and the enemy heart box once seen', () => {
  const state = new GameState('skirmish');
  const z1 = state.layout.p1Build;
  const z2 = state.layout.p2Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z1.x + 1, z1.y + 15], preset: 'Heart' });
  applyBenchAction(state, 2, { action: 'place', anchor: [z2.x + 8, z2.y + 15], preset: 'Heart' });
  const o1 = serializeObservation(state, 1);
  const o2 = serializeObservation(state, 2);
  assert(o1.you.side === 'left' && o1.you.attackDirection === 'right' && o2.you.side === 'right' && o2.you.attackDirection === 'left', 'sides and attack directions');
  assert(o1.opponent.heartZone === null, 'round 1: the enemy heart is not known yet');

  state.grid.placeCell(z1.x + 3, z1.y + 3, 'p2', 0);
  state.grid.placeCell(z2.x + 2, z2.y + 2, 'p1', 0);
  const seen = serializeObservation(state, 1);
  assert(JSON.stringify(seen.you.intruders) === JSON.stringify([[z1.x + 3, z1.y + 3]]), 'enemy cells inside my zone must be reported as intruders');
  assert(o1.you.intruders.length === 0, 'no intruders before any arrive');

  state.players[0].commit();
  state.players[1].commit();
  state.startSimulation();
  state.advanceSimulation();
  state.resolve();
  state.nextRound();
  const round2 = serializeObservation(state, 1);
  assert(round2.opponent.heartZone?.x === z2.x + 8 && round2.opponent.heartZone.y === z2.y + 15, 'round 2: the enemy heart box is known');
});

test('baseline bot: plays its whole turn even when nobody is listening', () => {
  const state = new GameState('skirmish');
  runBaselineBotBuildPhase(state, 1);
  runBaselineBotBuildPhase(state, 2);
  assert(state.players.every(p => p.heartPlaced && p.committed), 'both bots should place their Heart and end their turn');
  assert(state.players.every(p => p.movesLeft < 5), 'and spend their budget');
  assert(state.startSimulation() !== null, 'the match can then start');
});

test('size: the prompt, tools and a busy observation stay within a token budget', () => {
  const fixed = SYSTEM_PROMPT.length + JSON.stringify(TOOL_DEFS).length;
  assert(fixed < 17_500, `prompt + tools are ${fixed} chars; keep them lean (about 4.4k tokens)`);
  const state = new GameState('skirmish');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 1, z.y + 15], preset: 'Heart' });
  for (let i = 0; i < 80; i++) state.grid.placeCell(14 + (i % 20), Math.floor(i / 20) * 8 + 2, i % 2 ? 'p1' : 'p2', 0);
  const busy = JSON.stringify(serializeObservation(state, 1)).length;
  assert(busy < 2_500, `a board with 80 battlefield cells serialises to ${busy} chars; it should stay compact`);
});


// ---------- Analysis step, thinking level, budget guidance ----------

test('tools: the place tool demands an analysis, and asks for it before the placements', () => {
  const place = TOOL_DEFS.find(t => t.name === 'place')!;
  assert(place.parameters.required?.[0] === 'analysis', 'analysis must be required, and listed first');
  assert(Object.keys(place.parameters.properties)[0] === 'analysis', 'analysis must come first in the schema so it is written before the placements');
  assert(!TOOL_DEFS.filter(t => t.name !== 'place').some(t => t.parameters.required?.includes('analysis')), 'other tools should not need an analysis');
  assert(extractAnalysis({ analysis: '  Target (41,18). LWSS keeps its row.  ' }) === 'Target (41,18). LWSS keeps its row.', 'analysis is trimmed');
  assert(extractAnalysis({}) === undefined && extractAnalysis({ analysis: '   ' }) === undefined, 'a missing analysis is tolerated, not an error');
  assert(extractAnalysis({ analysis: 'x'.repeat(9000) })?.length === 4000, 'a runaway analysis is capped');
});

test('aistudio: thinking level is sent only when a model asks for one', () => {
  const obs = serializeObservation(new GameState('quick'), 1);
  const none = buildGeminiBody(obs, []).generationConfig as Record<string, unknown>;
  assert(!('thinkingConfig' in none), 'no thinkingConfig by default');
  for (const level of ['minimal', 'low', 'medium', 'high'] as ThinkingLevel[]) {
    const cfg = buildGeminiBody(obs, [], undefined, level).generationConfig as { thinkingConfig: { thinkingLevel: string } };
    assert(cfg.thinkingConfig.thinkingLevel === level, `level ${level} must be passed through`);
  }
});

test('registry: thinking is only allowed where it is implemented, and the Gemini default is medium', () => {
  const lite = MODEL_REGISTRY.find(m => m.key === 'gemini-3.1-flash-lite');
  assert(lite?.thinking === 'medium', 'gemini-3.1-flash-lite should think at medium level');
  const saved = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'x';
  try {
    let threw = false;
    try {
      createClient({ key: 'x', provider: 'groq', modelId: 'm', nativeToolCalling: true, thinking: 'medium' });
    } catch (err) {
      threw = err instanceof Error && err.message.includes('thinking');
    }
    assert(threw, 'an unsupported provider must refuse a thinking setting instead of silently ignoring it');
  } finally {
    if (saved === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved;
  }
});

test('loop: analysis and thinking tokens are logged once per call, on its first action', async () => {
  const { state, book, zone } = heartedGame();
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/thinker',
    async getAction(): Promise<LLMCallResult> {
      return {
        actions: [
          { action: 'place', anchor: [zone.x + 6, zone.y + 4], preset: 'Block' },
          { action: 'place', anchor: [zone.x + 6, zone.y + 10], preset: 'Block' },
          { action: 'submit' },
        ],
        rationale: 'two walls',
        analysis: 'Target none; defence only; 8 of 30 moves.',
        thoughtTokens: 1234,
        latencyMs: 10,
      };
    },
  };
  const events: LogEvent[] = [];
  await runLLMBuildPhase(state, 1, client, { log: e => events.push({ ...e, type: String(e.type) }) }, undefined, book);
  const turns = events.filter(e => e.type === 'turn');
  assert(turns.length === 3, 'three actions logged');
  assert(turns[0].analysis === 'Target none; defence only; 8 of 30 moves.' && turns[0].thoughtTokens === 1234, 'the first action carries the analysis and thinking tokens');
  assert(turns[1].analysis === undefined && turns[2].thoughtTokens === undefined, 'later actions in the same call do not repeat them');
});

test('observation and prompt: board size, budget arithmetic and lane spacing are spelled out', () => {
  const state = new GameState('skirmish');
  const obs = serializeObservation(state, 1);
  assert(obs.board.width === 48 && obs.board.height === 40, 'the board size must be in the observation');
  assert(/board \(width, height\)/.test(SYSTEM_PROMPT), 'the prompt must list the board key');
  assert(/30 moves = 6 Gliders or 3 LWSS/.test(SYSTEM_PROMPT), 'the prompt must show the budget arithmetic');
  assert(/touch and merge/.test(SYSTEM_PROMPT), 'the prompt must warn about lanes that touch');
  assert(/Ending your turn with most of your moves unspent/.test(SYSTEM_PROMPT), 'the prompt must warn against ending early');
  assert(/Fill in "analysis" first/.test(SYSTEM_PROMPT), 'the prompt must tell the model to fill in analysis first');
});


test('replay: written analyses show as thinking frames before the placements, capped, frame-exact, and switchable', async () => {
  const thinker = (modelId: string): LLMClient => {
    let calls = 0;
    return {
      provider: 'fake',
      modelId,
      async getAction(obs): Promise<LLMCallResult> {
        calls++;
        const z = obs.you.buildZone;
        if (obs.you.heartZone === null) {
          return { actions: [{ action: 'place', anchor: [z.x + 1, z.y + 16], preset: 'Heart' }], analysis: 'Heart first: far from the enemy lanes.', rationale: 'heart', latencyMs: 1 };
        }
        if (obs.you.movesLeft >= 5) {
          return {
            actions: [{ action: 'place', anchor: [z.x + 6, z.y + 4 + (calls % 5) * 6], preset: 'Glider', rotation: 0 }],
            analysis: `Target the enemy heart. ${'Check the row at arrival, stay on the board. '.repeat(40)}`,
            rationale: `launch ${calls}`,
            latencyMs: 1,
          };
        }
        return { actions: [{ action: 'submit' }], latencyMs: 1 };
      },
    };
  };
  const { events } = await recordMatch(thinker('fake/a'), 'baseline');
  const timeline = buildTimeline(events);
  assert(timeline.warnings.length === 0, `replay diverged: ${timeline.warnings.join(' | ')}`);

  const analyses = timeline.frames.filter(f => f.kind === 'analysis');
  assert(analyses.length > 8, `expected an analysis frame per call, got ${analyses.length}`);
  const frameMs = 1000 / timeline.fps;
  for (const f of analyses) {
    if (f.kind !== 'analysis') continue;
    assert(f.text.length <= 800 && f.playerId === 1 && f.who === 'fake/a', 'analysis text is capped and attributed');
    const n = f.durationMs / frameMs;
    assert(Math.abs(n - Math.round(n)) < 1e-6, 'analysis frames must be whole output frames too');
  }
  assert(analyses.some(f => f.kind === 'analysis' && f.text.endsWith('…')), 'a very long analysis is truncated with an ellipsis');

  const firstAnalysis = timeline.frames.findIndex(f => f.kind === 'analysis');
  const nextBoardWithCaption = timeline.frames.findIndex((f, i) => i > firstAnalysis && f.kind === 'board' && (f.captions?.length ?? 0) > 0);
  assert(firstAnalysis >= 0 && firstAnalysis < nextBoardWithCaption, 'the thinking frame must come before the placements it explains');

  const off = buildTimeline(events, { showAnalysis: false });
  assert(!off.frames.some(f => f.kind === 'analysis') && off.warnings.length === 0, 'analysis frames can be switched off');
  assert(timeline.totalMs > off.totalMs, 'the analysis frames add video time');
  assert(timeline.totalMs < 7 * 60_000, `even with analysis the video should stay reasonable, got ${(timeline.totalMs / 1000).toFixed(0)}s`);
});


test('interactions: every gap rule in the prompt is true (checked by simulation)', () => {
  const at = (name: string, rot: number, ox: number, oy: number) => rotatePattern(PATTERNS.find(p => p.name === name)!, rot).cells.map(([x, y]) => [x + ox, y + oy] as [number, number]);
  const key = (c: [number, number][]) => c.map(([x, y]) => `${x},${y}`);
  const dims = (name: string, rot: number) => { const r = rotatePattern(PATTERNS.find(p => p.name === name)!, rot); return { w: r.width, h: r.height }; };
  const speed = (name: string) => (name === 'Glider' ? [0.25, 0.25] : [0.5, 0]);
  const gapTo = (mover: string, other: string, ox: number, oy: number, gens: number): number => {
    const m = dims(mover, 0), o = dims(other, 0), [vx, vy] = speed(mover);
    let best = 99;
    for (let t = 0; t <= gens; t++) {
      const mx = 30 + vx * t, my = 30 + vy * t;
      const gx = Math.max(ox - (mx + m.w), mx - (ox + o.w), 0), gy = Math.max(oy - (my + m.h), my - (oy + o.h), 0);
      best = Math.min(best, Math.max(gx, gy));
    }
    return best;
  };
  const survives = (mover: string, other: string, ox: number, oy: number, gens: number): boolean => {
    const end = simulate([...at(mover, 0, 30, 30), ...at(other, 0, ox, oy)], gens).cells;
    const [vx, vy] = speed(mover);
    const moved = at(mover, 0, 30 + Math.round(vx * gens), 30 + Math.round(vy * gens));
    return key(moved).every(k => end.has(k));
  };

  // Moving patterns: always fine at the stated gap, always destroyed when touching.
  for (const [mover, minGap] of [['Glider', GAP.glider], ['LWSS', GAP.spaceship], ['MWSS', GAP.spaceship], ['HWSS', GAP.spaceship]] as const) {
    for (const other of ['Block', 'Blinker', 'Boat']) {
      let checkedSafe = 0;
      let checkedTouching = 0;
      let destroyed = 0;
      for (let ox = 26; ox <= 80; ox += 1) {
        for (let oy = 14; oy <= 60; oy += 1) {
          const gap = gapTo(mover, other, ox, oy, 60);
          if (gap === minGap) {
            assert(survives(mover, other, ox, oy, 60), `${mover} must survive passing ${other} at gap ${minGap} (anchor ${ox},${oy})`);
            checkedSafe++;
          } else if (gap === 0 && ox > 36 && checkedTouching < 60) {
            if (!survives(mover, other, ox, oy, 60)) destroyed++;
            checkedTouching++;
          }
        }
      }
      assert(checkedSafe > 20 && checkedTouching > 20, `the ${mover}/${other} check must really have run (${checkedSafe}/${checkedTouching})`);
      assert(destroyed / checkedTouching > 0.8, `${mover} touching ${other} should almost always be destroyed (${destroyed}/${checkedTouching})`);
    }
  }

  // Stationary patterns: a gap of 3 never changes them.
  const stationary = ['Block', 'Beehive', 'Boat', 'Tub', 'Ship', 'Blinker', 'Toad', 'Beacon'];
  for (const a of stationary) {
    for (const b of stationary) {
      const A = dims(a, 0), B = dims(b, 0);
      for (let ox = -8; ox <= 10; ox++) {
        for (let oy = -8; oy <= 10; oy++) {
          const gap = Math.max(Math.max(ox - A.w, -ox - B.w, 0), Math.max(oy - A.h, -oy - B.h, 0));
          if (gap !== GAP.stationary) continue;
          const start = new Set([...key(at(a, 0, 40, 40)), ...key(at(b, 0, 40 + ox, 40 + oy))]);
          const end = simulate([...at(a, 0, 40, 40), ...at(b, 0, 40 + ox, 40 + oy)], 60).cells;
          assert(end.size === start.size && [...end].every(k => start.has(k)), `${a} and ${b} at gap ${GAP.stationary} must stay unchanged (offset ${ox},${oy})`);
        }
      }
    }
  }

  // Same-heading attackers side by side: anchors (height + 2) apart survive; closer ones interact.
  for (const [name, rows] of [['Glider', 5], ['LWSS', 6], ['MWSS', 7], ['HWSS', 7]] as const) {
    const h = dims(name, 0).h;
    assert(rows === h + GAP.parallelExtraRows, `${name}: the stated spacing ${rows} must equal height ${h} + ${GAP.parallelExtraRows}`);
    const n = at(name, 0, 0, 0).length * 2;
    const [vx, vy] = speed(name);
    const alive = (dy: number) => simulate([...at(name, 0, 40, 40), ...at(name, 0, 40, 40 + dy)], 40).cells.size === n;
    assert(alive(rows), `two ${name}s ${rows} rows apart must both survive`);
    assert(!alive(rows - 2) && !alive(0), `two ${name}s closer than that must interact`);
    assert(vx >= 0 && vy >= 0, 'sanity');
  }
  for (const phrase of ['at least 3 (a gap of 2 usually works', 'at least 2 empty squares between its whole path', 'at least 4 empty squares between their whole path', 'Walk each lane', 'Reason about the future']) {
    assert(SYSTEM_PROMPT.includes(phrase), `the prompt must contain: ${phrase}`);
  }
  assert(/INTERACTION CHECK/.test(JSON.stringify(TOOL_DEFS)), 'the analysis checklist must include the interaction check');
});


// ---------- Memory: notes + round history ----------

test('memory: notes replace each other, are trimmed and capped, and stay per seat', () => {
  const m = new MatchMemory();
  m.setNotes(1, '  lane 18 died to the guard  ');
  assert(m.view(1).notes === 'lane 18 died to the guard', 'notes are trimmed');
  m.setNotes(1, 'new plan');
  assert(m.view(1).notes === 'lane 18 died to the guard\n+ new plan', 'a later call in the same turn is appended, never erasing the earlier plan');
  m.closeRound(1, { p1HeartHp: 100, p2HeartHp: 100, p1Cells: 0, p2Cells: 0 });
  m.setNotes(1, 'next turn');
  assert(m.view(1).notes === 'next turn', "the first notes of a new turn replace last turn's");
  assert(m.view(2).notes === '', "one seat must never see the other's notes");
  m.setNotes(2, 'x'.repeat(5000));
  assert(m.view(2).notes.length === MAX_NOTES_CHARS, 'runaway notes are capped');
  m.setNotes(2, 'y'.repeat(5000));
  assert(m.view(2).notes.length <= MAX_TURN_NOTES_CHARS, 'the appended block is capped too');
});

test('memory: only successful actions are remembered, in a compact form', () => {
  assert(compactAction({ action: 'place', anchor: [9, 18], preset: 'LWSS', rotation: 0 }) === 'LWSS@9,18', 'rotation 0 is left out');
  assert(compactAction({ action: 'place', anchor: [3, 4], preset: 'Glider', rotation: 2 }) === 'Glider/r2@3,4', 'a rotation is shown');
  assert(compactAction({ action: 'place', anchor: [1, 2], cells: [[0, 0], [1, 0]] }) === 'custom(2)@1,2', 'custom shapes are summarised');
  assert(compactAction({ action: 'save_blueprint', name: 'Wedge', cells: [[0, 0]] }) === 'save:Wedge', 'saves are remembered by name');
  assert(compactAction({ action: 'submit' }) === null, 'ending a turn is not a placement');
  const m = new MatchMemory();
  m.recordAction(1, { action: 'place', anchor: [9, 18], preset: 'LWSS' }, { ok: true });
  m.recordAction(1, { action: 'place', anchor: [99, 99], preset: 'LWSS' }, { ok: false, error: 'outside' });
  m.closeRound(1, { p1HeartHp: 100, p2HeartHp: 100, p1Cells: 3, p2Cells: 4 });
  assert(JSON.stringify(m.view(1).history[0].yourPlacements) === '["LWSS@9,18"]', 'the rejected placement must not be remembered');
});

test('memory: round history shows each seat its own damage dealt and taken, then resets for the next round', () => {
  const m = new MatchMemory();
  m.recordAction(2, { action: 'place', anchor: [40, 5], preset: 'Glider' }, { ok: true });
  m.closeRound(1, { p1HeartHp: 80, p2HeartHp: 100, p1Cells: 10, p2Cells: 7 });
  m.closeRound(2, { p1HeartHp: 80, p2HeartHp: 55, p1Cells: 12, p2Cells: 9 });
  const p1 = m.view(1).history;
  const p2 = m.view(2).history;
  assert(p1[0].damageYouTook === 20 && p1[0].damageYouDealt === 0 && p1[0].yourHeartHp === 80, 'P1 took 20 in round 1');
  assert(p2[0].damageYouTook === 0 && p2[0].damageYouDealt === 20 && p2[0].enemyHeartHp === 80, 'the same 20 is damage P2 dealt');
  assert(p1[1].damageYouDealt === 45 && p1[1].damageYouTook === 0, 'round 2 damage is relative to the previous round, not to 100');
  assert(p1[1].yourCellsOnBattlefield === 12 && p1[1].enemyCellsOnBattlefield === 9, 'cell counts are from the viewer\'s side');
  assert(p2[0].yourPlacements.length === 1 && p2[1].yourPlacements.length === 0, 'placements are per round');
  for (let r = 3; r <= 12; r++) m.closeRound(r, { p1HeartHp: 80, p2HeartHp: 55, p1Cells: 0, p2Cells: 0 });
  assert(m.view(1).history.length === HISTORY_ROUNDS && m.view(1).history[HISTORY_ROUNDS - 1].round === 12, 'only the most recent rounds are shown');
});

test('tools: place requires notes, other tools do not, and extractNotes is tolerant', () => {
  const place = TOOL_DEFS.find(t => t.name === 'place')!;
  assert(place.parameters.required?.includes('notes'), 'place must require notes');
  assert(!TOOL_DEFS.filter(t => t.name !== 'place').some(t => t.parameters.required?.includes('notes')), 'other tools may offer notes but not require them');
  assert(TOOL_DEFS.find(t => t.name === 'end_turn')!.parameters.properties.notes !== undefined, 'a model that ends via end_turn can still save notes');
  assert(extractNotes({ notes: '  lane 18 failed  ' }) === 'lane 18 failed', 'notes are trimmed');
  assert(extractNotes({}) === undefined && extractNotes({ notes: ' ' }) === undefined, 'missing notes are tolerated');
  assert(extractNotes({ notes: 'x'.repeat(9000) })?.length === 800, 'a runaway note is capped');
  assert(/# MEMORY/.test(SYSTEM_PROMPT) && /memory\.notes/.test(SYSTEM_PROMPT) && /damageYouDealt/.test(SYSTEM_PROMPT), 'the prompt must explain the memory');
});

test('loop: notes written on one call are shown on the next, and are logged once', async () => {
  const { state, book, zone } = heartedGame();
  const memory = new MatchMemory();
  const seenNotes: string[] = [];
  let call = 0;
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/rememberer',
    async getAction(obs): Promise<LLMCallResult> {
      call++;
      seenNotes.push(obs.memory.notes);
      return call === 1
        ? { actions: [{ action: 'place', anchor: [zone.x + 6, zone.y + 4], preset: 'Glider' }, { action: 'place', anchor: [zone.x + 6, zone.y + 12], preset: 'Glider' }], notes: 'tried lanes 4 and 12', latencyMs: 1 }
        : { actions: [{ action: 'submit' }], notes: 'lanes 4 and 12 placed; submit', latencyMs: 1 };
    },
  };
  const events: LogEvent[] = [];
  await runLLMBuildPhase(state, 1, client, { log: e => events.push({ ...e, type: String(e.type) }) }, undefined, book, memory);
  assert(seenNotes[0] === '' && seenNotes[1] === 'tried lanes 4 and 12', `second call must see the first call's notes, saw ${JSON.stringify(seenNotes)}`);
  assert(memory.view(1).notes === 'tried lanes 4 and 12\n+ lanes 4 and 12 placed; submit', 'later notes are appended to the first call\'s plan');
  const turns = events.filter(e => e.type === 'turn');
  assert(turns[0].notes === 'tried lanes 4 and 12' && turns[1].notes === undefined, 'notes are logged on the first action of a call only');
});

test('match: round 2 sees what round 1 wrote and did; seats stay private; a new match starts empty', async () => {
  const seen: Record<number, { notes: string; history: { round: number; yourPlacements: string[] }[] }[]> = { 1: [], 2: [] };
  const spy = (modelId: string): LLMClient => {
    const base = scriptedClient(modelId);
    return {
      provider: 'fake',
      modelId,
      async getAction(obs, presets, rejection, hooks): Promise<LLMCallResult> {
        seen[obs.you.player].push({ notes: obs.memory.notes, history: obs.memory.history });
        const res = await base.getAction(obs, presets, rejection, hooks);
        return { ...res, notes: `${modelId} round ${obs.round} note` };
      },
    };
  };
  await recordMatch(spy('fake/a'), spy('fake/b'));
  const firstOfRound = (id: 1 | 2, round: number) => seen[id].find(s => s.history.length === round - 1)!;
  assert(seen[1][0].notes === '' && seen[1][0].history.length === 0, 'round 1 starts with an empty memory');
  const p1r2 = firstOfRound(1, 2);
  assert(p1r2.notes === 'fake/a round 1 note', `P1 must see its own round-1 note, saw "${p1r2.notes}"`);
  assert(p1r2.history[0].round === 1 && p1r2.history[0].yourPlacements.some(x => x.startsWith('Heart@')), 'and what it placed in round 1');
  assert(firstOfRound(2, 2).notes === 'fake/b round 1 note', 'P2 sees only its own note');
  assert(!JSON.stringify(seen[1]).includes('fake/b round'), "P1 must never see P2's notes");
  seen[1] = [];
  await recordMatch(spy('fake/a'), 'baseline', 1);
  assert(seen[1][0].notes === '' && seen[1][0].history.length === 0, 'a new match must start with no memory');
});


// ---------- clear tool, anchor ranges, prompt rules ----------

test('clear: removes only your own non-Heart cells in your zone, costs and refunds nothing', () => {
  const { state, zone } = heartedGame();
  const z2 = state.layout.p2Build;
  const addP1 = (x: number, y: number) => state.grid.placeCell(x, y, 'p1', 0);
  for (const [x, y] of [[8, 5], [9, 5], [8, 6], [9, 6]]) addP1(x, y); // a leftover block of mine
  state.grid.placeCell(10, 5, 'p2', 0); // an enemy cell sitting inside my zone
  addP1(20, 5); // my cell on the battlefield, outside my zone
  const heartCells = state.grid.countByOwner('p1') - 5;
  const movesBefore = state.players[0].movesLeft;

  const wide = applyBenchAction(state, 1, { action: 'clear', region: { x: 0, y: 0, w: 60, h: 40 } });
  assert(wide.ok, `clear should succeed: ${wide.error}`);
  assert(state.grid.getCell(8, 5)?.alive !== true && state.grid.getCell(9, 6)?.alive !== true, 'my leftover block is gone');
  assert(state.grid.getCell(10, 5)?.alive === true && state.grid.getCell(10, 5)?.owner === 'p2', 'enemy cells in my zone are never cleared');
  assert(state.grid.getCell(20, 5)?.alive === true, 'cells outside my zone are never cleared');
  assert(state.grid.countByOwner('p1') === heartCells + 1, 'the Heart cells (and only the battlefield cell) remain');
  assert(state.players[0].movesLeft === movesBefore, 'clear is free and gives no refund');
  assert(state.players[0].heartPlaced && zone.x === 0, 'the Heart is untouched');

  const again = applyBenchAction(state, 1, { action: 'clear', region: { x: 0, y: 0, w: 14, h: 40 } });
  assert(!again.ok && again.error!.includes('none of your own removable cells'), `nothing left to clear should say so: ${again.error}`);
  for (const bad of [{ x: 0, y: 0, w: 0, h: 5 }, { x: 0.5, y: 0, w: 3, h: 3 }, { x: 0, y: 0, w: -2, h: 3 }]) {
    assert(!applyBenchAction(state, 1, { action: 'clear', region: bad }).ok, `bad box ${JSON.stringify(bad)} must be refused`);
  }
  assert(!applyBenchAction(state, 1, { action: 'clear', region: { x: z2.x, y: 0, w: z2.w, h: 40 } }).ok, "the opponent's zone cannot be cleared");
  state.submitBuild(1);
  addP1(3, 30);
  assert(!applyBenchAction(state, 1, { action: 'clear', region: { x: 0, y: 28, w: 6, h: 5 } }).ok, 'no clearing after you ended your turn');
});

test('clear: the self-blocked LWSS lane from the real log is fixed by clearing first (through the real engine)', () => {
  const run = (withClear: boolean): { intact: boolean; blocked: boolean } => {
    const state = new GameState('skirmish');
    applyBenchAction(state, 1, { action: 'place', anchor: [0, 30], preset: 'Heart' });
    for (const [x, y] of [[7, 18], [8, 18], [6, 19], [9, 19], [7, 20], [8, 20]]) state.grid.placeCell(x, y, 'p1', 0); // the leftover beehive
    const actions: Parameters<typeof applyBenchAction>[2][] = [
      ...(withClear ? [{ action: 'clear' as const, region: { x: 4, y: 16, w: 8, h: 8 } }] : []),
      { action: 'place', anchor: [0, 18], preset: 'LWSS' },
      { action: 'submit' },
    ];
    for (const a of actions) applyBenchAction(state, 1, a);
    applyBenchAction(state, 2, { action: 'place', anchor: [state.layout.p2Build.x + 8, 30], preset: 'Heart' });
    state.submitBuild(2);
    state.startSimulation();
    for (let g = 0; g < 40; g++) state.advanceSimulation();
    const expected = rotatePattern(PATTERNS.find(p => p.name === 'LWSS')!, 0).cells.map(([x, y]) => [x + 20, y + 18]);
    const intact = expected.every(([x, y]) => state.grid.getCell(x, y)?.alive && state.grid.getCell(x, y)?.owner === 'p1');
    return { intact, blocked: !intact };
  };
  assert(run(false).blocked, 'without clearing, the leftover beehive must wreck the LWSS (the failure seen in the log)');
  assert(run(true).intact, 'after clearing the leftovers, the same LWSS must fly intact');
});

test('tools: clear_boxes are parsed before the placements, limited, and validated', () => {
  const acts = toolCallToActions('place', {
    clear_boxes: [{ x: 4, y: 16, w: 8, h: 8 }],
    placements: [{ anchor: [0, 18], preset: 'LWSS' }],
    end_turn: true,
  });
  assert(acts.length === 3 && acts[0].action === 'clear' && acts[1].action === 'place' && acts[2].action === 'submit', 'order must be clear, place, submit');
  assert(acts[0].action === 'clear' && acts[0].region.w === 8, 'the box is parsed');
  assert(toolCallToActions('place', { placements: [{ anchor: [0, 18], preset: 'Block' }] }).length === 1, 'clear_boxes is optional');
  for (const bad of [{ clear_boxes: 'everything', placements: [{ anchor: [0, 0], preset: 'Block' }] }, { clear_boxes: Array.from({ length: 5 }, () => ({ x: 0, y: 0, w: 1, h: 1 })), placements: [{ anchor: [0, 0], preset: 'Block' }] }]) {
    let threw = false;
    try {
      toolCallToActions('place', bad as Record<string, unknown>);
    } catch {
      threw = true;
    }
    assert(threw, 'a malformed or oversize clear_boxes list is an unusable response');
  }
  assert('clear_boxes' in TOOL_DEFS.find(t => t.name === 'place')!.parameters.properties, 'the place tool must offer clear_boxes');
});

test('observation: anchor ranges tell the model exactly where each pattern fits', () => {
  const state = new GameState('skirmish');
  const book = new BlueprintBook();
  book.save('Wedge', [[0, 0], [1, 0], [0, 1]]);
  const early = serializeObservation(state, 1, book).you.anchorRanges;
  assert(early.Heart !== undefined, 'the Heart is listed until it is placed');
  assert(JSON.stringify(early.Glider) === '{"x":[0,11],"y":[0,37]}', `Glider ranges wrong: ${JSON.stringify(early.Glider)}`);
  assert(JSON.stringify(early.LWSS) === '{"x":[0,9],"y":[0,36],"rot90":{"x":[0,10],"y":[0,35]}}', `LWSS ranges wrong (5 wide, 4 tall in a 14x40 zone): ${JSON.stringify(early.LWSS)}`);
  assert(early.Block.rot90 === undefined && early.Wedge !== undefined, 'square shapes have no rot90 entry, and blueprints are included');
  const right = serializeObservation(state, 2, book).you.anchorRanges;
  assert(right.Glider.x[0] === 34 && right.Glider.x[1] === 45, "the right-hand seat's ranges follow its own zone");
  applyBenchAction(state, 1, { action: 'place', anchor: [0, 18], preset: 'Heart' });
  assert(serializeObservation(state, 1, book).you.anchorRanges.Heart === undefined, 'the Heart disappears once placed');
  // Every number in the table must actually be accepted by the engine, and one step outside must be refused.
  for (const [name, r] of Object.entries(serializeObservation(state, 1).you.anchorRanges)) {
    if (name === 'Heart') continue;
    const probe = new GameState('skirmish');
    applyBenchAction(probe, 1, { action: 'place', anchor: [0, 18], preset: 'Heart' });
    probe.players[0].movesLeft = 99;
    assert(applyBenchAction(probe, 1, { action: 'place', anchor: [r.x[1], r.y[1]], preset: name }).ok, `${name} at its max anchor must be accepted`);
    assert(!applyBenchAction(probe, 1, { action: 'place', anchor: [r.x[1] + 1, r.y[1]], preset: name }).ok, `${name} one step further right must be refused`);
  }
});

test('prompt: it explains clear_boxes and anchorRanges and carries the discipline rules', () => {
  for (const phrase of ['clear_boxes', 'anchorRanges', 'Confusing your Heart with the enemy', 'whose own check failed', 'LESSON:', 'under about 250 words', 'Leftovers from earlier rounds persist', 'comes out INCOMPLETE', 'quote that pattern']) {
    assert(SYSTEM_PROMPT.includes(phrase) || JSON.stringify(TOOL_DEFS).includes(phrase), `the prompt/tools must contain: ${phrase}`);
  }
});

test('loop and replay: a clear-then-place call runs in one call, is remembered, and replays exactly', async () => {
  const sweeper = (id: string): LLMClient => {
    let first = true;
    return {
      provider: 'fake',
      modelId: id,
      async getAction(obs): Promise<LLMCallResult> {
        const z = obs.you.buildZone;
        if (obs.you.heartZone === null) return { actions: [{ action: 'place', anchor: [z.x + 1, z.y + 16], preset: 'Heart' }], latencyMs: 1 };
        if (obs.you.movesLeft >= 9) {
          const acts: BenchAction[] = [];
          if (obs.you.cells.length > 0) acts.push({ action: 'clear', region: { x: z.x, y: z.y, w: z.w, h: z.h } });
          acts.push({ action: 'place', anchor: [z.x + (z.x === 0 ? 0 : 8), z.y + 4 + (first ? 0 : 8)], preset: 'LWSS', rotation: z.x === 0 ? 0 : 2 });
          first = false;
          return { actions: acts, analysis: 'clear leftovers then launch', latencyMs: 1 };
        }
        return { actions: [{ action: 'submit' }], latencyMs: 1 };
      },
    };
  };
  const { events } = await recordMatch(sweeper('fake/a'), sweeper('fake/b'));
  assert(events.some(e => e.type === 'turn' && (e.action as { action: string }).action === 'clear' && (e.applyResult as { ok: boolean }).ok), 'a clear must really have been applied in the match');
  const timeline = buildTimeline(events);
  assert(timeline.warnings.length === 0, `replay diverged: ${timeline.warnings.join(' | ')}`);
  assert(timeline.frames.some(f => f.kind === 'board' && f.captions?.some(c => c.action.startsWith('clear own cells'))), 'clears appear as captions');
  assert(compactAction({ action: 'clear', region: { x: 1, y: 2, w: 3, h: 4 } }) === 'clear@1,2,3x4', 'clears are remembered compactly');
});


/** Two hearted players on the real skirmish board; P2's Heart sits where the log's baseline bot put it. */
function duelGame(): { state: GameState; memory: MatchMemory } {
  const state = new GameState('skirmish');
  const z1 = state.layout.p1Build;
  assert(applyBenchAction(state, 1, { action: 'place', anchor: [z1.x + 1, 2], preset: 'Heart' }).ok, 'p1 heart');
  assert(applyBenchAction(state, 2, { action: 'place', anchor: [41, 18], preset: 'Heart' }).ok, 'p2 heart');
  return { state, memory: new MatchMemory() };
}

function playAndReport(state: GameState, memory: MatchMemory): Record<1 | 2, string[]> {
  state.submitBuild(1);
  state.submitBuild(2);
  assert(state.startSimulation() !== null, 'simulation starts');
  while (state.simulation && state.simulation.generation < state.preset.generationsPerRound) state.advanceSimulation();
  const report = buildPostMortem({
    preGrid: state.previousRoundGrid!,
    generations: state.preset.generationsPerRound,
    cellMaxAge: state.preset.cellMaxAge,
    heartZones: { 1: state.players[0].heartZone, 2: state.players[1].heartZone },
    placements: memory.placementsThisRound(),
  });
  state.resolve();
  return report;
}

function placeRemembered(state: GameState, memory: MatchMemory, action: BenchAction): void {
  const result = applyBenchAction(state, 1, action);
  assert(result.ok, `placement should work: ${JSON.stringify(result)}`);
  memory.recordAction(1, action, result);
}

test('post-mortem: the replayed damage equals what the real round dealt, and a clean lane is reported as such', () => {
  const { state, memory } = duelGame();
  placeRemembered(state, memory, { action: 'place', anchor: [9, 20], preset: 'LWSS' });
  const report = playAndReport(state, memory);
  const dealt = 100 - state.players[1].heartHp;
  assert(dealt > 0, 'the unobstructed LWSS lane should hurt the Heart');
  assert(report[1][0] === `This round you dealt ${dealt} Heart damage and took 0.`, `summary must match the real damage, got: ${report[1][0]}`);
  const line = report[1].find(l => l.startsWith('#1 LWSS@9,20'));
  assert(line !== undefined && line.includes(`in the real round it contributed ${dealt}`), `placement line missing: ${report[1].join(' | ')}`);
  assert(!line!.includes('stopped it'), 'a clean lane must not claim interference');
  assert(report[1].some(l => l.includes('inside THEIR Heart box')), 'cells left inside their Heart box are reported');
  assert(report[2].some(l => l.includes('inside YOUR Heart box')) || report[2].some(l => l.includes('No enemy cell reached')), "the victim gets the other side of the story");
});

test('post-mortem: a placement stopped by your own leftovers is called out with the measured difference', () => {
  const { state, memory } = duelGame();
  placeRemembered(state, memory, { action: 'place', anchor: [2, 20], preset: 'LWSS' });
  placeRemembered(state, memory, { action: 'place', anchor: [9, 21], preset: 'Block' });
  const report = playAndReport(state, memory);
  const line = report[1].find(l => l.startsWith('#1 LWSS@2,20'));
  assert(line !== undefined, 'LWSS line exists');
  assert(line!.includes('alone it hits their Heart box') && line!.includes('in the real round it contributed 0') && line!.includes('stopped it'), `expected an interference verdict, got: ${line}`);
  assert(report[1].some(l => l.startsWith('#2 Block@9,21')), 'every placement gets a line');
});

test('post-mortem: a missed attacker is reported as never reaching their Heart box', () => {
  const { state, memory } = duelGame();
  placeRemembered(state, memory, { action: 'place', anchor: [9, 30], preset: 'LWSS' });
  const report = playAndReport(state, memory);
  const line = report[1].find(l => l.startsWith('#1 LWSS@9,30'))!;
  assert(line.includes('alone it deals 0 damage') && line.includes('never reached their Heart box'), line);
  assert(report[1][0].includes('dealt 0'), 'no damage dealt');
});

test('observation: your cells inside their zone are shown where they are now, with the ones inside their Heart box', () => {
  const { state, memory } = duelGame();
  state.visibility = 'semi-hidden';
  // Nothing is visible of their zone yet (no previous round), but your own cells always are.
  state.grid.placeCell(43, 20, 'p1', 0);
  state.grid.placeCell(44, 30, 'p1', 0);
  const first = serializeObservation(state, 1, undefined, memory);
  assert(JSON.stringify(first.opponent.yourCellsThere) === '[[43,20],[44,30]]', `own cells in their zone: ${JSON.stringify(first.opponent.yourCellsThere)}`);
  assert(first.opponent.heartZone === null && first.opponent.yourCellsInsideHeartBox.length === 0, 'the Heart box is unknown until seen');
  state.visibility = 'visible';
  const seen = serializeObservation(state, 1, undefined, memory);
  assert(JSON.stringify(seen.opponent.yourCellsInsideHeartBox) === '[[43,20]]', 'only the cell inside the box is listed there');
  const victim = serializeObservation(state, 2, undefined, memory);
  assert(JSON.stringify(victim.you.enemyCellsInsideHeartBox) === '[[43,20]]', 'the victim sees it as an enemy cell inside their Heart box');
});

test('memory: thisTurn lists what was placed so far, the report is shown, and both reset sensibly', () => {
  const m = new MatchMemory();
  m.recordAction(1, { action: 'place', anchor: [9, 18], preset: 'LWSS' }, { ok: true, placedCells: [[9, 18]] });
  m.recordAction(1, { action: 'place', anchor: [1, 1], preset: 'Block' }, { ok: false, error: 'no' });
  assert(JSON.stringify(m.view(1).thisTurn) === '["LWSS@9,18"]' && m.view(2).thisTurn.length === 0, 'only successful placements, per seat');
  m.setReport(1, ['fact']);
  m.closeRound(1, { p1HeartHp: 100, p2HeartHp: 100, p1Cells: 0, p2Cells: 0 });
  assert(m.view(1).thisTurn.length === 0 && m.view(1).lastRoundReport[0] === 'fact', 'a new turn starts empty but keeps the report');
  assert(m.placementsThisRound()[1].length === 0, 'placements for the post-mortem reset every round');
});

test('prompt: it teaches the causal review of last round and the report fields', () => {
  for (const phrase of ['lastRoundReport', 'REVIEW', 'CAUSE -> EFFECT', 'thisTurn', 'yourCellsInsideHeartBox', 'enemyCellsInsideHeartBox', 'appended']) {
    assert(SYSTEM_PROMPT.includes(phrase) || JSON.stringify(TOOL_DEFS).includes(phrase), `prompt/tools must mention ${phrase}`);
  }
});


async function main(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   - ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
