import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestPerIndex, parseResultRows, TOURNAMENT_DIR, TOURNAMENT_VIDEO_DIR, type TournamentRow } from './tournament';

/**
 * Leaderboard for a round-robin tournament.
 *
 * Rating = Bradley-Terry strengths fitted by MM iteration (Hunter 2004), draws count half a win each,
 * then mapped to an Elo-like scale: rating = 1000 + 400 * log10(strength / anchor).
 * Anchor is the model keyed 'baseline' if it played, otherwise the geometric mean of all strengths.
 *
 * Prior: every rated model also plays one imaginary drawn game (0.5 win, 0.5 loss) against a
 * virtual opponent of strength 1. Without it a model with only wins (or only losses) has an infinite
 * (or zero) MLE strength and the iteration diverges. The prior pulls strengths slightly toward the
 * virtual opponent (about one game's worth), which fades as real games accumulate.
 *
 * 95% CI = 2.5th / 97.5th percentiles of the rating over bootstrap resamples of non-void matches.
 * Resampling is stratified by pair: each pair's games are resampled among themselves (same count), so every
 * pair and model (the baseline included) is present in every replicate and the anchor never changes.
 */

export const BASELINE_KEY = 'baseline';
export const DEFAULT_BOOTSTRAP = 200;
const PRIOR_GAMES = 1;
const MAX_ITER = 500;
const TOLERANCE = 1e-10;

export interface LeaderboardOptions {
  /** Bootstrap resample count. Default 200. */
  bootstrap?: number;
  /** Seed for the resampling RNG, so output is reproducible. Default 12345. */
  seed?: number;
  /** Used when rows is empty. */
  tournamentId?: string;
}

export interface ModelStanding {
  rank: number;
  model: string;
  /** null when the model has no non-void games. */
  rating: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** wins / games */
  winRate: number | null;
  /** Mean heart-HP margin from this model's side (positive = ahead). */
  avgMargin: number | null;
  invalidPerGame: number | null;
  autoSkipsPerGame: number | null;
  avgTokensPerGame: number | null;
  /** Void matches involving this model (excluded from everything else). */
  voidGames: number;
}

export interface Leaderboard {
  tournamentId: string;
  matches: number;
  voidMatches: number;
  bootstrap: number;
  anchor: 'baseline' | 'geometric-mean';
  models: ModelStanding[];
}

interface Game {
  a: string;
  b: string;
  /** a's score: 1 win, 0.5 draw, 0 loss. */
  score: number;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toGame(r: TournamentRow): Game {
  const score = r.winner === 'draw' ? 0.5 : r.winnerModel === r.a ? 1 : r.winnerModel === r.b ? 0 : 0.5;
  return { a: r.a, b: r.b, score };
}

/** Bradley-Terry ratings for the models appearing in `games` (see header for the prior). */
function fitRatings(games: Game[]): Map<string, number> {
  const models = [...new Set(games.flatMap(g => [g.a, g.b]))];
  const idx = new Map(models.map((m, i) => [m, i]));
  const n = models.length;
  const wins = new Array<number>(n).fill(PRIOR_GAMES / 2);
  const pairGames = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const g of games) {
    const i = idx.get(g.a)!;
    const j = idx.get(g.b)!;
    wins[i] += g.score;
    wins[j] += 1 - g.score;
    pairGames[i][j]++;
    pairGames[j][i]++;
  }
  let p = new Array<number>(n).fill(1);
  for (let it = 0; it < MAX_ITER; it++) {
    const next = p.map((pi, i) => {
      let denom = PRIOR_GAMES / (pi + 1);
      for (let j = 0; j < n; j++) if (pairGames[i][j] > 0) denom += pairGames[i][j] / (pi + p[j]);
      return wins[i] / denom;
    });
    const delta = Math.max(...next.map((v, i) => Math.abs(Math.log(v / p[i]))));
    p = next;
    if (delta < TOLERANCE) break;
  }
  const baseIdx = idx.get(BASELINE_KEY);
  const logAnchor = baseIdx !== undefined ? Math.log(p[baseIdx]) : p.reduce((s, v) => s + Math.log(v), 0) / n;
  const out = new Map<string, number>();
  models.forEach((m, i) => out.set(m, 1000 + (400 * (Math.log(p[i]) - logAnchor)) / Math.LN10));
  return out;
}

function percentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** One bootstrap replicate: games resampled with replacement WITHIN each unordered pair, keeping every pair's game count. */
export function stratifiedResample<G extends { a: string; b: string }>(games: G[], rng: () => number): G[] {
  const byPair = new Map<string, G[]>();
  for (const g of games) {
    const key = g.a < g.b ? `${g.a}\u0000${g.b}` : `${g.b}\u0000${g.a}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(g);
  }
  const out: G[] = [];
  for (const group of byPair.values()) {
    for (let k = 0; k < group.length; k++) out.push(group[Math.floor(rng() * group.length)]);
  }
  return out;
}

export function computeLeaderboard(rows: TournamentRow[], opts: LeaderboardOptions = {}): Leaderboard {
  const bootstrap = opts.bootstrap ?? DEFAULT_BOOTSTRAP;
  const live = rows.filter(r => !r.void);
  const names = [...new Set(rows.flatMap(r => [r.a, r.b]))];
  const games = live.map(toGame);
  const fitted = fitRatings(games);

  const samples = new Map<string, number[]>();
  const rng = mulberry32(opts.seed ?? 12345);
  if (games.length > 0) {
    for (let b = 0; b < bootstrap; b++) {
      for (const [m, v] of fitRatings(stratifiedResample(games, rng))) {
        if (!samples.has(m)) samples.set(m, []);
        samples.get(m)!.push(v);
      }
    }
  }

  const standings: ModelStanding[] = names.map(model => {
    const mine = live.filter(r => r.a === model || r.b === model);
    let wins = 0, draws = 0, losses = 0, margin = 0, tokens = 0, invalid = 0, skips = 0;
    for (const r of mine) {
      const seat = r.p1 === model ? 'p1' : 'p2';
      if (r.winner === 'draw') draws++;
      else if (r.winnerModel === model) wins++;
      else losses++;
      margin += seat === 'p1' ? r.margin : -r.margin;
      tokens += r.tokens[seat];
      invalid += r.invalidCalls[seat];
      skips += r.autoSkips[seat];
    }
    const g = mine.length;
    const s = samples.get(model)?.slice().sort((x, y) => x - y);
    return {
      rank: 0,
      model,
      rating: fitted.get(model) ?? null,
      ciLow: s && s.length ? percentile(s, 0.025) : null,
      ciHigh: s && s.length ? percentile(s, 0.975) : null,
      games: g,
      wins,
      draws,
      losses,
      winRate: g ? wins / g : null,
      avgMargin: g ? margin / g : null,
      invalidPerGame: g ? invalid / g : null,
      autoSkipsPerGame: g ? skips / g : null,
      avgTokensPerGame: g ? tokens / g : null,
      voidGames: rows.filter(r => r.void && (r.a === model || r.b === model)).length,
    };
  });
  standings.sort((x, y) => (y.rating ?? -Infinity) - (x.rating ?? -Infinity) || x.model.localeCompare(y.model));
  standings.forEach((s, i) => (s.rank = i + 1));

  return {
    tournamentId: opts.tournamentId ?? rows[0]?.tournamentId ?? '',
    matches: live.length,
    voidMatches: rows.length - live.length,
    bootstrap,
    anchor: fitted.has(BASELINE_KEY) ? 'baseline' : 'geometric-mean',
    models: standings,
  };
}

// ---------- files ----------

export interface TournamentInfo {
  id: string;
  matches: number;
  mtimeMs: number;
}

/** Matches in results.jsonl as the leaderboard counts them: one per index (latest row wins), a cut-off last line ignored. */
function countMatches(text: string): number {
  try {
    return latestPerIndex(parseResultRows(text, () => {}).rows).length;
  } catch {
    return 0; // a corrupt middle line: loadResults reports the real error when the tournament is opened
  }
}

/** Tournament folders (those with a results.jsonl), newest first. */
export function listTournaments(baseDir: string = TOURNAMENT_DIR): TournamentInfo[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir)
    .filter(id => existsSync(join(baseDir, id, 'results.jsonl')))
    .map(id => {
      const file = join(baseDir, id, 'results.jsonl');
      return { id, matches: countMatches(readFileSync(file, 'utf8')), mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
}

/** The requested tournament does not exist (the studio maps this to 404; other errors are 500). */
export class TournamentNotFoundError extends Error {}

export function isSafeId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';
}

export function loadResults(id: string, baseDir: string = TOURNAMENT_DIR): TournamentRow[] {
  if (!isSafeId(id)) throw new TournamentNotFoundError(`Bad tournament id "${id}".`);
  const file = join(baseDir, id, 'results.jsonl');
  if (!existsSync(file)) throw new TournamentNotFoundError(`No results.jsonl for tournament "${id}" in ${baseDir}/`);
  // Truncated last line is skipped with a warning; one row per index (last wins), so a retried void match replaces its old row.
  return latestPerIndex(parseResultRows(readFileSync(file, 'utf8')).rows);
}

export function latestTournamentId(baseDir: string = TOURNAMENT_DIR): string | null {
  return listTournaments(baseDir)[0]?.id ?? null;
}

export interface MatchListItem {
  index: number;
  p1: string;
  p2: string;
  winner: TournamentRow['winner'];
  winnerModel: string | null;
  rounds: number;
  margin: number;
  void: boolean;
  voidReason?: string;
  /** Bare file name inside the tournament folder, served by /api/tournaments/<id>/log/<file>. */
  logName: string;
  /** Bare name of the match's video inside <videoDir>/<tournament id>/, present only when that file exists (served by /api/tournaments/<id>/video/<file>). */
  video?: string;
}

export interface LeaderboardResponse extends Leaderboard {
  matchList: MatchListItem[];
}

/** Leaderboard plus the match list, for the web page. id omitted = latest tournament. */
export function leaderboardResponse(
  id: string | null | undefined,
  baseDir: string = TOURNAMENT_DIR,
  opts: LeaderboardOptions = {},
  videoDir: string = TOURNAMENT_VIDEO_DIR,
): LeaderboardResponse {
  const useId = id || latestTournamentId(baseDir);
  if (!useId) throw new TournamentNotFoundError(`No tournaments found in ${baseDir}/`);
  const rows = loadResults(useId, baseDir);
  return {
    ...computeLeaderboard(rows, { tournamentId: useId, ...opts }),
    matchList: rows.map(r => {
      const logName = r.logFile.split('/').pop() ?? r.logFile;
      const video = logName.replace(/\.jsonl$/, '') + '.mp4';
      return {
        index: r.index,
        p1: r.p1,
        p2: r.p2,
        winner: r.winner,
        winnerModel: r.winnerModel,
        rounds: r.rounds,
        margin: r.margin,
        void: r.void,
        voidReason: r.voidReason,
        logName,
        ...(existsSync(join(videoDir, useId, video)) ? { video } : {}),
      };
    }),
  };
}

// ---------- rendering ----------

const f0 = (v: number | null) => (v === null ? '-' : v.toFixed(0));
const f1 = (v: number | null) => (v === null ? '-' : v.toFixed(1));
const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(0)}%`);

const HEADERS = ['#', 'Model', 'Rating (95% CI)', 'Games', 'W/D/L', 'Win%', 'Avg margin', 'Invalid+skip/game', 'Tokens/game', 'Void'];

function tableRows(lb: Leaderboard): string[][] {
  return lb.models.map(m => [
    String(m.rank),
    m.model,
    m.rating === null ? '-' : `${f0(m.rating)} (${f0(m.ciLow)}..${f0(m.ciHigh)})`,
    String(m.games),
    `${m.wins}/${m.draws}/${m.losses}`,
    pct(m.winRate),
    f1(m.avgMargin),
    m.games ? f1((m.invalidPerGame ?? 0) + (m.autoSkipsPerGame ?? 0)) : '-',
    f0(m.avgTokensPerGame),
    String(m.voidGames),
  ]);
}

export function renderConsole(lb: Leaderboard): string {
  const all = [HEADERS, ...tableRows(lb)];
  const w = HEADERS.map((_, c) => Math.max(...all.map(r => r[c].length)));
  const line = (r: string[]) => r.map((cell, c) => (c === 1 ? cell.padEnd(w[c]) : cell.padStart(w[c]))).join('  ');
  return [`Tournament ${lb.tournamentId}: ${lb.matches} matches (${lb.voidMatches} void), anchor ${lb.anchor} = 1000`, line(HEADERS), ...all.slice(1).map(line)].join('\n');
}

export function renderMarkdown(lb: Leaderboard): string {
  const md = (r: string[]) => `| ${r.join(' | ')} |`;
  return [
    `# Leaderboard: ${lb.tournamentId}`,
    '',
    `${lb.matches} matches (${lb.voidMatches} void, excluded). Bradley-Terry rating, ${lb.anchor === 'baseline' ? 'baseline' : 'geometric mean'} = 1000, 95% CI from ${lb.bootstrap} bootstrap resamples.`,
    '',
    md(HEADERS),
    md(HEADERS.map(() => '---')),
    ...tableRows(lb).map(md),
    '',
  ].join('\n');
}

/** Writes leaderboard.json and leaderboard.md next to results.jsonl. */
export function writeLeaderboardFiles(lb: Leaderboard, baseDir: string = TOURNAMENT_DIR): void {
  const dir = join(baseDir, lb.tournamentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'leaderboard.json'), JSON.stringify(lb, null, 2) + '\n');
  writeFileSync(join(dir, 'leaderboard.md'), renderMarkdown(lb));
}

function main(): void {
  const id = process.env.TOURNEY_ID || latestTournamentId();
  if (!id) throw new Error(`No tournaments found in ${TOURNAMENT_DIR}/`);
  const lb = computeLeaderboard(loadResults(id), { tournamentId: id });
  console.log(renderConsole(lb));
  writeLeaderboardFiles(lb);
  console.log(`\nWrote ${join(TOURNAMENT_DIR, id, 'leaderboard.json')} and leaderboard.md`);
}

if (require.main === module) main();
