import { GameState } from '../../game/state';
import { applyBenchAction } from '../action';
import { AiStudioClient, buildGeminiBody } from '../llm/aistudio';
import type { ThinkingLevel } from '../llm/aistudio';
import type { BenchAction } from '../types';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AttemptFailure, LLMCallResult, LLMClient } from '../llm/types';
import { runLLMBuildPhase } from '../loop';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { computeLeaderboard, latestTournamentId, leaderboardResponse, listTournaments, loadResults, renderConsole, stratifiedResample, writeLeaderboardFiles } from '../leaderboard';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createEventHub } from '../spectator';
import { findChrome, findFfmpeg } from '../video/export';
import { parseRetryAfter } from '../llm/pricing';
import { resolveMaxUsd, runMatch, type PlayerController } from '../match';
import { buildSchedule, parseShard, runTournament, sanitizeKey, type TournamentRow } from '../tournament';
import { readChatCompletionStream } from '../llm/sse';
import { OpenAICompatibleClient } from '../llm/openaiCompatible';
import { startStudio } from '../studio/server';
import { MinIntervalLimiter } from '../llm/rateLimiter';
import { buildTimeline, parseJsonl, type LogEvent } from '../replay';
import { isFatalProviderError, ModelResponseError, ProviderRequestError, ProviderUnavailableError, QuotaExhaustedError } from '../llm/errors';
import { postJsonWithRetry } from '../llm/http';
import { createClient, getModelEntry, MODEL_REGISTRY, type ModelEntry } from '../llm/registry';
import { buildUserMessage, extractAnalysis, extractNotes, GAP, extractRationale, missingRequiredFields, SYSTEM_PROMPT, TOOL_DEFS, toolCallToAction, toolCallToActions } from '../llm/tools';
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
    assert(['openrouter', 'groq', 'aistudio', 'litellm'].includes(m.provider), `bad provider on "${m.key}"`);
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
  const envNames = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'LITELLM_API_KEY', 'LITELLM_BASE_URL'];
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
    process.env.LITELLM_API_KEY = 'x';
    process.env.LITELLM_BASE_URL = 'http://127.0.0.1:1';
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

async function captureLitellmRequest(entry: ModelEntry): Promise<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> {
  let captured: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> } | undefined;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      captured = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: 'end_turn', arguments: '{"rationale":"r"}' } }] } }],
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const saved = [process.env.LITELLM_API_KEY, process.env.LITELLM_BASE_URL];
  process.env.LITELLM_API_KEY = 'secret-key';
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${port}/`;
  try {
    const client = createClient(entry);
    await client.getAction(serializeObservation(new GameState('quick'), 1), ['Glider']);
  } finally {
    server.close();
    if (saved[0] === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = saved[1];
  }
  assert(captured !== undefined, 'server should have received a request');
  return captured;
}

const LITELLM_TEST_ENTRY: ModelEntry = {
  key: 'litellm-test', provider: 'litellm', modelId: 'some/model', nativeToolCalling: true, minIntervalMs: 0,
};

test('litellm: posts to {base}/v1/chat/completions with both auth headers', async () => {
  const req = await captureLitellmRequest(LITELLM_TEST_ENTRY);
  assert(req.url === '/v1/chat/completions', `unexpected path ${req.url}`);
  assert(req.headers.authorization === 'Bearer secret-key', 'Authorization bearer header missing');
  assert(req.headers['x-litellm-api-key'] === 'secret-key', 'x-litellm-api-key header missing');
  assert(req.body.model === 'some/model', 'model id should be sent as-is');
});

test('litellm: maxTokens is sent as max_tokens, and nothing is sent when unset', async () => {
  const capped = await captureLitellmRequest({ ...LITELLM_TEST_ENTRY, maxTokens: 1234 });
  assert(capped.body.max_tokens === 1234, 'expected max_tokens=1234');
  const none = await captureLitellmRequest(LITELLM_TEST_ENTRY);
  assert(!('max_tokens' in none.body), 'no cap unless configured');
});

test('litellm: extraBody is merged into the request body', async () => {
  const req = await captureLitellmRequest({ ...LITELLM_TEST_ENTRY, extraBody: { reasoning_effort: 'low', thinking: { type: 'disabled' } } });
  assert(req.body.reasoning_effort === 'low', 'expected reasoning_effort=low');
  assert((req.body.thinking as { type?: string }).type === 'disabled', 'expected thinking.type=disabled');
  assert(req.body.model === 'some/model', 'core fields preserved');
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

test('heart: damage per generation is capped at 5 cells (50 HP)', () => {
  const state = new GameState('skirmish');
  state.players[0].heartPlaced = true;
  state.players[0].heartZone = { x: 20, y: 5, w: 8, h: 2 };
  for (const x0 of [20, 23, 26]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) state.grid.placeCell(x0 + dx, 5 + dy, 'p2', 0);
  state.players[0].commit();
  state.players[1].commit();
  state.startSimulation();
  state.advanceSimulation();
  assert(state.players[0].heartHp === 50, `12 enemy cells in the zone must cost exactly 50 HP, got ${100 - state.players[0].heartHp}`);
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

test('http: an intermittent invalid_prompt 400 is retried as a bad response', async () => {
  await withServer(
    hit => (hit < 2 ? { status: 400, body: '{"error":{"message":"AzureException \\"code\\": \\"invalid_prompt\\""}}' } : { status: 200, body: '{"ok":1}' }),
    async (url, hits) => {
      const r = await postJsonWithRetry('t', url, {}, {}, j => j, undefined, { retryDelaysMs: [10] });
      assert(hits() === 2 && r.value !== undefined, 'invalid_prompt should be retried once');
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
      assert(hits() === 2, 'unusable responses get 2 attempts (original + one retry), not the full outage schedule');
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

test('loop: an unusable model response is skipped without another loop round (client already retried once)', async () => {
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
  assert(seen.length === 1, `no further calls after an unusable response, got ${seen.length}`);
  assert(state.players[0].committed && !state.players[0].heartPlaced, 'turn was skipped (force-submitted)');
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
    assert(summary.rounds >= 1 && summary.rounds <= 8 && summary.p1.includes('model-a') && summary.p2.includes('model-b'), 'summary should describe the match');

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
  assert(fixed < 18_500, `prompt + tools are ${fixed} chars; keep them lean (about 4.5k tokens)`);
  const state = new GameState('skirmish');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 1, z.y + 15], preset: 'Heart' });
  for (let i = 0; i < 80; i++) state.grid.placeCell(14 + (i % 20), Math.floor(i / 20) * 8 + 2, i % 2 ? 'p1' : 'p2', 0);
  const busy = JSON.stringify(serializeObservation(state, 1)).length;
  assert(busy < 2_500, `a board with 80 battlefield cells serialises to ${busy} chars; it should stay compact`);
});


// ---------- Analysis step, thinking level, budget guidance ----------

test('tools: the analysis description is the neutral per-attacker wording (Opus content_filter trigger removed)', () => {
  const place = TOOL_DEFS.find(t => t.name === 'place')!;
  const d = String((place.parameters.properties.analysis as { description?: string }).description);
  assert(d === 'Your brief per-attacker summary in under about 250 words: pattern, rotation, anchor, start cell, heading, and arrival generation.', d);
  assert(!/BEFORE|then verify|DECIDE/i.test(d), 'no plan-then-verify phrasing');
});

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
  assert(/divide your moves by a pattern's cell count/.test(SYSTEM_PROMPT), 'the prompt must show the budget arithmetic');
  assert(!/6 Gliders/.test(SYSTEM_PROMPT) && /AIM CHECK/.test(SYSTEM_PROMPT), 'the prompt must not push Gliders and must ask for an aim check');
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
  assert(/INTERACTION CHECK/.test(SYSTEM_PROMPT), 'the analysis checklist must include the interaction check');
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
  assert(!line!.includes('stopped by'), 'a clean lane must not claim interference');
  assert(!report[1].some(l => l.includes('keep dealing')), 'cells no longer linger in their Heart box');
  assert(report[2].some(l => l.includes('Enemy cells reached YOUR Heart box') && l.includes(`cost you ${dealt} HP`)), "the victim gets the other side of the story");
});

test('post-mortem: a placement stopped by your own leftovers is called out with the measured difference', () => {
  const { state, memory } = duelGame();
  placeRemembered(state, memory, { action: 'place', anchor: [2, 20], preset: 'LWSS' });
  placeRemembered(state, memory, { action: 'place', anchor: [9, 21], preset: 'Block' });
  const report = playAndReport(state, memory);
  const line = report[1].find(l => l.startsWith('#1 LWSS@2,20'));
  assert(line !== undefined, 'LWSS line exists');
  assert(line!.includes('alone it hits their Heart box') && line!.includes('in the real round it contributed 0') && line!.includes('stopped by your own other cells'), `expected an interference verdict, got: ${line}`);
  assert(report[1].some(l => l.startsWith('#2 Block@9,21')), 'every placement gets a line');
});

test('post-mortem: a missed attacker names the rows it travelled and the Heart rows it missed', () => {
  const { state, memory } = duelGame();
  placeRemembered(state, memory, { action: 'place', anchor: [9, 30], preset: 'LWSS' });
  const report = playAndReport(state, memory);
  const line = report[1].find(l => l.startsWith('#1 LWSS@9,30'))!;
  assert(line.includes('alone it deals 0 damage') && /no damage because its rows y \d+\.\.\d+ never overlap their Heart rows y 18\.\.21/.test(line), line);
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

// ---------- Leaderboard ----------

function lbRow(i: number, a: string, b: string, winner: 'a' | 'b' | 'draw' | 'void', extra: Partial<TournamentRow> = {}): TournamentRow {
  const p1 = i % 2 === 0 ? a : b;
  const p2 = i % 2 === 0 ? b : a;
  const isVoid = winner === 'void';
  const winnerModel = winner === 'a' ? a : winner === 'b' ? b : null;
  const seat = winnerModel === null ? null : winnerModel === p1 ? 'p1' : 'p2';
  return {
    index: i, tournamentId: 't1', preset: 'skirmish', a, b, p1, p2,
    winner: isVoid ? null : seat ?? 'draw', winnerModel, rounds: 3, p1HeartHp: 0, p2HeartHp: 0,
    margin: seat === 'p1' ? 10 : seat === 'p2' ? -10 : 0, void: isVoid,
    tokens: { p1: 100, p2: 200 }, invalidCalls: { p1: 1, p2: 0 }, autoSkips: { p1: 0, p2: 2 },
    logFile: 'bench-logs/tournaments/t1/match-' + i + '.jsonl', finishedAt: '2026-01-01T00:00:00Z', ...extra,
  };
}

function lbRows(a: string, b: string, n: number, winner: 'a' | 'b' | 'draw' | 'void'): TournamentRow[] {
  return Array.from({ length: n }, (_, i) => lbRow(i, a, b, winner));
}

const standing = (lb: ReturnType<typeof computeLeaderboard>, m: string) => lb.models.find(s => s.model === m)!;

test('leaderboard: a model that always wins outranks its victim, with finite ratings', () => {
  const lb = computeLeaderboard(lbRows('A', 'B', 10, 'a'));
  const a = standing(lb, 'A'), b = standing(lb, 'B');
  assert(a.rating! > b.rating! && a.rank === 1 && b.rank === 2, `A ${a.rating} B ${b.rating}`);
  assert(Number.isFinite(a.rating!) && Number.isFinite(b.rating!), 'finite despite 10-0');
  assert(a.wins === 10 && b.losses === 10 && a.winRate === 1, 'W/L counts');
});

test('leaderboard: symmetric draws give equal ratings', () => {
  const lb = computeLeaderboard(lbRows('A', 'B', 6, 'draw'));
  const a = standing(lb, 'A'), b = standing(lb, 'B');
  assert(Math.abs(a.rating! - b.rating!) < 1e-6 && a.draws === 6, `A ${a.rating} B ${b.rating}`);
  assert(Math.abs(a.rating! - 1000) < 1e-6, 'geometric-mean anchor puts an equal pair at 1000');
});

test('leaderboard: CI is wider with fewer games', () => {
  const mixed = (n: number) => Array.from({ length: n }, (_, i) => lbRow(i, 'A', 'B', i % 4 === 0 ? 'b' : 'a'));
  const width = (n: number) => { const a = standing(computeLeaderboard(mixed(n)), 'A'); return a.ciHigh! - a.ciLow!; };
  assert(width(8) > width(80), `8 games ${width(8)} vs 80 games ${width(80)}`);
});

test('leaderboard: baseline is anchored at exactly 1000', () => {
  const rows = [...lbRows('A', 'baseline', 6, 'a'), ...lbRows('B', 'baseline', 6, 'draw').map((r, i) => ({ ...r, index: 6 + i }))];
  const lb = computeLeaderboard(rows);
  assert(lb.anchor === 'baseline' && Math.abs(standing(lb, 'baseline').rating! - 1000) < 1e-9, 'baseline 1000');
  assert(standing(lb, 'A').rating! > standing(lb, 'B').rating!, 'A beat baseline, B drew it');
});

test('leaderboard: void rows count only in the void column', () => {
  const rows = [...lbRows('A', 'B', 4, 'a'), lbRow(4, 'A', 'B', 'void'), lbRow(5, 'A', 'B', 'void')];
  const lb = computeLeaderboard(rows);
  const a = standing(lb, 'A');
  assert(a.games === 4 && a.wins === 4 && a.voidGames === 2 && lb.voidMatches === 2 && lb.matches === 4, JSON.stringify(a));
  const same = computeLeaderboard(lbRows('A', 'B', 4, 'a'));
  assert(a.rating === standing(same, 'A').rating, 'void rows do not move ratings');
  const onlyVoid = computeLeaderboard([lbRow(0, 'A', 'B', 'void')]);
  assert(standing(onlyVoid, 'A').rating === null && standing(onlyVoid, 'A').voidGames === 1, 'all-void model is unrated');
});

test('leaderboard: per-model stats use the right seat, and output is deterministic for a seed', () => {
  const rows = lbRows('A', 'B', 4, 'a');
  const lb = computeLeaderboard(rows);
  const a = standing(lb, 'A'), b = standing(lb, 'B');
  // A is p1 on even indexes (tokens 100, invalid 1) and p2 on odd (tokens 200, skips 2).
  assert(a.avgTokensPerGame === 150 && a.invalidPerGame === 0.5 && a.autoSkipsPerGame === 1, JSON.stringify(a));
  assert(b.avgTokensPerGame === 150, 'B mirrors');
  assert(a.avgMargin !== null && a.avgMargin > 0 && b.avgMargin === -a.avgMargin, `margin ${a.avgMargin}`);
  assert(JSON.stringify(computeLeaderboard(rows, { seed: 7 })) === JSON.stringify(computeLeaderboard(rows, { seed: 7 })), 'same seed, same output');
  assert(JSON.stringify(computeLeaderboard(rows)) === JSON.stringify(lb), 'default seed is fixed');
});

test('leaderboard: files, latest tournament, and the studio endpoints', async () => {
  await withTempDir(async dir => {
    const write = (id: string, rows: TournamentRow[]) => {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, 'results.jsonl'), rows.map(r => JSON.stringify({ ...r, tournamentId: id, logFile: 'x/' + id + '/match-0.jsonl' })).join('\n') + '\n');
      writeFileSync(join(dir, id, 'match-0.jsonl'), '{"type":"match_start"}\n');
    };
    write('old', lbRows('A', 'B', 2, 'a'));
    utimesSync(join(dir, 'old', 'results.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    write('new', lbRows('A', 'B', 4, 'b'));
    assert(listTournaments(dir).map(t => t.id).join() === 'new,old' && listTournaments(dir)[0].matches === 4, 'newest first');
    assert(latestTournamentId(dir) === 'new' && latestTournamentId(join(dir, 'nope')) === null, 'latest');
    const resp = leaderboardResponse(null, dir);
    assert(resp.tournamentId === 'new' && resp.matchList.length === 4 && resp.matchList[0].logName === 'match-0.jsonl', 'response');
    let threw = false;
    try { loadResults('../old', dir); } catch { threw = true; }
    assert(threw, 'path traversal in id refused');

    const lb = computeLeaderboard(loadResults('new', dir));
    writeLeaderboardFiles(lb, dir);
    assert(JSON.parse(readFileSync(join(dir, 'new', 'leaderboard.json'), 'utf8')).models.length === 2, 'json written');
    assert(readFileSync(join(dir, 'new', 'leaderboard.md'), 'utf8').includes('| 1 | B |'), 'md written');
    assert(renderConsole(lb).includes('Rating (95% CI)'), 'console table');

    const handle = await startStudio({ port: 0, distDir: join(dir, 'dist'), logDir: join(dir, 'logs'), videoDir: join(dir, 'videos'), tournamentDir: dir, quiet: true });
    const base = 'http://127.0.0.1:' + handle.port;
    try {
      const list = (await (await fetch(base + '/api/tournaments')).json()) as { tournaments: { id: string }[] };
      assert(list.tournaments.length === 2, 'tournament list');
      const latest = (await (await fetch(base + '/api/leaderboard')).json()) as { tournamentId: string };
      assert(latest.tournamentId === 'new', 'no id = latest');
      const old = (await (await fetch(base + '/api/leaderboard?id=old')).json()) as { matches: number };
      assert(old.matches === 2, 'id selects');
      assert((await fetch(base + '/api/leaderboard?id=missing')).status === 404, 'unknown id is 404');
      assert((await fetch(base + '/api/leaderboard?id=..%2F..')).status === 404, 'traversal id is 404');
      const log = await fetch(base + '/api/tournaments/new/log/match-0.jsonl');
      assert(log.status === 200 && (await log.text()).includes('match_start'), 'log served');
      assert((await fetch(base + '/api/tournaments/new/log/results.json')).status === 404, 'non-jsonl refused');
      assert((await fetch(base + '/api/tournaments/new/log/..%2Fold%2Fresults.jsonl')).status === 404, 'traversal in file refused');
    } finally {
      handle.close();
    }
  });
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
// ---------- Tournament ----------

function tourneyFactory(clients: Record<string, LLMClient> = {}): (key: string) => PlayerController {
  return key => (key === 'baseline' ? 'baseline' : clients[key] ?? scriptedClient(key));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gameofdeath-tourney-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readRows(dir: string, id: string): TournamentRow[] {
  const text = readFileSync(join(dir, id, 'results.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as TournamentRow);
}

const QUICK = { preset: 'skirmish' as const, maxRounds: 2, roundPauseMs: 0, quiet: true };

function tokenClient(modelId: string, promptTokens: number, completionTokens: number, thoughtTokens?: number): LLMClient {
  const base = scriptedClient(modelId);
  return {
    provider: 'fake',
    modelId,
    async getAction(obs, presets, rejection, hooks) {
      const r = await base.getAction(obs, presets, rejection, hooks);
      return { ...r, promptTokens, completionTokens, thoughtTokens };
    },
  };
}

test('tournament: schedule covers all pairs, splits seats evenly, and is deterministic', () => {
  const s = buildSchedule(['x', 'y', 'baseline'], 4);
  assert(s.length === 12, `3 pairs x 4 games = 12, got ${s.length}`);
  assert(JSON.stringify(s) === JSON.stringify(buildSchedule(['x', 'y', 'baseline'], 4)), 'deterministic');
  assert(s.every((f, i) => f.index === i), 'indices are 0..n-1');
  for (const [a, b] of [['x', 'y'], ['x', 'baseline'], ['y', 'baseline']]) {
    const g = s.filter(f => f.a === a && f.b === b);
    assert(g.length === 4, `${a} vs ${b} plays 4`);
    assert(g.filter(f => f.p1 === a).length === 2 && g.filter(f => f.p1 === b).length === 2, 'two games per seat');
    assert(g.every(f => (f.p1 === a ? f.p2 === b : f.p1 === b && f.p2 === a)), 'p2 is the other model');
  }
  assert(buildSchedule(['x', 'y'], 3).length === 4, 'odd games forced up to even');
  assert(buildSchedule(['x', 'y'], 0).length === 2, 'at least one game per seat');
});

test('tournament: filename sanitizing removes slashes and odd characters', () => {
  const k = sanitizeKey('deepseek/v4:1 *x?');
  assert(/^[A-Za-z0-9._-]+$/.test(k) && !k.includes('/'), k);
});

test('match_end log row carries margin = p1HeartHp - p2HeartHp', async () => {
  const { events } = await recordMatch(scriptedClient('fake/a'), 'baseline', 1);
  const end = events.find(e => e.type === 'match_end') as unknown as { p1HeartHp: number; p2HeartHp: number; margin: number };
  assert(typeof end.margin === 'number' && end.margin === end.p1HeartHp - end.p2HeartHp, `margin ${end.margin}`);
});

test('tournament: results.jsonl rows match the schema and logs are written', async () => {
  await withTempDir(async dir => {
    const out = await runTournament({ ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 2, id: 't1', baseDir: dir, createController: tourneyFactory() });
    assert(out.rows.length === 2 && !out.stoppedForBudget, 'two matches played');
    const rows = readRows(dir, 't1');
    assert(rows.length === 2, 'two rows on disk');
    rows.forEach((r, i) => {
      assert(r.index === i && r.tournamentId === 't1' && r.preset === 'skirmish', 'index/id/preset');
      assert(r.a === 'fa' && r.b === 'baseline', 'pair in schedule order');
      assert(r.p1 === (i === 0 ? 'fa' : 'baseline') && r.p2 === (i === 0 ? 'baseline' : 'fa'), 'seat swap');
      assert(['p1', 'p2', 'draw'].includes(String(r.winner)), 'winner value');
      const expected = r.winner === 'p1' ? r.p1 : r.winner === 'p2' ? r.p2 : null;
      assert(r.winnerModel === expected, 'winnerModel matches winner');
      assert(r.margin === r.p1HeartHp - r.p2HeartHp && r.rounds >= 1 && r.void === false, 'margin/rounds/void');
      assert(typeof r.tokens.p1 === 'number' && typeof r.invalidCalls.p2 === 'number' && typeof r.autoSkips.p1 === 'number', 'counters');
      assert(!Number.isNaN(Date.parse(r.finishedAt)), 'finishedAt ISO');
      assert(existsSync(resolve(process.cwd(), r.logFile)), `log file exists: ${r.logFile}`);
      assert(!r.logFile.includes('\\') || /^[A-Za-z]:/.test(r.logFile), 'forward slashes');
    });
  });
});

test('tournament: tokens, invalid calls and auto-skips come from the match log', async () => {
  await withTempDir(async dir => {
    await runTournament({ ...QUICK, models: ['tok', 'baseline'], gamesPerPair: 2, id: 't', baseDir: dir, createController: tourneyFactory({ tok: tokenClient('tok', 100, 10, 5) }) });
    const [r0, r1] = readRows(dir, 't');
    assert(r0.tokens.p1 > 0 && r0.tokens.p1 % 115 === 0 && r0.tokens.p2 === 0, `seat p1 tokens ${r0.tokens.p1}/${r0.tokens.p2}`);
    assert(r1.tokens.p2 > 0 && r1.tokens.p1 === 0, 'tokens follow the model across the seat swap');
  });
});

test('tournament: resume skips indices already in results.jsonl', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 4, id: 'r', baseDir: dir, createController: tourneyFactory() };
    await runTournament({ ...base, maxMatches: 2 });
    assert(readRows(dir, 'r').length === 2, 'first run stopped after 2');
    const out = await runTournament(base);
    assert(out.skipped === 2 && out.rows.length === 2, `second run skips 2, plays 2: skipped=${out.skipped} ran=${out.rows.length}`);
    const rows = readRows(dir, 'r');
    assert(rows.map(r => r.index).join() === '0,1,2,3', `indices ${rows.map(r => r.index).join()}`);
  });
});

test('tournament: token budget stops cleanly before the next match, counting resumed rows', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['tok', 'baseline'], gamesPerPair: 4, id: 'b', baseDir: dir, createController: tourneyFactory({ tok: tokenClient('tok', 1000, 0) }) };
    const first = await runTournament({ ...base, tokenBudget: 1 });
    assert(first.rows.length === 1 && first.stoppedForBudget, 'budget 1: first match runs, then stop');
    const second = await runTournament({ ...base, tokenBudget: 1 });
    assert(second.rows.length === 0 && second.stoppedForBudget && second.skipped === 1, 'resumed rows count toward budget');
    const third = await runTournament(base);
    assert(!third.stoppedForBudget && readRows(dir, 'b').length === 4, 'no budget: finishes');
  });
});

test('tournament: a client error writes a void row and the tournament continues', async () => {
  const boom: LLMClient = { provider: 'fake', modelId: 'boom', async getAction() { throw new Error('kaput'); } };
  const down: LLMClient = { provider: 'fake', modelId: 'down', async getAction() { throw new ProviderUnavailableError('down for good'); } };
  await withTempDir(async dir => {
    const out = await runTournament({ ...QUICK, models: ['boom', 'baseline', 'down'], gamesPerPair: 2, id: 'v', baseDir: dir, createController: tourneyFactory({ boom, down }) });
    const rows = readRows(dir, 'v');
    assert(rows.length === 6 && out.rows.length === 6, 'all matches recorded');
    assert(rows.every(r => r.void && typeof r.voidReason === 'string' && r.winner === null && r.winnerModel === null), 'errored matches are void with reason');
    assert(rows.some(r => r.voidReason?.includes('kaput')) && rows.some(r => r.voidReason?.includes('down for good')), 'reasons carried');
  });
});

test('http: client timeoutMs option reaches the request', async () => {
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const client = new OpenAICompatibleClient({ provider: 'x', endpoint: `http://127.0.0.1:${port}/`, modelId: 'm', apiKey: 'k', timeoutMs: 60 });
  const reasons: string[] = [];
  try {
    await client.getAction(serializeObservation(new GameState('quick'), 1), ['Glider'], undefined, {
      attemptFailed: i => { reasons.push(i.reason); throw new Error('stop'); },
    });
  } catch { /* stopped after first attempt */ } finally {
    server.closeAllConnections?.();
    server.close();
  }
  assert(reasons.length === 1 && reasons[0].includes('timeout after 0.06s'), `reason: ${reasons[0]}`);
});

test('config: litellm models set a per-model timeoutMs (60-600s, longer for slow reasoners), the minis keep the default', () => {
  const lite = MODEL_REGISTRY.filter(m => m.provider === 'litellm');
  assert(lite.length > 0, 'litellm entries exist');
  for (const m of lite) {
    const fast = m.key === 'litellm-gpt-4o-mini' || m.key === 'litellm-gpt-4.1-mini';
    assert(fast ? m.timeoutMs === undefined : typeof m.timeoutMs === 'number' && m.timeoutMs >= 60000 && m.timeoutMs <= 900000, `${m.key} timeoutMs=${m.timeoutMs}`);
  }
  const t = (key: string) => getModelEntry(key).timeoutMs;
  assert(t('litellm-glm-5.2') === 900000 && t('litellm-grok-4.6') === 900000 && t('litellm-kimi-k3') === 900000 && t('litellm-deepseek-v4.1-flash') === 400000, 'slow reasoners get long timeouts');
});

test('config: reasoning effort policy (cheap models high, expensive medium, non-reasoning models none)', () => {
  const effort = (key: string) => (getModelEntry(key).extraBody as { reasoning_effort?: string } | undefined)?.reasoning_effort;
  for (const k of ['claude-haiku-4-5', 'gemini-3.5-flash', 'glm-5.3-flash']) assert(effort('litellm-' + k) === 'high', `${k} high`);
  for (const k of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gemini-3.1-pro', 'glm-5.2', 'grok-4.6']) assert(effort('litellm-' + k) === 'medium', `${k} medium`);
  assert(effort('litellm-kimi-k3') === 'high', 'kimi-k3 uses high: its scale is low/high/max, so high is the middle level');
  for (const k of ['qwen3-235b', 'kimi-k2.5', 'glm-5', 'grok-4.1-fast', 'deepseek-v3.2']) assert(effort('litellm-' + k) === undefined, `${k} no effort`);
  for (const k of ['litellm-mimo-v2.6-pro', 'litellm-kimi-k2-thinking']) assert(!MODEL_REGISTRY.some(m => m.key === k), `${k} must not be registered`);
});



// ---------- Review fixes ----------

async function rejects(p: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert(pattern.test(err instanceof Error ? err.message : String(err)), `${what}: wrong error: ${String(err)}`);
    return;
  }
  throw new Error(`${what}: expected a rejection`);
}

test('usage (C1): unusable responses still report their billed usage, one event per attempt', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'thinking...' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const client = new OpenAICompatibleClient({ provider: 'x', endpoint: `http://127.0.0.1:${port}/`, modelId: 'm', apiKey: 'k' });
  const seen: { promptTokens?: number; completionTokens?: number }[] = [];
  try {
    await rejects(client.getAction(serializeObservation(new GameState('quick'), 1), ['Glider'], undefined, { usage: u => seen.push(u) }), /no tool call/, 'bad response');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  assert(seen.length === 2 && seen.every(u => u.promptTokens === 1000 && u.completionTokens === 500), `usage events: ${JSON.stringify(seen)}`);
});

test('tournament (C1): tokens from failed/unusable calls are logged and counted', async () => {
  const flaky: LLMClient = {
    provider: 'fake',
    modelId: 'flaky',
    async getAction(_o, _p, _r, hooks) {
      hooks?.usage?.({ promptTokens: 100, completionTokens: 50 });
      throw new ModelResponseError('no tool call');
    },
  };
  await withTempDir(async dir => {
    const out = await runTournament({ ...QUICK, models: ['flaky', 'baseline'], gamesPerPair: 2, id: 'u', baseDir: dir, createController: tourneyFactory({ flaky }) });
    const [r0, r1] = readRows(dir, 'u');
    assert(r0.tokens.p1 > 0 && r0.tokens.p1 % 150 === 0 && r0.tokens.p2 === 0, `p1 tokens ${r0.tokens.p1}`);
    assert(r1.tokens.p2 > 0 && r1.tokens.p1 === 0, 'tokens follow the model');
    assert(out.totalTokens === r0.tokens.p1 + r1.tokens.p2, 'counted in the tournament total');
  });
});

test('tournament (C2): a match is voided with reason "budget" once the running token count reaches the budget', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['tok', 'baseline'], gamesPerPair: 4, id: 'cb', baseDir: dir, createController: tourneyFactory({ tok: tokenClient('tok', 1000, 0) }) };
    const out = await runTournament({ ...base, tokenBudget: 2500 });
    assert(out.stoppedForBudget && out.rows.length === 1, 'stops after the aborted match');
    const [r] = readRows(dir, 'cb');
    assert(r.void && r.voidReason === 'budget' && r.winner === null && r.winnerModel === null, `row: ${r.void} ${r.voidReason}`);
    const used = r.tokens.p1 + r.tokens.p2;
    assert(used >= 2500 && used <= 3000, `aborted right after crossing the budget, used ${used}`);
    const full = await runTournament({ ...base, id: 'cf' });
    const f = readRows(dir, 'cf')[0];
    assert(f.tokens.p1 + f.tokens.p2 > 3000 && full.rows.length === 4, 'unbudgeted match uses more');
  });
});

test('tournament (I1): resume refuses when prior rows do not match the regenerated schedule', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, gamesPerPair: 4, id: 'm', baseDir: dir, createController: tourneyFactory() };
    await runTournament({ ...base, models: ['fa', 'baseline'], maxMatches: 2 });
    await rejects(runTournament({ ...base, models: ['baseline', 'fa'] }), /Cannot resume.*does not match/, 'swapped models');
    await rejects(runTournament({ ...base, models: ['fb', 'baseline'] }), /Cannot resume/, 'changed model');
    await rejects(runTournament({ ...base, models: ['fa', 'baseline'], preset: 'quick' }), /Cannot resume/, 'changed preset');
    assert(readRows(dir, 'm').length === 2, 'nothing was appended');
    const ok = await runTournament({ ...base, models: ['fa', 'baseline'] });
    assert(ok.skipped === 2 && ok.rows.length === 2, 'same schedule still resumes');
  });
});

test('tournament (I2): void rows are skipped on resume unless retryVoid; the retry supersedes the old row', async () => {
  const boom: LLMClient = { provider: 'fake', modelId: 'boom', async getAction() { throw new ProviderUnavailableError('down'); } };
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['x', 'baseline'], gamesPerPair: 2, id: 'rv', baseDir: dir };
    await runTournament({ ...base, createController: tourneyFactory({ x: boom }) });
    const skip = await runTournament({ ...base, createController: tourneyFactory() });
    assert(skip.rows.length === 0 && skip.skipped === 2, 'void rows stay done by default');
    const retry = await runTournament({ ...base, retryVoid: true, createController: tourneyFactory() });
    assert(retry.rows.length === 2 && retry.rows.every(r => !r.void), 'void matches re-run');
    assert(readRows(dir, 'rv').length === 4, 'old rows are kept in the file');
    const rows = loadResults('rv', dir);
    assert(rows.length === 2 && rows.every(r => !r.void) && rows.map(r => r.index).join() === '0,1', 'readers see one row per index, the latest');
    const lb = computeLeaderboard(rows);
    assert(lb.matches === 2 && lb.voidMatches === 0, 'leaderboard uses the replacement rows');
    const again = await runTournament({ ...base, retryVoid: true, createController: tourneyFactory() });
    assert(again.rows.length === 0, 'nothing void left to retry');
  });
});

test('tournament (I5): duplicate model keys are rejected', async () => {
  await withTempDir(async dir => {
    await rejects(runTournament({ ...QUICK, models: ['a', 'a', 'baseline'], gamesPerPair: 2, id: 'd', baseDir: dir, createController: tourneyFactory() }), /Duplicate model keys: a/, 'duplicates');
  });
});

test('results (I6): a truncated last line is skipped; a corrupt middle line is an error (resume, leaderboard, API)', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 4, id: 'tr', baseDir: dir, createController: tourneyFactory() };
    await runTournament({ ...base, maxMatches: 2 });
    const file = join(dir, 'tr', 'results.jsonl');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, good + '{"index":2,"tournamentId":"tr","pre');
    assert(loadResults('tr', dir).length === 2, 'leaderboard loader skips the truncated tail');
    const resumed = await runTournament(base);
    assert(resumed.skipped === 2 && resumed.rows.length === 2, 'resume skips the broken tail and replays that match');
    assert(readRows(dir, 'tr').map(r => r.index).join() === '0,1,2,3', 'file is clean again');

    mkdirSync(join(dir, 'bad'), { recursive: true });
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(join(dir, 'bad', 'results.jsonl'), [lines[0], '{oops', lines[1]].join('\n') + '\n');
    assert((() => { try { loadResults('bad', dir); return false; } catch (e) { return /line 2/.test(String(e)); } })(), 'corrupt middle line throws');
    mkdirSync(join(dir, 'tail'), { recursive: true });
    writeFileSync(join(dir, 'tail', 'results.jsonl'), lines[0] + '\n{"index"');
    const handle = await startStudio({ port: 0, distDir: join(dir, 'dist'), logDir: join(dir, 'logs'), videoDir: join(dir, 'videos'), tournamentDir: dir, quiet: true });
    try {
      const url = 'http://127.0.0.1:' + handle.port;
      const bad = await fetch(url + '/api/leaderboard?id=bad');
      assert(bad.status === 500 && JSON.stringify(await bad.json()).includes('line 2'), 'corrupt file is a 500 with the cause');
      assert((await fetch(url + '/api/leaderboard?id=tail')).status === 200, 'truncated tail still served');
      assert((await fetch(url + '/api/leaderboard?id=missing')).status === 404, 'missing is still 404');
    } finally {
      handle.close();
    }
  });
});

test('http (I3): long-timeout requests give up after two timed-out attempts; default requests keep all retries', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; }) as typeof fetch;
  try {
    const run = (timeoutMs?: number) => postJsonWithRetry('x', 'http://127.0.0.1:1/', {}, {}, j => j, undefined, { retryDelaysMs: [1, 1, 1, 1, 1], ...(timeoutMs ? { timeoutMs } : {}) }).catch(() => undefined);
    await run(120_000);
    assert(calls === 2, `long timeout: ${calls} attempts`);
    calls = 0;
    await run();
    assert(calls === 6, `default timeout: ${calls} attempts`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- Per-owner Life rules ----------

import { Grid } from '../../engine/grid';
import { Simulation } from '../../engine/simulation';
import { birthOwner } from '../../engine/rules';
import { PlayerState } from '../../game/player';
import type { Owner } from '../../engine/types';

function engine(width: number, height: number, cells: [number, number, Owner][], maxAge = 1000): Simulation {
  const grid = new Grid(width, height);
  for (const [x, y, o] of cells) grid.placeCell(x, y, o, 0);
  return new Simulation(grid, maxAge, new PlayerState(1, 0), new PlayerState(2, 0));
}
const aliveAt = (g: Grid, x: number, y: number, owner?: Owner) => !!g.getCell(x, y)?.alive && (owner === undefined || g.getCell(x, y)!.owner === owner);

test('engine: birth needs exactly 3 neighbours of ONE owner; mixed neighbours and ties give nothing', () => {
  assert(birthOwner({ p1: 3, p2: 0, neutral: 0 }) === 'p1' && birthOwner({ p1: 0, p2: 3, neutral: 0 }) === 'p2', 'three of one owner is born');
  assert(birthOwner({ p1: 2, p2: 1, neutral: 0 }) === null, 'two of mine plus one enemy is NOT a birth (no neutral births any more)');
  assert(birthOwner({ p1: 3, p2: 1, neutral: 0 }) === 'p1', 'an enemy neighbour does not stop my birth');
  assert(birthOwner({ p1: 3, p2: 3, neutral: 0 }) === null, 'both owners with exactly 3: no birth');
  const sim = engine(10, 10, [[0, 0, 'p1'], [1, 0, 'p1'], [2, 0, 'p1'], [0, 2, 'p2'], [1, 2, 'p2'], [2, 2, 'p2']]);
  const g1 = sim.step();
  assert(!aliveAt(g1, 1, 1), 'the tied square stays empty');
});

test('engine: enemy cells are not my neighbours (my birth beside an enemy block succeeds and contact kills the touching cells)', () => {
  // The p1 row on y=0 gives a p1 birth at (1,1); the p2 block below touches that square. With enemy cells counted it would have 5 neighbours: no birth.
  const sim = engine(12, 12, [[0, 0, 'p1'], [1, 0, 'p1'], [2, 0, 'p1'], [1, 2, 'p2'], [2, 2, 'p2'], [1, 3, 'p2'], [2, 3, 'p2']]);
  const g1 = sim.step();
  assert(!aliveAt(g1, 1, 2) && !aliveAt(g1, 2, 2), 'the p2 cells touching the newborn p1 cell die with it');
  assert(!aliveAt(g1, 1, 1), 'the newborn p1 cell died in the contact');
});

test('engine: collision still kills both when a p1 and a p2 cell touch', () => {
  const apart = engine(20, 20, [[10, 10, 'p1'], [11, 10, 'p1'], [10, 11, 'p1'], [11, 11, 'p1'], [13, 10, 'p2'], [14, 10, 'p2'], [13, 11, 'p2'], [14, 11, 'p2']]);
  let g = apart.step();
  assert(aliveAt(g, 10, 10, 'p1') && aliveAt(g, 14, 10, 'p2'), 'blocks 2 apart keep living');
  const touching = engine(20, 20, [[10, 10, 'p1'], [11, 10, 'p1'], [10, 11, 'p1'], [11, 11, 'p1'], [12, 10, 'p2'], [13, 10, 'p2'], [12, 11, 'p2'], [13, 11, 'p2']]);
  g = touching.step();
  assert(!aliveAt(g, 11, 10) && !aliveAt(g, 11, 11) && !aliveAt(g, 12, 10) && !aliveAt(g, 12, 11), 'the touching columns die together');
  assert(aliveAt(g, 10, 10, 'p1') && aliveAt(g, 13, 10, 'p2'), 'the outer columns survive');
});

test('engine: a Glider and an LWSS travel exactly as in plain Life when alone (own counting changes nothing)', () => {
  for (const [name, rot] of [['Glider', 0], ['LWSS', 0], ['LWSS', 3]] as const) {
    const pat = rotatePattern(PATTERNS.find(p => p.name === name)!, rot);
    const cells: [number, number][] = pat.cells.map(([x, y]) => [x + 30, y + 30]);
    const sim = engine(70, 70, cells.map(([x, y]) => [x, y, 'p1'] as [number, number, Owner]));
    const reference = simulate(cells, 40);
    let g: Grid = sim.current;
    for (let i = 0; i < 40; i++) g = sim.step();
    const got = new Set<string>();
    for (let y = 0; y < 70; y++) for (let x = 0; x < 70; x++) if (aliveAt(g, x, y, 'p1')) got.add(x + ',' + y);
    assert(got.size === reference.cells.size && [...got].every(k => reference.cells.has(k)), name + ' rot ' + rot + ' must match plain Life after 40 generations');
  }
});

// ---------- Post-mortem causes ----------

function reportLine(prefix: string, setup: (state: GameState, memory: MatchMemory) => void): string {
  const { state, memory } = duelGame();
  setup(state, memory);
  const report = playAndReport(state, memory);
  return report[1].find(l => l.startsWith(prefix)) ?? 'MISSING: ' + report[1].join(' | ');
}

test('post-mortem cause: ran into your own Heart box', () => {
  const line = reportLine('#1 LWSS/r3@2,12', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [2, 12], preset: 'LWSS', rotation: 3 }));
  assert(line.includes('it ran into your own Heart box'), line);
});

test('post-mortem cause: collided with enemy cells', () => {
  const line = reportLine('#1 LWSS@9,20', (s, m) => {
    placeRemembered(s, m, { action: 'place', anchor: [9, 20], preset: 'LWSS' });
    assert(applyBenchAction(s, 2, { action: 'place', anchor: [36, 21], preset: 'Block' }).ok, 'enemy block in the lane');
  });
  assert(line.includes('stopped by enemy cells (contact rule)'), line);
});

test('post-mortem cause: reached the board edge', () => {
  const line = reportLine('#1 LWSS/r2@6,30', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [6, 30], preset: 'LWSS', rotation: 2 }));
  assert(line.includes('it reached the board edge'), line);
});

test('post-mortem cause: expired (maxAge)', () => {
  const line = reportLine('#1 Block@8,30', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [8, 30], preset: 'Block' }));
  assert(line.includes('expired: cells live at most 160 generations'), line);
});

test('post-mortem cause: burnt out by itself (a lone cell)', () => {
  const line = reportLine('#1 ', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [8, 30], cells: [[0, 0]] }));
  assert(line.includes('it burnt out by itself'), line);
});

test('post-mortem cause: columns never reach their Heart (right rows, too slow or wrong heading)', () => {
  const line = reportLine('#1 Glider@10,10', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [10, 10], preset: 'Glider' }));
  assert(/no damage because its columns x \d+\.\.\d+ never reach their Heart columns x 41\.\.45/.test(line), line);
});

test('post-mortem cause: path passes beside their Heart box', () => {
  const line = reportLine('#1 Glider/r3@10,36', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [10, 36], preset: 'Glider', rotation: 3 }));
  assert(line.includes('passes beside their Heart box'), line);
});

// ---------- Input accuracy: Heart cells, partial placements, tool friction ----------

test('observation: Heart cells are listed (own at once, the enemy\'s once seen) and the box is not solid', () => {
  const { state, memory } = duelGame();
  const own = serializeObservation(state, 1);
  const heart = PATTERNS.find(p => p.name === 'Heart')!;
  assert(own.you.heartCells.length === heart.cells.length, `own heartCells should have ${heart.cells.length} squares, got ${own.you.heartCells.length}`);
  assert(own.you.heartCells.length < own.you.heartZone!.w * own.you.heartZone!.h, 'the Heart box has empty squares');
  assert(own.you.heartCells.every(([x, y]) => (state.grid.getCell(x, y)?.fixed ?? false)), 'every listed square is a fixed cell');
  assert(own.opponent.heartCells.length === 0, 'the enemy Heart is unknown before the first round');
  playAndReport(state, memory);
  state.nextRound();
  const later = serializeObservation(state, 1);
  assert(later.opponent.heartZone !== null && later.opponent.heartCells.length === heart.cells.length, 'enemy Heart cells known once seen');
  const z = later.opponent.heartZone!;
  assert(later.opponent.heartCells.every(([x, y]) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h), 'enemy Heart cells lie inside its box');
});

test('action: a partly applied placement says how many cells landed and which squares were skipped', () => {
  const { state } = duelGame();
  const z = state.players[0].heartZone!;
  const r = applyBenchAction(state, 1, { action: 'place', anchor: [z.x, z.y], preset: 'LWSS' });
  assert(r.ok && r.partial !== undefined && r.warning !== undefined, 'overlapping own Heart cells is ok but partial: ' + JSON.stringify(r));
  assert(r.partial.total === 9 && r.partial.placed < 9 && r.partial.placed + r.partial.skipped.length === 9, JSON.stringify(r.partial));
  assert(r.partial.skipped.every(c => c.reason === 'your Heart cell'), 'skipped squares are named as Heart cells');
  assert(new RegExp('placed ' + r.partial.placed + '/9, skipped \\(\\d+, \\d+\\) your Heart cell').test(r.warning), r.warning);
  const full = applyBenchAction(state, 1, { action: 'place', anchor: [9, 30], preset: 'LWSS' });
  assert(full.ok && full.partial === undefined && full.warning === undefined, 'a complete placement carries no warning');
});

test('post-mortem: a partly placed pattern is reported as such, in the label and in the line', () => {
  const line = reportLine('#1 ', (s, m) => {
    const z = s.players[0].heartZone!;
    placeRemembered(s, m, { action: 'place', anchor: [z.x, z.y], preset: 'LWSS' });
  });
  assert(/\[only \d\/9 cells\]/.test(line) && /only \d of 9 cells were placed \(skipped \(\d+, \d+\) your Heart cell/.test(line) && line.includes('not the full shape'), line);
});

test('post-mortem cause: a mover that breaks on their Heart cells says so (not "too slow or wrong heading")', () => {
  const line = reportLine('#1 LWSS@9,18', (s, m) => placeRemembered(s, m, { action: 'place', anchor: [9, 18], preset: 'LWSS' }));
  assert(/no damage because it ran into their Heart cells at \(\d+, \d+\) \(generation \d+\)/.test(line), line);
  assert(!line.includes('too slow') && !line.includes('burnt out by itself'), line);
});

test('post-mortem: replay uses the real round\'s generation counter (round 2 placements do not expire early)', () => {
  const { state, memory } = duelGame();
  playAndReport(state, memory);
  state.nextRound();
  const m2 = new MatchMemory();
  const action: BenchAction = { action: 'place', anchor: [8, 30], preset: 'Block' };
  const r = applyBenchAction(state, 1, action);
  m2.recordAction(1, action, r);
  const report = playAndReport(state, m2);
  assert(!report[1].some(l => l.includes('expired')), 'the real engine never expires a round-2 placement: ' + report[1].join(' | '));
  assert(state.grid.getCell(8, 30)?.alive === true, 'and the block really is still alive after the round');
});

test('loop: place + end_turn with a failing placement keeps the turn open and the model can retry', async () => {
  const state = new GameState('quick');
  const z = state.layout.p1Build;
  assert(applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' }).ok, 'heart');
  const seen: { committedBefore: boolean; rejection?: string }[] = [];
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/retry',
    async getAction(_obs, _presets, previousRejection): Promise<LLMCallResult> {
      seen.push({ committedBefore: state.players[0].committed, rejection: previousRejection });
      if (seen.length === 1) {
        return { actions: [{ action: 'place', anchor: [z.x + 8, z.y + 8], preset: 'Block' }, { action: 'place', anchor: [500, 500], preset: 'Block' }, { action: 'submit' }], latencyMs: 0 };
      }
      return { actions: [{ action: 'submit' }], latencyMs: 0 };
    },
  };
  await runLLMBuildPhase(state, 1, client, { log() {} });
  assert(seen.length === 2, 'a second call happened: ' + seen.length);
  assert(!seen[1].committedBefore, 'the turn was still open after the failed place + end_turn');
  assert(/outside your buildZone/.test(seen[1].rejection ?? '') && /end_turn was NOT applied/.test(seen[1].rejection ?? ''), seen[1].rejection ?? 'no rejection');
  assert(state.players[0].committed, 'the retry ended the turn');
});

test('loop: a partial placement is fed back while the turn is open', async () => {
  const state = new GameState('quick');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' });
  const rejections: (string | undefined)[] = [];
  const client: LLMClient = {
    provider: 'stub',
    modelId: 'stub/partial',
    async getAction(_obs, _presets, previousRejection): Promise<LLMCallResult> {
      rejections.push(previousRejection);
      if (rejections.length === 1) return { actions: [{ action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'LWSS' }], latencyMs: 0 };
      return { actions: [{ action: 'submit' }], latencyMs: 0 };
    },
  };
  await runLLMBuildPhase(state, 1, client, { log() {} });
  assert(/WARNING \(placed, but incomplete\).*placed \d\/9, skipped/.test(rejections[1] ?? ''), rejections[1] ?? 'none');
});

test('tools: an empty end_turn is accepted (placements [] + end_turn, or a plain end_turn)', async () => {
  const args = { analysis: 'a', placements: [], rationale: 'r', notes: 'n', end_turn: true };
  assert(missingRequiredFields('place', args).length === 0, 'an empty placements array is not "missing"');
  assert(missingRequiredFields('place', { ...args, placements: undefined }).includes('placements'), 'but leaving it out still is');
  const actions = toolCallToActions('place', args);
  assert(actions.length === 1 && actions[0].action === 'submit', JSON.stringify(actions));
  let threw = false;
  try { toolCallToActions('place', { ...args, end_turn: false }); } catch { threw = true; }
  assert(threw, 'an empty placements array without end_turn does nothing and is still refused');
  const place = TOOL_DEFS.find(t => t.name === 'place')!;
  assert((place.parameters.properties.placements as { minItems?: number }).minItems === undefined, 'the schema no longer demands a placement');
  const state = new GameState('quick');
  const z = state.layout.p1Build;
  applyBenchAction(state, 1, { action: 'place', anchor: [z.x + 2, z.y + 2], preset: 'Heart' });
  const client: LLMClient = { provider: 'stub', modelId: 'stub/empty', async getAction() { return { actions, latencyMs: 0 }; } };
  await runLLMBuildPhase(state, 1, client, { log() {} });
  assert(state.players[0].committed && state.players[0].movesLeft === state.preset.movesPerRound, 'turn ended with nothing placed');
});

// ---------- Truncation handling ----------

async function clientAgainst(body: unknown): Promise<{ client: OpenAICompatibleClient; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    client: new OpenAICompatibleClient({ provider: 'x', endpoint: 'http://127.0.0.1:' + port + '/', modelId: 'm', apiKey: 'k' }),
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
const fullArgs = { analysis: 'a', placements: [{ anchor: [1, 1], preset: 'Block' }], rationale: 'r', notes: 'n', end_turn: true };
const toolResponse = (args: unknown, finish: string) => ({ choices: [{ finish_reason: finish, message: { tool_calls: [{ function: { name: 'place', arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });

test('truncation: a complete response logs finish_reason and the raw arguments', async () => {
  const { client, close } = await clientAgainst(toolResponse(fullArgs, 'tool_calls'));
  try {
    const r = await client.getAction(serializeObservation(new GameState('quick'), 1), ['Block']);
    assert(r.finishReason === 'tool_calls' && typeof r.rawArgs === 'string' && r.rawArgs.includes('"analysis":"a"'), JSON.stringify(r));
  } finally { close(); }
});

test('truncation: finish_reason=length is a bad response even when the arguments parse', async () => {
  const { client, close } = await clientAgainst(toolResponse(fullArgs, 'length'));
  try {
    await rejects(client.getAction(serializeObservation(new GameState('quick'), 1), ['Block']), /truncated \(finish_reason=length\)/, 'length');
  } finally { close(); }
});

test('required fields (A5): empty or missing analysis/rationale is ACCEPTED with a missingFields warning; a missing placements array is still a bad response with finish reason and raw args kept', async () => {
  const { client, close } = await clientAgainst(toolResponse({ ...fullArgs, analysis: '', rationale: undefined }, 'stop'));
  try {
    const r = await client.getAction(serializeObservation(new GameState('quick'), 1), ['Block']);
    assert(r.actions.length === 2 && r.actions[0].action === 'place' && r.actions[1].action === 'submit', 'the valid placement and end_turn are applied: ' + JSON.stringify(r.actions));
    assert(JSON.stringify(r.missingFields) === '["analysis","rationale"]', 'missing prose is reported: ' + JSON.stringify(r.missingFields));
  } finally { close(); }
  const bad = await clientAgainst(toolResponse({ ...fullArgs, placements: undefined }, 'stop'));
  try {
    let err: unknown;
    try { await bad.client.getAction(serializeObservation(new GameState('quick'), 1), ['Block']); } catch (e) { err = e; }
    assert(err instanceof ModelResponseError && /missing required fields: placements/.test(err.message), String(err));
    assert((err as ModelResponseError).finishReason === 'stop' && ((err as ModelResponseError).rawArgs ?? '').includes('analysis'), 'finish reason and raw args on the error');
  } finally { bad.close(); }
});

test('truncation: the loop logs llm_bad_response with finish_reason and raw args (then skips, no outer retry), and turn rows carry them', async () => {
  const state = new GameState('quick');
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Parameters<typeof runLLMBuildPhase>[3];
  let calls = 0;
  const client: LLMClient = {
    provider: 'fake', modelId: 'f',
    async getAction() { calls++; const e = new ModelResponseError('cut off'); e.finishReason = 'length'; e.rawArgs = '{"anal'; throw e; },
  };
  applyBenchAction(state, 1, { action: 'place', anchor: [1, 2], preset: 'Heart' });
  await runLLMBuildPhase(state, 1, client, logger);
  const bad = events.find(e => e.type === 'llm_bad_response');
  assert(bad && bad.finishReason === 'length' && bad.rawArgs === '{"anal' && calls === 1, JSON.stringify(bad));
  assert(events.some(e => e.type === 'auto_skip'), 'auto_skip logged');
  const ok: LLMClient = { provider: 'fake', modelId: 'f', async getAction() { return { actions: [{ action: 'submit' }], latencyMs: 1, finishReason: 'stop', rawArgs: '{}' }; } };
  events.length = 0;
  await runLLMBuildPhase(new GameState('quick'), 1, ok, logger);
  const turn = events.find(e => e.type === 'turn');
  assert(turn && turn.finishReason === 'stop' && turn.rawArgs === '{}', 'turn rows carry finish_reason and raw args');
});

test('config: Qwen3-235B and Qwen3-32B litellm entries allow 3000 tokens', () => {
  assert(MODEL_REGISTRY.find(m => m.key === 'litellm-qwen3-235b')?.maxTokens === 3000 && MODEL_REGISTRY.find(m => m.key === 'litellm-qwen3-32b')?.maxTokens === 3000, 'maxTokens');
});

// ---------- Heart zone: hit once, then die ----------

function heartEngine(cells: [number, number, Owner][], zone1: { x: number; y: number; w: number; h: number } | null, zone2: { x: number; y: number; w: number; h: number } | null) {
  const grid = new Grid(40, 20);
  for (const [x, y, o] of cells) grid.placeCell(x, y, o, 0);
  const p1 = new PlayerState(1, 0);
  const p2 = new PlayerState(2, 0);
  if (zone1) { p1.heartPlaced = true; p1.heartZone = zone1; }
  if (zone2) { p2.heartPlaced = true; p2.heartZone = zone2; }
  return { sim: new Simulation(grid, 1000, p1, p2), p1, p2 };
}
const inZone = (g: Grid, z: { x: number; y: number; w: number; h: number }, owner: Owner) => {
  let n = 0;
  for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) if (aliveAt(g, x, y, owner)) n++;
  return n;
};

test('heart: a block parked in the enemy Heart zone deals its damage once and is then gone', () => {
  const zone = { x: 20, y: 5, w: 5, h: 4 };
  const { sim, p2 } = heartEngine([[21, 6, 'p1'], [22, 6, 'p1'], [21, 7, 'p1'], [22, 7, 'p1']], null, zone);
  const g1 = sim.step();
  assert(p2.heartHp === 60 && inZone(g1, zone, 'p1') === 0, '10 damage per cell (4 cells), then every cell is removed: HP ' + p2.heartHp);
  sim.step();
  sim.step();
  assert(p2.heartHp === 60, 'a parked still life cannot drain the Heart any more');
});

test('heart: eight cells entering deal 50 (the 5-cell cap) and all eight are removed', () => {
  const zone = { x: 20, y: 5, w: 6, h: 4 };
  const cells: [number, number, Owner][] = [[20, 5, 'p1'], [21, 5, 'p1'], [20, 6, 'p1'], [21, 6, 'p1'], [23, 5, 'p1'], [24, 5, 'p1'], [23, 6, 'p1'], [24, 6, 'p1']];
  const { sim, p2 } = heartEngine(cells, null, zone);
  const g1 = sim.step();
  assert(inZone(g1, zone, 'p1') === 0, 'all of them are removed, including those beyond the cap');
  assert(p2.heartHp === 50, 'damage is capped at 5 cells x 10 per generation: HP ' + p2.heartHp);
});

test('heart: one enemy cell in the zone deals 10 damage and is removed', () => {
  // A block straddling the zone edge so that exactly one of its cells (20,5) is inside the one-row zone.
  const zone = { x: 20, y: 5, w: 5, h: 1 };
  const { sim, p2 } = heartEngine([[19, 5, 'p1'], [19, 6, 'p1'], [20, 5, 'p1'], [20, 6, 'p1']], null, zone);
  const g1 = sim.step();
  assert(p2.heartHp === 90 && sim.p2HeartDamage === 10, 'one cell costs 10 HP: HP ' + p2.heartHp);
  assert(inZone(g1, zone, 'p1') === 0, 'the cell is removed');
});

test('heart: seven enemy cells deal 50 damage (5-cell cap) and all seven are removed', () => {
  const zone = { x: 20, y: 5, w: 6, h: 7 };
  const cells: [number, number, Owner][] = [[20, 5, 'p1'], [21, 5, 'p1'], [20, 6, 'p1'], [21, 6, 'p1'], [20, 10, 'p1'], [21, 10, 'p1'], [22, 10, 'p1']];
  const { sim, p2 } = heartEngine(cells, null, zone);
  const g1 = sim.step();
  assert(inZone(g1, zone, 'p1') === 0, 'all seven are removed');
  assert(p2.heartHp === 50, 'capped at 5 cells x 10: HP ' + p2.heartHp);
});

test('round end: nextRound clears both owners cells inside both Heart zones, keeps Hearts and cells outside', () => {
  const state = twoHeartGame();
  const emptyIn = (z: { x: number; y: number; w: number; h: number }) => {
    const out: [number, number][] = [];
    for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) if (!state.grid.getCell(x, y)?.alive) out.push([x, y]);
    return out;
  };
  const z1 = state.players[0].heartZone!;
  const z2 = state.players[1].heartZone!;
  const e1 = emptyIn(z1);
  const e2 = emptyIn(z2);
  state.grid.placeCell(e1[0][0], e1[0][1], 'p1', 0);
  state.grid.placeCell(e1[1][0], e1[1][1], 'p2', 0);
  state.grid.placeCell(e2[0][0], e2[0][1], 'p1', 0);
  state.grid.placeCell(e2[1][0], e2[1][1], 'p2', 0);
  const outside: [number, number] = [state.layout.battlefield.x + 2, state.layout.battlefield.y + 2];
  state.grid.placeCell(outside[0], outside[1], 'p1', 0);
  state.resolve();
  assert(state.nextRound(), 'next round starts');
  for (const [x, y] of [e1[0], e1[1], e2[0], e2[1]]) assert(!state.grid.getCell(x, y)?.alive, `cell at ${x},${y} in a Heart zone must be cleared`);
  assert(state.grid.countByOwner('p1') === 10 + 1 && state.grid.countByOwner('p2') === 10, 'Hearts (10 cells each) and the outside cell stay');
  assert(state.grid.getCell(outside[0], outside[1])?.alive === true, 'cell outside the zones stays');
  assert(state.grid.getCell(z1.x, z1.y) !== undefined, 'grid intact');
});

test('heart: your own cells in your own Heart zone are untouched and cost nothing', () => {
  const zone = { x: 20, y: 5, w: 5, h: 4 };
  const { sim, p2 } = heartEngine([[21, 6, 'p2'], [22, 6, 'p2'], [21, 7, 'p2'], [22, 7, 'p2']], null, zone);
  const g1 = sim.step();
  assert(p2.heartHp === 100 && inZone(g1, zone, 'p2') === 4, 'own block stays and costs nothing');
});

// ---------- Cost guard: truncation escalation, real cost, USD caps ----------

/** Loopback server answering from a script; records each request's max_tokens. */
async function scriptedServer(answer: (n: number) => { body: unknown; cost?: string }): Promise<{ client: (cfg?: Partial<ConstructorParameters<typeof OpenAICompatibleClient>[0]>) => OpenAICompatibleClient; maxTokens: (number | undefined)[]; close: () => void }> {
  const maxTokens: (number | undefined)[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      maxTokens.push((JSON.parse(raw) as { max_tokens?: number }).max_tokens);
      const { body, cost } = answer(maxTokens.length);
      res.writeHead(200, { 'Content-Type': 'application/json', ...(cost !== undefined ? { 'x-litellm-response-cost': cost } : {}) });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    client: cfg => new OpenAICompatibleClient({ provider: 'x', endpoint: `http://127.0.0.1:${port}/`, modelId: 'm', apiKey: 'k', ...cfg }),
    maxTokens,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
const obs1 = () => serializeObservation(new GameState('quick'), 1);

test('cost guard: finish_reason=length gets exactly ONE retry with doubled max_tokens, then fails with no further requests', async () => {
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  const escalations: { fromMaxTokens: number; toMaxTokens: number }[] = [];
  try {
    let err: unknown;
    try { await s.client({ maxTokens: 100 }).getAction(obs1(), ['Block'], undefined, { escalated: i => escalations.push(i) }); } catch (e) { err = e; }
    assert(err instanceof ModelResponseError && err.truncated === true && /finish_reason=length/.test(err.message), String(err));
    assert(JSON.stringify(s.maxTokens) === '[100,200]', `requests made: ${JSON.stringify(s.maxTokens)}`);
    assert(escalations.length === 1 && escalations[0].fromMaxTokens === 100 && escalations[0].toMaxTokens === 200, JSON.stringify(escalations));
  } finally { s.close(); }
});

test('cost guard: escalation is capped at maxTokensCeiling, and no retry when the ceiling is already reached', async () => {
  const a = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  try {
    await rejects(a.client({ maxTokens: 100, maxTokensCeiling: 150 }).getAction(obs1(), ['Block']), /truncated/, 'ceiling');
    assert(JSON.stringify(a.maxTokens) === '[100,150]', `capped: ${JSON.stringify(a.maxTokens)}`);
  } finally { a.close(); }
  const b = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  try {
    await rejects(b.client({ maxTokens: 100, maxTokensCeiling: 100 }).getAction(obs1(), ['Block']), /truncated/, 'at ceiling');
    assert(b.maxTokens.length === 1, `at ceiling: ${b.maxTokens.length} request(s)`);
  } finally { b.close(); }
  const c = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  try {
    await rejects(c.client().getAction(obs1(), ['Block']), /truncated/, 'no maxTokens');
    assert(c.maxTokens.length === 1, 'nothing to double when no max_tokens was sent');
  } finally { c.close(); }
});

test('cost guard: a truncated call that succeeds on the escalated retry returns normally; a length cut-off before any tool call is escalated, not retried identically', async () => {
  const a = await scriptedServer(n => ({ body: toolResponse(fullArgs, n === 1 ? 'length' : 'tool_calls') }));
  try {
    const r = await a.client({ maxTokens: 100 }).getAction(obs1(), ['Block']);
    assert(r.finishReason === 'tool_calls' && JSON.stringify(a.maxTokens) === '[100,200]', JSON.stringify(a.maxTokens));
  } finally { a.close(); }
  const b = await scriptedServer(() => ({ body: { choices: [{ finish_reason: 'length', message: { content: 'thinking...' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  try {
    await rejects(b.client({ maxTokens: 100 }).getAction(obs1(), ['Block']), /truncated/, 'no tool call + length');
    assert(JSON.stringify(b.maxTokens) === '[100,200]', `requests: ${JSON.stringify(b.maxTokens)}`);
  } finally { b.close(); }
});

test('cost guard: non-length bad responses keep their retry once (2 attempts total)', async () => {
  const s = await scriptedServer(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }));
  try {
    await rejects(s.client({ maxTokens: 100 }).getAction(obs1(), ['Block']), /no tool call/, 'stop without tool call');
    assert(s.maxTokens.length === 2 && s.maxTokens.every(m => m === 100), `requests: ${JSON.stringify(s.maxTokens)}`);
  } finally { s.close(); }
});

test('cost guard: x-litellm-response-cost is parsed into costUsd (success and failed-parse calls); absent header is 0', async () => {
  const ok = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: '1.8e-06' }));
  try {
    const r = await ok.client().getAction(obs1(), ['Block']);
    assert(r.costUsd === 1.8e-6, `costUsd ${r.costUsd}`);
  } finally { ok.close(); }
  const none = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls') }));
  try {
    const r = await none.client().getAction(obs1(), ['Block']);
    assert(r.costUsd === 0, `absent header -> ${r.costUsd}`);
  } finally { none.close(); }
  const bad = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length'), cost: '0.059' }));
  const usage: { costUsd?: number }[] = [];
  try {
    await rejects(bad.client({ maxTokens: 100 }).getAction(obs1(), ['Block'], undefined, { usage: u => usage.push(u) }), /truncated/, 'bad');
    assert(usage.length === 2 && usage.every(u => u.costUsd === 0.059), `usage events: ${JSON.stringify(usage)}`);
  } finally { bad.close(); }
});

test('cost guard: the loop skips immediately on a truncated response (one call, no outer retries) and logs costUsd on turn rows', async () => {
  const state = new GameState('quick');
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Parameters<typeof runLLMBuildPhase>[3];
  let calls = 0;
  const client: LLMClient = {
    provider: 'fake', modelId: 'f',
    async getAction() { calls++; const e = new ModelResponseError('cut off (finish_reason=length)'); e.truncated = true; e.finishReason = 'length'; throw e; },
  };
  applyBenchAction(state, 1, { action: 'place', anchor: [1, 2], preset: 'Heart' });
  await runLLMBuildPhase(state, 1, client, logger);
  assert(calls === 1, `calls: ${calls}`);
  assert(events.some(e => e.type === 'llm_bad_response') && events.some(e => e.type === 'auto_skip'), 'bad response and auto_skip logged');
  const priced: LLMClient = { provider: 'fake', modelId: 'p', async getAction() { return { actions: [{ action: 'submit' }], latencyMs: 1, costUsd: 0.0123 }; } };
  const ev2: Record<string, unknown>[] = [];
  await runLLMBuildPhase(new GameState('quick'), 1, priced, { log: (e: Record<string, unknown>) => { ev2.push(e); } } as unknown as Parameters<typeof runLLMBuildPhase>[3]);
  assert(ev2.some(e => e.type === 'turn' && e.costUsd === 0.0123), 'turn row carries costUsd');
});

function pricedClient(modelId: string, costUsd: number, counter: { calls: number }): LLMClient {
  const base = scriptedClient(modelId);
  return {
    provider: 'fake', modelId,
    async getAction(obs, presets, rejection, hooks) { counter.calls++; return { ...(await base.getAction(obs, presets, rejection, hooks)), costUsd }; },
  };
}

test('cost guard: a match stops at the USD cap with no further calls, logs match_cost_cap, and reports costCap', async () => {
  const counter = { calls: 0 };
  const events: Record<string, unknown>[] = [];
  const r = await runMatch('skirmish', pricedClient('fake/paid', 0.4, counter), 'baseline', { log: e => { events.push(e); } }, { roundPauseMs: 0, maxUsd: 1.0 });
  assert(r.aborted === true && r.costCap === true && r.winner === null, JSON.stringify(r));
  assert(counter.calls === 3, `3 x $0.40 crosses $1.00, got ${counter.calls} calls`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(counter.calls === 3, 'no calls after the cap');
  const capRows = events.filter(e => e.type === 'match_cost_cap');
  assert(capRows.length === 1 && (capRows[0].totalCostUsd as number) >= 1.0 && capRows[0].costUsd === undefined, JSON.stringify(capRows));
  assert(Math.abs((r.costUsd ?? 0) - 1.2) < 1e-9, `costUsd ${r.costUsd}`);
  assert(events.some(e => e.type === 'turn' && typeof e.matchCostUsd === 'number'), 'rows carry the running match cost');
});

test('live view: runMatch forwards board snapshots to the logger (cost wrapper must not drop them)', async () => {
  let snapshots = 0;
  await runMatch('skirmish', scriptedClient('fake/snap'), 'baseline', { log: () => {}, snapshot: () => { snapshots++; } }, { roundPauseMs: 0, maxRounds: 1 });
  assert(snapshots > 0, `expected board snapshots, got ${snapshots}`);
});

test('cost guard: BENCH_MATCH_MAX_USD sets the cap (default 1.0), an explicit option wins', async () => {
  const prev = process.env.BENCH_MATCH_MAX_USD;
  try {
    delete process.env.BENCH_MATCH_MAX_USD;
    assert(resolveMaxUsd() === 1.0 && resolveMaxUsd(0.25) === 0.25, 'default and option');
    process.env.BENCH_MATCH_MAX_USD = '0.5';
    assert(resolveMaxUsd() === 0.5 && resolveMaxUsd(2) === 2, 'env and option');
    process.env.BENCH_MATCH_MAX_USD = 'junk';
    assert(resolveMaxUsd() === 1.0, 'junk falls back to default');
    process.env.BENCH_MATCH_MAX_USD = '0.3';
    const counter = { calls: 0 };
    const r = await runMatch('skirmish', pricedClient('fake/paid', 0.2, counter), 'baseline', { log() {} }, { roundPauseMs: 0 });
    assert(r.costCap === true && counter.calls === 2, `env cap applied: ${counter.calls} calls`);
  } finally {
    if (prev === undefined) delete process.env.BENCH_MATCH_MAX_USD; else process.env.BENCH_MATCH_MAX_USD = prev;
  }
});

test('cost guard: tournament rows carry costUsd per seat, a capped match is void "cost cap", and TOURNEY_MAX_USD stops the run', async () => {
  const prev = process.env.BENCH_MATCH_MAX_USD;
  process.env.BENCH_MATCH_MAX_USD = '0.5';
  try {
    await withTempDir(async dir => {
      const counter = { calls: 0 };
      // The per-match cap now comes from the tournament (matchMaxUsd), not from BENCH_MATCH_MAX_USD.
      const out = await runTournament({ ...QUICK, models: ['paid', 'baseline'], gamesPerPair: 4, id: 'usd', baseDir: dir, createController: tourneyFactory({ paid: pricedClient('paid', 0.3, counter) }), maxUsd: 1.0, matchMaxUsd: 0.5 });
      const rows = readRows(dir, 'usd');
      assert(rows[0].void && rows[0].voidReason === 'cost cap', `row0: ${rows[0].voidReason}`);
      const seat = rows[0].p1 === 'paid' ? 'p1' : 'p2';
      const other = seat === 'p1' ? 'p2' : 'p1';
      assert(rows[0].costUsd && Math.abs(rows[0].costUsd[seat] - 0.6) < 1e-9 && rows[0].costUsd[other] === 0, JSON.stringify(rows[0].costUsd));
      assert(out.stoppedForBudget && out.totalUsd >= 1.0 && rows.length === 2, `stopped on USD budget after ${rows.length} rows, total $${out.totalUsd}`);
    });
  } finally {
    if (prev === undefined) delete process.env.BENCH_MATCH_MAX_USD; else process.env.BENCH_MATCH_MAX_USD = prev;
  }
});

test('config: litellm-claude-sonnet-5-5 allows 32000 tokens with a 48000 ceiling', () => {
  const m = MODEL_REGISTRY.find(x => x.key === 'litellm-claude-sonnet-5-5');
  assert(m?.maxTokens === 32000 && m.maxTokensCeiling === 48000, JSON.stringify(m));
});

test('cost guard: no tool call twice => exactly 2 requests for the turn-call, then skip (real client through the loop)', async () => {
  for (const finish of ['stop', 'length']) {
    const s = await scriptedServer(() => ({ body: { choices: [{ finish_reason: finish, message: { content: 'hmm' } }] } }));
    try {
      const events: Record<string, unknown>[] = [];
      const state = new GameState('quick');
      applyBenchAction(state, 1, { action: 'place', anchor: [1, 2], preset: 'Heart' });
      await runLLMBuildPhase(state, 1, s.client({ maxTokens: 100 }), { log: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Parameters<typeof runLLMBuildPhase>[3]);
      assert(s.maxTokens.length === 2, `${finish}: ${s.maxTokens.length} requests`);
      assert(finish === 'stop' ? s.maxTokens.every(m => m === 100) : JSON.stringify(s.maxTokens) === '[100,200]', `${finish}: ${JSON.stringify(s.maxTokens)}`);
      assert(events.filter(e => e.type === 'llm_bad_response').length === 1 && events.some(e => e.type === 'auto_skip'), `${finish}: bad response then auto_skip`);
    } finally { s.close(); }
  }
});

test('cost guard: a bad response on the escalated retry is final (no third request)', async () => {
  const s = await scriptedServer(n => ({ body: n === 1 ? toolResponse(fullArgs, 'length') : { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } }));
  try {
    await rejects(s.client({ maxTokens: 100 }).getAction(obs1(), ['Block']), /no tool call/, 'escalated bad');
    assert(s.maxTokens.length === 2, `requests: ${s.maxTokens.length}`);
  } finally { s.close(); }
});

test('cost guard: cap trips mid-turn => the escalated retry is NOT sent (counted at the server), match ends cost-capped', async () => {
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length'), cost: '0.004' }));
  try {
    const events: Record<string, unknown>[] = [];
    const r = await runMatch('skirmish', s.client({ maxTokens: 100 }), 'baseline', { log: e => { events.push(e); } }, { roundPauseMs: 0, maxUsd: 0.003 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(s.maxTokens.length === 1, `requests sent: ${JSON.stringify(s.maxTokens)}`);
    assert(r.aborted === true && r.costCap === true && Math.abs((r.costUsd ?? 0) - 0.004) < 1e-12, JSON.stringify(r));
    assert(events.filter(e => e.type === 'match_cost_cap').length === 1, 'cap row logged once');
  } finally { s.close(); }
});

test('cost guard: both seats stop sending once the cap trips (no requests after the cap, any retries included)', async () => {
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length'), cost: '0.004' }));
  try {
    const r = await runMatch('skirmish', s.client({ maxTokens: 100 }), s.client({ maxTokens: 100 }), { log() {} }, { roundPauseMs: 0, maxUsd: 0.003 });
    await new Promise(resolve => setTimeout(resolve, 50));
    // Each seat's first request is already in flight when the cap trips (first response 0.004 >= 0.003); nothing after that may go out.
    assert(r.costCap === true && s.maxTokens.length === 2 && s.maxTokens.every(m => m === 100), `requests sent: ${JSON.stringify(s.maxTokens)}`);
  } finally { s.close(); }
});

// ---------- Fix wave: budgets, rate limits, lenient fields, resume, prompt, video ----------

const PRICED = { inputPricePerM: 2, outputPricePerM: 10 };

test('cost (A2): a request whose worst case could pass the match cap is refused BEFORE it is sent', async () => {
  // First request reserves 10k prompt x $2/M + 2000 x $10/M = $0.04 (<= $0.05): admitted, bills $0.035. The next one reserves ~$0.02 on top of $0.035: refused.
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: '0.035' }));
  try {
    const events: Record<string, unknown>[] = [];
    const r = await runMatch('skirmish', s.client({ maxTokens: 2000, ...PRICED }), 'baseline', { log: e => { events.push(e); } }, { roundPauseMs: 0, maxUsd: 0.05 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(s.maxTokens.length === 1, `requests sent: ${s.maxTokens.length}`);
    assert(r.aborted === true && r.costCap === true && Math.abs((r.costUsd ?? 0) - 0.035) < 1e-12, JSON.stringify(r));
    const cap = events.filter(e => e.type === 'match_cost_cap');
    assert(cap.length === 1 && typeof cap[0].reservationUsd === 'number', JSON.stringify(cap));
  } finally { s.close(); }
});

test('cost (A2): two seats cannot both have a worst-case request in flight under a cap that fits only one', async () => {
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: '0.001' }));
  try {
    const r = await runMatch('skirmish', s.client({ maxTokens: 2000, ...PRICED }), s.client({ maxTokens: 2000, ...PRICED }), { log() {} }, { roundPauseMs: 0, maxUsd: 0.05 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(r.costCap === true && s.maxTokens.length === 1, `requests sent: ${s.maxTokens.length}, ${JSON.stringify(r)}`);
  } finally { s.close(); }
});

test('cost (A2): the tournament USD cap is enforced the same way (match voided as budget, tournament stops, nothing past the cap is sent)', async () => {
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: '0.035' }));
  try {
    await withTempDir(async dir => {
      const out = await runTournament({ ...QUICK, models: ['paid', 'baseline'], gamesPerPair: 2, id: 'tb', baseDir: dir, maxUsd: 0.05, createController: tourneyFactory({ paid: s.client({ maxTokens: 2000, ...PRICED }) }) });
      const [row] = readRows(dir, 'tb');
      assert(row.void && row.voidReason === 'budget' && out.stoppedForBudget && out.rows.length === 1, JSON.stringify(row));
      assert(s.maxTokens.length === 1, `requests sent: ${s.maxTokens.length}`);
    });
  } finally { s.close(); }
});

test('cost (A1): the tournament passes a per-match cap (default $3, matchMaxUsd) to every match and says so when a match is voided by it', async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await withTempDir(async dir => {
      const counter = { calls: 0 };
      // $1.30 per call: the default $3 cap trips on the 3rd call ($3.90), not at the old standalone $1.00 default.
      await runTournament({ preset: 'skirmish', maxRounds: 2, roundPauseMs: 0, models: ['paid', 'baseline'], gamesPerPair: 2, id: 'pc', baseDir: dir, createController: tourneyFactory({ paid: pricedClient('paid', 1.3, counter) }) });
      const rows = readRows(dir, 'pc');
      assert(rows.every(r => r.void && r.voidReason === 'cost cap'), JSON.stringify(rows.map(r => r.voidReason)));
      assert(rows[0].costUsd && Math.abs(rows[0].costUsd.p1 + rows[0].costUsd.p2 - 3.9) < 1e-9, JSON.stringify(rows[0].costUsd));
    });
  } finally { console.log = realLog; }
  assert(lines.some(l => l.includes('per match') && l.includes('$3.00')), 'the per-match cap is announced up front');
  assert(lines.some(l => l.includes('COST CAP') && l.includes('VOID')), 'a cost-cap void is reported clearly: ' + lines.join(' | '));
});

test('cost (A3): a missing or invalid cost header is estimated from usage x prices; a valid header wins; unpriced stays 0', async () => {
  const noHeader = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls') }));
  try {
    const r = await noHeader.client({ maxTokens: 1000, ...PRICED }).getAction(obs1(), ['Block']);
    // usage is 10 prompt + 20 completion tokens: (10 x 2 + 20 x 10) / 1e6
    assert(r.costSource === 'estimated' && Math.abs((r.costUsd ?? 0) - 0.00022) < 1e-12, JSON.stringify([r.costUsd, r.costSource]));
    const plain = await noHeader.client({ maxTokens: 1000 }).getAction(obs1(), ['Block']);
    assert(plain.costUsd === 0 && plain.costSource === 'none', JSON.stringify([plain.costUsd, plain.costSource]));
  } finally { noHeader.close(); }
  const bogus = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: 'abc' }));
  try {
    const r = await bogus.client({ maxTokens: 1000, ...PRICED }).getAction(obs1(), ['Block']);
    assert(r.costSource === 'estimated', 'an invalid header falls back to the estimate: ' + r.costSource);
  } finally { bogus.close(); }
  const header = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'tool_calls'), cost: '0.5' }));
  try {
    const r = await header.client({ maxTokens: 1000, ...PRICED }).getAction(obs1(), ['Block']);
    assert(r.costSource === 'header' && r.costUsd === 0.5, JSON.stringify([r.costUsd, r.costSource]));
  } finally { header.close(); }
  const bad = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  const usage: { costUsd?: number; costSource?: string }[] = [];
  try {
    await rejects(bad.client({ maxTokens: 100, ...PRICED }).getAction(obs1(), ['Block'], undefined, { usage: u => usage.push(u) }), /truncated/, 'bad');
    assert(usage.length === 2 && usage.every(u => u.costSource === 'estimated' && (u.costUsd ?? 0) > 0), 'unusable responses are costed too: ' + JSON.stringify(usage));
  } finally { bad.close(); }
});

test('cost (A3): timeouts, 5xx and network failures with no usage are charged the reservation (costSource reserved); 429 and 4xx are not', async () => {
  const probe = async (url: string, timeoutMs: number) => {
    const usage: { costUsd?: number; costSource?: string }[] = [];
    let reserved = 0;
    let released = 0;
    try {
      await postJsonWithRetry('t', url, {}, {}, () => 1, { usage: u => usage.push(u), reserve: usd => { reserved += usd; return () => { released++; }; } }, { retryDelaysMs: [0], timeoutMs, reservationUsd: () => 0.07 });
    } catch { /* expected: every attempt fails */ }
    return { usage, reserved, released };
  };
  const serve = async (handler: (res: import('node:http').ServerResponse) => void) => {
    const server = createServer((_req, res) => handler(res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    return { url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`, close: () => { server.closeAllConnections?.(); server.close(); } };
  };
  const hang = await serve(() => { /* never answers */ });
  try {
    const r = await probe(hang.url, 80);
    assert(r.usage.length === 2 && r.usage.every(u => u.costUsd === 0.07 && u.costSource === 'reserved'), 'timeouts: ' + JSON.stringify(r.usage));
    assert(r.released === 2 && Math.abs(r.reserved - 0.14) < 1e-12, 'reservations are taken per attempt and released');
  } finally { hang.close(); }
  const five = await serve(res => { res.writeHead(502); res.end('bad gateway'); });
  try {
    const r = await probe(five.url, 5000);
    assert(r.usage.length === 2 && r.usage.every(u => u.costSource === 'reserved'), '5xx: ' + JSON.stringify(r.usage));
  } finally { five.close(); }
  const limited = await serve(res => { res.writeHead(429); res.end('slow down'); });
  try {
    const r = await probe(limited.url, 5000);
    assert(r.usage.length === 0 && r.released === 2, '429 is rejected by the limiter, not billed: ' + JSON.stringify(r.usage));
  } finally { limited.close(); }
  const closed = await serve(() => {});
  const deadUrl = closed.url;
  closed.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  const net = await probe(deadUrl, 5000);
  assert(net.usage.length === 2 && net.usage.every(u => u.costSource === 'reserved'), 'network failure: ' + JSON.stringify(net.usage));
});

test('config (A3): every litellm entry carries both prices, with the values from LiteLLM', () => {
  const lite = MODEL_REGISTRY.filter(m => m.provider === 'litellm');
  for (const m of lite) assert(typeof m.inputPricePerM === 'number' && typeof m.outputPricePerM === 'number' && m.inputPricePerM > 0 && m.outputPricePerM > 0, `${m.key} prices`);
  const price = (key: string) => { const m = getModelEntry(key); return `${m.inputPricePerM}/${m.outputPricePerM}`; };
  assert(price('litellm-claude-sonnet-5-5') === '2/10' && price('litellm-gpt-6-luna') === '0.1/0.5' && price('litellm-kimi-k3') === '3/15' && price('litellm-deepseek-v4.1-flash') === '0.02/0.396', 'spot values');
});

test('limiter (A4): the limiter is taken before EVERY HTTP attempt: retries and the truncation escalation each need a slot', async () => {
  let acquires = 0;
  const slot = async () => { acquires++; return 1200; };
  const throttled: number[] = [];
  let hit = 0;
  const server = createServer((_req, res) => {
    hit++;
    if (hit === 1) { res.writeHead(429); res.end('slow'); } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  try {
    await postJsonWithRetry('t', `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`, {}, {}, () => 1, { throttled: i => throttled.push(i.waitMs) }, { retryDelaysMs: [5], acquire: slot });
    assert(acquires === 2 && hit === 2, `429 retry: ${acquires} slots for ${hit} requests`);
    assert(throttled.length === 2 && throttled.every(w => w === 1200), 'throttled is reported per attempt');
  } finally { server.closeAllConnections?.(); server.close(); }

  let slots = 0;
  const limiter = { acquire: async () => { slots++; return 0; } } as unknown as MinIntervalLimiter;
  const s = await scriptedServer(() => ({ body: toolResponse(fullArgs, 'length') }));
  try {
    await rejects(s.client({ maxTokens: 100, limiter }).getAction(obs1(), ['Block']), /truncated/, 'truncated');
    assert(s.maxTokens.length === 2 && slots === 2, `escalation: ${slots} slots for ${s.maxTokens.length} requests`);
  } finally { s.close(); }
});

test('rate limit (C): Retry-After (seconds or HTTP date) is parsed and capped at 120 s', () => {
  assert(parseRetryAfter('3') === 3000 && parseRetryAfter('0') === 0 && parseRetryAfter(' 1.5 ') === 1500, 'delta seconds');
  assert(parseRetryAfter('9999') === 120_000, 'capped at 120 s');
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now) === 10_000, 'HTTP date');
  assert(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now) === 0, 'a date in the past is no wait');
  assert(parseRetryAfter('Fri, 02 Jan 2026 00:00:00 GMT', now) === 120_000, 'a far date is capped');
  assert(parseRetryAfter('soon') === undefined && parseRetryAfter('') === undefined && parseRetryAfter(null) === undefined && parseRetryAfter(undefined) === undefined, 'absent or invalid');
});

test('rate limit (C): a 429 with Retry-After waits that long instead of the fixed backoff', async () => {
  let hit = 0;
  const server = createServer((_req, res) => {
    hit++;
    if (hit === 1) { res.writeHead(429, { 'Retry-After': '1' }); res.end('slow down'); } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const failures: AttemptFailure[] = [];
  try {
    const t0 = Date.now();
    await postJsonWithRetry('t', `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`, {}, {}, () => 1, { attemptFailed: i => failures.push(i) }, { retryDelaysMs: [5000] });
    const elapsed = Date.now() - t0;
    assert(elapsed >= 900 && elapsed < 4000, `waited ${elapsed} ms: Retry-After (1 s), not the 5 s backoff`);
    assert(failures.length === 1 && failures[0].retryInMs === 1000, JSON.stringify(failures));
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('rate limit (C): litellm defaults to 1500 ms per model, both seats on one model share a limiter, minIntervalMs overrides', () => {
  const saved = { key: process.env.LITELLM_API_KEY, url: process.env.LITELLM_BASE_URL, interval: process.env.BENCH_MIN_CALL_INTERVAL_MS };
  process.env.LITELLM_API_KEY = 'test-key';
  process.env.LITELLM_BASE_URL = 'http://127.0.0.1:1';
  delete process.env.BENCH_MIN_CALL_INTERVAL_MS;
  try {
    const base: ModelEntry = { key: 'rl-a', provider: 'litellm', modelId: 'm', nativeToolCalling: true };
    const limiterOf = (c: unknown) => (c as { limiter: MinIntervalLimiter }).limiter;
    const seat1 = limiterOf(createClient(base));
    const seat2 = limiterOf(createClient(base));
    const other = limiterOf(createClient({ ...base, key: 'rl-b' }));
    const custom = limiterOf(createClient({ ...base, key: 'rl-c', minIntervalMs: 700 }));
    assert(seat1.intervalMs === 1500, `default ${seat1.intervalMs}`);
    assert(seat1 === seat2, 'both seats of one model share the limiter');
    assert(other !== seat1 && other.intervalMs === 1500, 'another model has its own');
    assert(custom.intervalMs === 700, 'per-model minIntervalMs');
  } finally {
    for (const [name, v] of [['LITELLM_API_KEY', saved.key], ['LITELLM_BASE_URL', saved.url], ['BENCH_MIN_CALL_INTERVAL_MS', saved.interval]] as const) {
      if (v === undefined) delete process.env[name]; else process.env[name] = v;
    }
  }
});

test('rate limit (C): matchPauseMs rests between played matches (not before the first)', async () => {
  await withTempDir(async dir => {
    const t0 = Date.now();
    const out = await runTournament({ ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 4, id: 'pause', baseDir: dir, createController: tourneyFactory(), matchPauseMs: 300 });
    const elapsed = Date.now() - t0;
    assert(out.rows.length === 4, '4 matches');
    assert(elapsed >= 850, `3 pauses of 300 ms between 4 matches, took ${elapsed} ms`);
  });
});

test('required fields (A5): the loop records a missing_fields_warning row and still applies the call', async () => {
  const state = new GameState('quick');
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => { events.push(e); } } as unknown as Parameters<typeof runLLMBuildPhase>[3];
  const client: LLMClient = { provider: 'fake', modelId: 'f', async getAction() { return { actions: [{ action: 'submit' }], latencyMs: 1, missingFields: ['analysis', 'notes'] }; } };
  applyBenchAction(state, 1, { action: 'place', anchor: [1, 2], preset: 'Heart' });
  await runLLMBuildPhase(state, 1, client, logger);
  const warn = events.find(e => e.type === 'missing_fields_warning');
  assert(warn && JSON.stringify(warn.fields) === '["analysis","notes"]' && warn.playerId === 1, JSON.stringify(warn));
  assert(events.some(e => e.type === 'turn') && state.players[0].committed, 'the call was applied');
});

test('required fields (A5): AI Studio uses the same rule (empty prose accepted, missing placements rejected)', async () => {
  const realFetch = globalThis.fetch;
  const reply = (args: Record<string, unknown>) => (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'place', args } }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const client = new AiStudioClient('m', 'k');
    globalThis.fetch = reply({ placements: [{ anchor: [1, 1], preset: 'Block' }], end_turn: true });
    const r = await client.getAction(obs1(), ['Block']);
    assert(r.actions.length === 2 && JSON.stringify(r.missingFields) === '["analysis","rationale","notes"]', JSON.stringify(r));
    globalThis.fetch = reply({ analysis: 'a', rationale: 'r', notes: 'n' });
    await rejects(client.getAction(obs1(), ['Block']), /missing required fields: placements/, 'no placements');
  } finally { globalThis.fetch = realFetch; }
});

test('resume (A6): maxRounds, preset, games and models are saved in meta.json and a mismatch is a clear error', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 4, id: 'mr', baseDir: dir, createController: tourneyFactory() };
    await runTournament({ ...base, maxRounds: 1, maxMatches: 1 });
    const meta = JSON.parse(readFileSync(join(dir, 'mr', 'meta.json'), 'utf8')) as { maxRounds: number | null; gamesPerPair: number; preset: string; models: string[] };
    assert(meta.maxRounds === 1 && meta.gamesPerPair === 4 && meta.preset === 'skirmish' && meta.models.join() === 'fa,baseline', JSON.stringify(meta));
    await rejects(runTournament({ ...base, maxRounds: 2 }), /Cannot resume.*maxRounds 1 -> 2/, 'maxRounds 1 -> 2');
    await rejects(runTournament({ ...base, maxRounds: undefined }), /maxRounds 1 -> preset default/, 'maxRounds -> default');
    await rejects(runTournament({ ...base, maxRounds: 1, gamesPerPair: 2 }), /games per pair 4 -> 2/, 'games');
    assert(readRows(dir, 'mr').length === 1, 'nothing was appended by the refused runs');
    const ok = await runTournament({ ...base, maxRounds: 1 });
    assert(ok.skipped === 1 && ok.rows.length === 3, 'same settings resume');
    rmSync(join(dir, 'mr', 'meta.json'));
    const legacy = await runTournament({ ...base, maxRounds: 3 });
    assert(legacy.rows.length === 0 && (JSON.parse(readFileSync(join(dir, 'mr', 'meta.json'), 'utf8')) as { maxRounds: number }).maxRounds === 3, 'a tournament without meta.json gets the current settings saved');
  });
});

test('prompt (A7): only heart CELLS are fixed obstacles; the rest of the box is empty space (but a target region)', () => {
  assert(SYSTEM_PROMPT.includes('Only the squares in heartCells are fixed obstacles') && SYSTEM_PROMPT.includes('the rest of heartZone is ordinary empty space'), 'states the fixed cells vs the empty box');
  assert(!SYSTEM_PROMPT.includes('full of live cells'), 'no wording that the whole box is occupied');
  assert(!/overlap your Heart box|clear of your own Heart box|through your own cells, your own Heart box/.test(SYSTEM_PROMPT + JSON.stringify(TOOL_DEFS)), 'no advice that treats the whole box as an obstacle');
  assert(SYSTEM_PROMPT.includes('visibilityMode "visible"'), 'opponent heart visibility depends on the mode, not only "round 2"');
});

test('post-mortem (A8): passing beside the Heart box without touching a fixed Heart cell is NOT blamed on the Heart; touching one is', () => {
  const near = duelGame();
  placeRemembered(near.state, near.memory, { action: 'place', anchor: [6, 5], preset: 'Glider', rotation: 0 });
  const line = playAndReport(near.state, near.memory)[1].find(l => l.startsWith('#1 Glider'))!;
  assert(!line.includes('ran into your own Heart'), 'false blame: ' + line);
  const hit = duelGame();
  placeRemembered(hit.state, hit.memory, { action: 'place', anchor: [3, 8], preset: 'Glider', rotation: 2 });
  const hitLine = playAndReport(hit.state, hit.memory)[1].find(l => l.startsWith('#1 Glider'))!;
  assert(hitLine.includes('ran into your own Heart box'), 'real contact is still reported: ' + hitLine);
});

test('leaderboard (A9): bootstrap resamples within each pair, so every pair and model (baseline included) is in every replicate', () => {
  const games = [
    ...Array.from({ length: 6 }, (_, i) => ({ a: 'x', b: 'y', score: i % 2 })),
    { a: 'baseline', b: 'x', score: 0 },
    { a: 'y', b: 'baseline', score: 1 },
  ];
  let seed = 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) {
    const sample = stratifiedResample(games, rng);
    const count = (a: string, b: string) => sample.filter(g => (g.a === a && g.b === b) || (g.a === b && g.b === a)).length;
    assert(count('x', 'y') === 6 && count('baseline', 'x') === 1 && count('baseline', 'y') === 1, `replicate ${i} lost or duplicated a pair`);
  }
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => lbRow(i, 'x', 'y', i % 2 ? 'a' : 'b')),
    lbRow(6, 'baseline', 'x', 'b'),
    lbRow(7, 'y', 'baseline', 'a'),
  ];
  const lb = computeLeaderboard(rows, { bootstrap: 100 });
  const base = lb.models.find(m => m.model === 'baseline')!;
  assert(lb.anchor === 'baseline' && base.ciLow === 1000 && base.ciHigh === 1000, `baseline stays the anchor in every replicate: ${base.ciLow}..${base.ciHigh}`);
  assert(lb.models.every(m => m.ciLow !== null && m.ciHigh !== null), 'every model has a CI');
});

test('spectator (A10): a client is registered before the history replay, so an event logged during catch-up arrives once, in order', () => {
  const hub = createEventHub();
  const feed = hub.wrap({ log() {} });
  feed.log({ type: 'a' });
  feed.log({ type: 'b' });
  const written: string[] = [];
  let injected = false;
  const res = {
    writeHead() {},
    write(chunk: string) {
      written.push(chunk);
      if (!injected) { injected = true; feed.log({ type: 'during' }); }
      return true;
    },
    end() {},
  };
  hub.attach({ on() {} } as never, res as never);
  feed.log({ type: 'after' });
  const types = written.map(w => (JSON.parse(w.replace(/^data: /, '').trim()) as { type: string }).type);
  assert(JSON.stringify(types) === '["a","b","during","after"]', JSON.stringify(types));
});

test('leaderboard (A11): tournament list counts latest-per-index rows and ignores a truncated tail', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'cnt'), { recursive: true });
    const rows = [lbRow(0, 'x', 'y', 'void'), lbRow(1, 'x', 'y', 'a'), lbRow(0, 'x', 'y', 'b')];
    writeFileSync(join(dir, 'cnt', 'results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n{"index":2,"tourn');
    const info = listTournaments(dir).find(t => t.id === 'cnt')!;
    assert(info.matches === 2, `3 raw lines + a cut tail are 2 matches, got ${info.matches}`);
  });
});

test('video (D): ffmpeg is found via FFMPEG_PATH, PATH (Windows rules), winget links and packages; a wrong FFMPEG_PATH is an error', async () => {
  const have = new Set(['C:\\tools\\ffmpeg.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe']);
  const win = (env: NodeJS.ProcessEnv) => ({ platform: 'win32' as const, env, exists: (p: string) => have.has(p) });
  assert(findFfmpeg(win({ FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe', PATH: '' })) === 'C:\\tools\\ffmpeg.exe', 'FFMPEG_PATH');
  assert(findFfmpeg(win({ PATH: 'C:\\nothing;"C:\\tools"' })) === 'C:\\tools\\ffmpeg.exe', 'PATH split with ; and .exe added');
  assert(findFfmpeg(win({ PATH: '', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })) === 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe', 'winget links');
  await rejects(Promise.resolve().then(() => findFfmpeg(win({ FFMPEG_PATH: 'C:\\nope\\ffmpeg.exe', PATH: 'C:\\tools' }))), /FFMPEG_PATH is set to .* does not exist/, 'wrong FFMPEG_PATH');
  await rejects(Promise.resolve().then(() => findFfmpeg(win({ PATH: 'C:\\nothing' }))), /ffmpeg not found.*FFMPEG_PATH/, 'not found');
  assert(findFfmpeg({ platform: 'linux', env: { PATH: '/a:/usr/bin' }, exists: p => p === '/usr/bin/ffmpeg' }) === '/usr/bin/ffmpeg', 'POSIX PATH split with :');
  if (process.platform === 'win32') {
    const local = mkdtempSync(join(tmpdir(), 'gameofdeath-winget-'));
    try {
      const bin = join(local, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_x', 'ffmpeg-9.0.2-full_build', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'ffmpeg.exe'), '');
      assert(findFfmpeg({ platform: 'win32', env: { PATH: '', LOCALAPPDATA: local } }) === join(bin, 'ffmpeg.exe'), 'winget Gyan.FFmpeg package folder');
    } finally { rmSync(local, { recursive: true, force: true }); }
  }
});

test('video (D): Chrome is found via CHROME_PATH, PATH, the standard Windows install folders, then Edge; a wrong CHROME_PATH is an error', async () => {
  const have = new Set<string>();
  const ctx = (platform: 'win32' | 'linux', env: NodeJS.ProcessEnv) => ({ platform, env, exists: (p: string) => have.has(p) });
  const winEnv = { PATH: '', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  await rejects(Promise.resolve().then(() => findChrome(ctx('win32', winEnv))), /Chrome\/Chromium not found/, 'nothing installed');
  have.add(edge);
  assert(findChrome(ctx('win32', winEnv)) === edge, 'Edge as the fallback');
  have.add(chrome);
  assert(findChrome(ctx('win32', winEnv)) === chrome, 'standard Chrome folder wins over Edge');
  have.add('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  have.delete(chrome);
  assert(findChrome(ctx('win32', winEnv)) === 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', 'per-user Chrome before Edge');
  have.add('D:\\bin\\chrome.exe');
  assert(findChrome(ctx('win32', { ...winEnv, PATH: 'C:\\x;D:\\bin' })) === 'D:\\bin\\chrome.exe', 'PATH split with ;');
  assert(findChrome(ctx('win32', { ...winEnv, CHROME_PATH: 'D:\\bin\\chrome.exe' })) === 'D:\\bin\\chrome.exe', 'CHROME_PATH');
  await rejects(Promise.resolve().then(() => findChrome(ctx('win32', { ...winEnv, CHROME_PATH: 'D:\\gone\\chrome.exe' }))), /CHROME_PATH is set to/, 'wrong CHROME_PATH');
  have.add('/usr/bin/chromium');
  assert(findChrome(ctx('linux', { PATH: '/opt:/usr/bin' })) === '/usr/bin/chromium', 'POSIX PATH split with :');
});

test('video (D): auto-export renders each non-void tournament match to <videoDir>/<id>/<log base>.mp4; a failing export is recorded and never fails the tournament', async () => {
  await withTempDir(async dir => {
    const videoDir = join(dir, 'videos');
    const jobs: { logPath: string; outPath: string }[] = [];
    const ok = await runTournament({
      ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 2, id: 'vid', baseDir: dir, videoDir, createController: tourneyFactory(),
      exportVideo: async job => { jobs.push(job); assert(existsSync(job.logPath), 'the finished log exists'); mkdirSync(dirname(job.outPath), { recursive: true }); writeFileSync(job.outPath, 'mp4'); },
    });
    assert(ok.rows.length === 2 && jobs.length === 2, `${ok.rows.length} matches, ${jobs.length} exports`);
    for (const row of ok.rows) {
      const base = row.logFile.split('/').pop()!.replace(/\.jsonl$/, '');
      assert(existsSync(join(videoDir, 'vid', `${base}.mp4`)), `video for ${base}`);
    }
    const side = readFileSync(join(dir, 'vid', 'videos.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { index: number; video?: string });
    assert(side.length === 2 && side.every(s => typeof s.video === 'string' && s.video.endsWith('.mp4')), JSON.stringify(side));

    const failed = await runTournament({
      ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 2, id: 'vid2', baseDir: dir, videoDir, createController: tourneyFactory(),
      exportVideo: async () => { throw new Error('chrome exploded'); },
    });
    assert(failed.rows.length === 2 && failed.rows.every(r => !r.void), 'the tournament still finishes with valid rows');
    const errs = readFileSync(join(dir, 'vid2', 'videos.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { videoError?: string });
    assert(errs.length === 2 && errs.every(e => e.videoError === 'chrome exploded'), JSON.stringify(errs));

    const boom: LLMClient = { provider: 'fake', modelId: 'boom', async getAction() { throw new ProviderUnavailableError('down'); } };
    let calls = 0;
    await runTournament({ ...QUICK, models: ['b', 'baseline'], gamesPerPair: 2, id: 'vid3', baseDir: dir, videoDir, createController: tourneyFactory({ b: boom }), exportVideo: async () => { calls++; } });
    assert(calls === 0, 'void matches are not exported');
  });
});

test('video (D): the leaderboard match list links a video only when the file exists, and the studio serves it', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 't1'), { recursive: true });
    writeFileSync(join(dir, 't1', 'results.jsonl'), [lbRow(0, 'x', 'y', 'a'), lbRow(1, 'x', 'y', 'b')].map(r => JSON.stringify(r)).join('\n') + '\n');
    const videoDir = join(dir, 'videos');
    mkdirSync(join(videoDir, 't1'), { recursive: true });
    writeFileSync(join(videoDir, 't1', 'match-0.mp4'), 'mp4data');
    const lb = leaderboardResponse('t1', dir, {}, videoDir);
    assert(lb.matchList[0].video === 'match-0.mp4' && lb.matchList[1].video === undefined, JSON.stringify(lb.matchList.map(m => m.video)));
    const handle = await startStudio({ port: 0, distDir: join(dir, 'dist'), logDir: join(dir, 'logs'), videoDir, tournamentDir: dir, tournamentVideoDir: videoDir, quiet: true });
    try {
      const url = 'http://127.0.0.1:' + handle.port;
      const res = await fetch(url + '/api/tournaments/t1/video/match-0.mp4');
      assert(res.status === 200 && res.headers.get('content-type') === 'video/mp4' && (await res.text()) === 'mp4data', 'video served');
      assert((await fetch(url + '/api/tournaments/t1/video/match-1.mp4')).status === 404, 'missing video is 404');
      assert((await fetch(url + '/api/tournaments/t1/video/..%2f..%2fx.mp4')).status === 404, 'traversal is 404');
      const api = (await (await fetch(url + '/api/leaderboard?id=t1')).json()) as { matchList: { video?: string }[] };
      assert(api.matchList[0].video === 'match-0.mp4', 'the API carries the link');
    } finally { handle.close(); }
  });
});

test('video (D): studio auto-exports a finished match through the normal export job (STUDIO_AUTO_EXPORT), and not when disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-auto-'));
  const exporter = join(dir, 'fake-exporter.js');
  writeFileSync(exporter, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const a = process.argv;",
    "const out = a[a.indexOf('--out') + 1];",
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(out, 'mp4');",
    "console.log('PROGRESS 1/1');",
  ].join('\n'));
  const open = (autoExport: boolean) => startStudio({
    port: 0, distDir: join(dir, 'dist'), logDir: join(dir, autoExport ? 'logs-on' : 'logs-off'), videoDir: join(dir, autoExport ? 'v-on' : 'v-off'), simDelayMs: 0, quiet: true,
    autoExport, exporterPath: exporter,
    controllerFactory: (p1Key, p2Key) => ({ p1: scriptedClient(p1Key), p2: p2Key ? scriptedClient(p2Key) : 'baseline' }),
  });
  try {
    for (const autoExport of [true, false]) {
      const handle = await open(autoExport);
      try {
        const base = `http://127.0.0.1:${handle.port}`;
        const started = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p1: 'model-a', p2: 'baseline', preset: 'skirmish', roundPauseSec: 0 }) });
        const { id } = (await started.json()) as { id: string };
        await waitFor(async () => ((await (await fetch(`${base}/api/matches`)).json()) as { matches: { id: string; status: string }[] }).matches.find(m => m.id === id)?.status === 'finished', 'the match to finish');
        const state = async () => ((await (await fetch(`${base}/api/matches/${id}/export`)).json()) as { state: string }).state;
        if (autoExport) {
          await waitFor(async () => (await state()) === 'done', 'the automatic export');
          assert(existsSync(join(dir, 'v-on', `${id}.mp4`)), 'the video was written without any export request');
          assert((await fetch(`${base}/api/matches/${id}/video`)).status === 200, 'and is served');
        } else {
          await new Promise(resolve => setTimeout(resolve, 300));
          assert((await state()) === 'none' && !existsSync(join(dir, 'v-off', `${id}.mp4`)), 'no export when autoExport is off');
        }
      } finally { handle.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Streaming + sharding ----------

const sseFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const toolArgs = JSON.stringify({ analysis: 'a', rationale: 'r', notes: 'n', placements: [{ anchor: [1, 1], preset: 'Block' }], end_turn: true });

/** An SSE chat-completions reply, as LiteLLM sends it: reasoning deltas, tool_call deltas split mid-JSON, a finish chunk, then a usage-only chunk. */
function sseBody(usage: Record<string, number>): string {
  const cut = Math.floor(toolArgs.length / 2);
  return [
    sseFrame({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'place', arguments: '' } }] } }] }),
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(0, cut) } }] } }] }),
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: toolArgs.slice(cut) } }] } }] }),
    sseFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    sseFrame({ choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('');
}

async function withSseServer<T>(text: string, fn: (endpoint: string, seen: { body?: Record<string, unknown> }) => Promise<T>): Promise<T> {
  const seen: { body?: Record<string, unknown> } = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      seen.body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Odd 7-byte network chunks: frames and JSON arrive torn apart.
      let i = 0;
      const pump = () => { if (i >= text.length) { res.end(); return; } res.write(text.slice(i, i + 7)); i += 7; setImmediate(pump); };
      pump();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  try { return await fn(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`, seen); }
  finally { server.closeAllConnections?.(); server.close(); }
}

test('stream: SSE deltas are reassembled into one tool call with finish reason and usage', async () => {
  const stream = new Response(sseBody({ prompt_tokens: 7, completion_tokens: 9, cost: 0.5 })).body!;
  const r = await readChatCompletionStream(stream);
  const call = r.choices[0].message.tool_calls?.[0];
  assert(call?.function.name === 'place' && call.function.arguments === toolArgs, `args ${call?.function.arguments}`);
  assert(r.choices[0].finish_reason === 'tool_calls' && r.usage?.prompt_tokens === 7 && r.usage.cost === 0.5, JSON.stringify(r.usage));
});

test('stream: client with stream=true sends stream+include_usage and returns the parsed action (torn chunks)', async () => {
  await withSseServer(sseBody({ prompt_tokens: 1000, completion_tokens: 2000 }), async (endpoint, seen) => {
    const client = new OpenAICompatibleClient({ provider: 'x', endpoint, modelId: 'm', apiKey: 'k', stream: true });
    const r = await client.getAction(obs1(), ['Block']);
    assert(seen.body?.stream === true && JSON.stringify(seen.body.stream_options) === '{"include_usage":true}', JSON.stringify(seen.body));
    assert(r.actions.length === 2 && r.finishReason === 'tool_calls' && r.promptTokens === 1000 && r.completionTokens === 2000, JSON.stringify(r));
  });
});

test('stream: without stream the body has no stream fields', async () => {
  const req = await captureLitellmRequest(LITELLM_TEST_ENTRY);
  assert(req.body.stream === undefined && req.body.stream_options === undefined, 'no stream fields');
});

test('stream: no cost header, so cost is estimated from usage x prices', async () => {
  await withSseServer(sseBody({ prompt_tokens: 1000, completion_tokens: 2000 }), async endpoint => {
    const client = new OpenAICompatibleClient({ provider: 'x', endpoint, modelId: 'm', apiKey: 'k', stream: true, inputPricePerM: 2, outputPricePerM: 6 });
    const r = await client.getAction(obs1(), ['Block']);
    assert(r.costSource === 'estimated' && Math.abs((r.costUsd ?? 0) - 0.014) < 1e-9, `${r.costSource} ${r.costUsd}`);
  });
});

test('stream: a proxy-reported usage.cost wins over the estimate', async () => {
  await withSseServer(sseBody({ prompt_tokens: 1000, completion_tokens: 2000, cost: 0.2 }), async endpoint => {
    const client = new OpenAICompatibleClient({ provider: 'x', endpoint, modelId: 'm', apiKey: 'k', stream: true, inputPricePerM: 2, outputPricePerM: 6 });
    const r = await client.getAction(obs1(), ['Block']);
    assert(r.costSource === 'header' && r.costUsd === 0.2, `${r.costSource} ${r.costUsd}`);
  });
});

test('shard: parseShard accepts k/n (0-based) and rejects junk', () => {
  const s = parseShard('1/3');
  assert(s.k === 1 && s.n === 3, JSON.stringify(s));
  for (const bad of ['3/3', '0/0', 'a/b', '1', '-1/2']) {
    let threw = false;
    try { parseShard(bad); } catch { threw = true; }
    assert(threw, `"${bad}" should be rejected`);
  }
});

test('shard: workers partition indices by index % n and share one results.jsonl and one meta.json', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 6, id: 'sh', baseDir: dir, createController: tourneyFactory() };
    const [a, b] = await Promise.all([runTournament({ ...base, shard: { k: 0, n: 2 } }), runTournament({ ...base, shard: { k: 1, n: 2 } })]);
    assert(a.rows.map(r => r.index).join() === '0,2,4' && b.rows.map(r => r.index).join() === '1,3,5', `${a.rows.map(r => r.index)} / ${b.rows.map(r => r.index)}`);
    const rows = readRows(dir, 'sh');
    assert(rows.length === 6 && [...new Set(rows.map(r => r.index))].length === 6, `rows ${rows.map(r => r.index)}`);
    const meta = JSON.parse(readFileSync(join(dir, 'sh', 'meta.json'), 'utf8')) as { gamesPerPair: number };
    assert(meta.gamesPerPair === 6, 'meta written once and intact');
  });
});

test('shard: resume per shard skips its finished indices and leaves the other shard alone', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['fa', 'baseline'], gamesPerPair: 4, id: 'shr', baseDir: dir, createController: tourneyFactory() };
    await runTournament({ ...base, shard: { k: 0, n: 2 } });
    const again = await runTournament({ ...base, shard: { k: 0, n: 2 } });
    assert(again.rows.length === 0 && again.skipped === 2, `skipped ${again.skipped}, ran ${again.rows.length}`);
    const other = await runTournament({ ...base, shard: { k: 1, n: 2 } });
    assert(other.rows.map(r => r.index).join() === '1,3' && other.skipped === 0, `other ran ${other.rows.map(r => r.index)}`);
  });
});

test('shard: the token budget counts the other workers\' finished matches (read from results.jsonl before each match)', async () => {
  await withTempDir(async dir => {
    const base = { ...QUICK, models: ['tok', 'baseline'], gamesPerPair: 6, id: 'shb', baseDir: dir, createController: tourneyFactory({ tok: tokenClient('tok', 1000, 0) }) };
    const w0 = await runTournament({ ...base, shard: { k: 0, n: 2 }, maxMatches: 1 });
    assert(w0.rows.length === 1, 'worker 0 plays one match (1000+ tokens)');
    const w1 = await runTournament({ ...base, shard: { k: 1, n: 2 }, tokenBudget: 500 });
    assert(w1.rows.length === 0 && w1.stoppedForBudget, `worker 1 must stop before its first match: ran ${w1.rows.length}`);
  });
});

test('shard: the USD cap counts the other workers\' spend too', async () => {
  await withTempDir(async dir => {
    const counter = { calls: 0 };
    const base = { ...QUICK, models: ['pc', 'baseline'], gamesPerPair: 4, id: 'shu', baseDir: dir, createController: tourneyFactory({ pc: pricedClient('pc', 0.5, counter) }) };
    await runTournament({ ...base, shard: { k: 0, n: 2 }, maxMatches: 1 });
    const w1 = await runTournament({ ...base, shard: { k: 1, n: 2 }, maxUsd: 0.4 });
    assert(w1.rows.length === 0 && w1.stoppedForBudget, `worker 1 ran ${w1.rows.length}`);
  });
});
