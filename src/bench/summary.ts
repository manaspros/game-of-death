import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Row = { type: string; ts?: string } & Record<string, unknown>;

const LOG_DIR = 'bench-logs';

interface PlayerStats {
  turns: number;
  calls: number;
  rejected: number;
  submits: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  thoughtTokens: number;
  failedAttempts: number;
  llmErrors: number;
  forceSubmits: number;
}

function latestLog(): string {
  const files = readdirSync(LOG_DIR)
    .filter(f => f.startsWith('match-') && f.endsWith('.jsonl'))
    .map(f => join(LOG_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) throw new Error(`No match logs found in ${LOG_DIR}/`);
  return files[0];
}

const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const who = (p: unknown): string => {
  const x = p as { provider?: string; modelId?: string } | null;
  return x?.modelId ? `${x.provider}/${x.modelId}` : 'baseline bot';
};

function describeAction(a: Record<string, unknown>): string {
  if (a.action === 'submit') return 'submit turn';
  if (a.action === 'clear') { const r = a.region as { x: number; y: number; w: number; h: number }; return `clear own cells in box (${r.x},${r.y},${r.w}x${r.h})`; }
  if (a.action === 'save_blueprint') return `save blueprint "${str(a.name)}" (${Array.isArray(a.cells) ? a.cells.length : 0} cells)`;
  const anchor = Array.isArray(a.anchor) ? a.anchor.join(',') : '?';
  const what = typeof a.preset === 'string'
    ? `${a.preset}${num(a.rotation) ? ` rot${num(a.rotation) * 90}` : ''}`
    : `custom(${Array.isArray(a.cells) ? a.cells.length : 0} cells)`;
  return `place ${what} @(${anchor})`;
}

function main(): void {
  const path = process.argv[2] ?? latestLog();
  const rows: Row[] = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Row);

  const stats: Record<number, PlayerStats> = {};
  const stat = (id: number): PlayerStats =>
    (stats[id] ??= {
      turns: 0, calls: 0, rejected: 0, submits: 0, latencyMs: 0,
      promptTokens: 0, completionTokens: 0, thoughtTokens: 0, failedAttempts: 0, llmErrors: 0, forceSubmits: 0,
    });

  const start = rows.find(r => r.type === 'match_start');
  console.log(`Log: ${path}`);
  if (start) console.log(`P1: ${who(start.p1)}   P2: ${who(start.p2)}   preset: ${str(start.preset)}\n`);

  let round = 1;
  console.log(`--- Round ${round} ---`);
  for (const r of rows) {
    const pid = num(r.playerId);
    switch (r.type) {
      case 'turn': {
        const s = stat(pid);
        const a = r.action as Record<string, unknown>;
        const res = r.applyResult as { ok: boolean; error?: string };
        s.turns++;
        if (num(r.batchIndex) === 0) s.calls++;
        s.latencyMs += num(r.latencyMs);
        s.promptTokens += num(r.promptTokens);
        s.completionTokens += num(r.completionTokens);
        s.thoughtTokens += num(r.thoughtTokens);
        if (!res.ok) s.rejected++;
        else if (a.action === 'submit') s.submits++;
        console.log(
          `  P${pid} #${num(r.callIndex)}${num(r.batchSize) > 1 ? `.${num(r.batchIndex) + 1}/${num(r.batchSize)}` : ''} ${describeAction(a)} -> ${res.ok ? 'ok' : `REJECTED (${res.error})`}  [${(num(r.latencyMs) / 1000).toFixed(1)}s, moves ${num(r.movesLeftBefore)}]`,
        );
        if (str(r.rationale)) console.log(`      why: ${str(r.rationale)}`);
        if (str(r.analysis)) console.log(`      analysis: ${str(r.analysis).replace(/\s+/g, ' ')}`);
        if (str(r.notes)) console.log(`      notes: ${str(r.notes).replace(/\s+/g, ' ')}`);
        break;
      }
      case 'attempt_failed':
        stat(pid).failedAttempts++;
        console.log(`  P${pid} #${num(r.callIndex)} attempt ${num(r.attempt)}/${num(r.maxAttempts)} failed (${Math.round(num(r.elapsedMs) / 1000)}s): ${str(r.reason)}`);
        break;
      case 'llm_error':
        stat(pid).llmErrors++;
        console.log(`  P${pid} LLM ERROR: ${str(r.error)}`);
        break;
      case 'llm_bad_response':
        console.log(`  P${pid} unusable model response: ${str(r.error)}`);
        break;
      case 'match_invalid':
        console.log(`\nMATCH INVALID (P${pid}, round ${num(r.round)}) - NOT SCOREABLE: ${str(r.reason)}`);
        break;
      case 'auto_skip':
        console.log(`  P${pid} auto-skip after repeated illegal actions: ${str(r.reason)}`);
        break;
      case 'force_submit':
        stat(pid).forceSubmits++;
        console.log(`  P${pid} force-submitted with ${num(r.movesLeft)} moves unspent`);
        break;
      case 'post_mortem':
        for (const [seat, lines] of [['P1', r.p1], ['P2', r.p2]] as const) {
          if (!Array.isArray(lines)) continue;
          console.log(`  post-mortem shown to ${seat} next round:`);
          for (const line of lines) console.log(`      ${String(line)}`);
        }
        break;
      case 'round_resolved':
        console.log(
          `  => round ${num(r.round)} resolved: cells P1=${num(r.p1Cells)} P2=${num(r.p2Cells)} | heart HP P1=${num(r.p1HeartHp)} P2=${num(r.p2HeartHp)}`,
        );
        if (!r.isGameOver) console.log(`\n--- Round ${++round} ---`);
        break;
      case 'match_end':
        console.log(`\nWINNER: ${String(r.winner)}`);
        break;
    }
  }

  console.log('\n=== Per-player totals (LLM-driven turns only) ===');
  for (const [id, s] of Object.entries(stats)) {
    const avg = s.calls ? (s.latencyMs / s.calls / 1000).toFixed(1) : '-';
    const illegal = s.turns ? `${((s.rejected / s.turns) * 100).toFixed(0)}%` : '-';
    console.log(
      `P${id}: ${s.turns} actions in ${s.calls} calls | ${s.rejected} rejected (${illegal}) | ${s.submits} submits | avg ${avg}s/call | ` +
        `tokens in/out/thinking ${s.promptTokens}/${s.completionTokens}/${s.thoughtTokens} | failed attempts ${s.failedAttempts} | ` +
        `llm errors ${s.llmErrors} | force-submits ${s.forceSubmits}`,
    );
  }
}

main();
