// Export one tournament's results as static files under public/data/<id>/ so the
// leaderboard and replay pages work without the studio server (used for the Vercel deploy).
// Usage: npm run build:bench && node scripts/export-static-data.mjs [tournament-id]
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { leaderboardResponse } = require('../dist-bench/bench/leaderboard.js');

const id = process.argv[2] ?? 'frontier-5r-2026-10-04';
const src = join('bench-logs', 'tournaments', id);
const out = join('public', 'data', id);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'log'), { recursive: true });

// matchList comes from results.jsonl; ratings/CIs come from the leaderboard.json the tournament
// published, so the site shows exactly the numbers in the README (the bootstrap is random).
const live = leaderboardResponse(id, join('bench-logs', 'tournaments'), {}, join('no-such-video-dir'));
const stored = JSON.parse(readFileSync(join(src, 'leaderboard.json'), 'utf8'));
writeFileSync(join(out, 'leaderboard.json'), JSON.stringify({ ...live, ...stored, matchList: live.matchList }));

for (const f of readdirSync(src)) if (f.endsWith('.jsonl') && f.startsWith('match-')) cpSync(join(src, f), join(out, 'log', f));

const matches = live.matchList.length;
writeFileSync(join('public', 'data', 'tournaments.json'), JSON.stringify({ tournaments: [{ id, matches }] }));
console.log(`exported ${id}: ${matches} matches -> ${out}`);
