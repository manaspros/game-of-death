import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeLeaderboard, loadResults, type Leaderboard } from './leaderboard';
import { sanitizeKey, TOURNAMENT_DIR } from './tournament';

/**
 * Prompt robustness: compares the leaderboards of tournaments that played the same models under different
 * system prompt variants (TOURNEY_PROMPT_VARIANT). The first tournament is the reference.
 *
 * Per model: rating and rank in each tournament, the largest rating shift from the reference, and whether any
 * variant's rating falls outside the reference's 95% CI. Per variant: Spearman rank correlation with the reference
 * over the models both rated (1 = same order, 0 = unrelated).
 */

export interface RobustnessModel {
  model: string;
  /** One entry per tournament, in input order; null when the model was not rated there. */
  ratings: (number | null)[];
  ranks: (number | null)[];
  /** Largest |rating - reference rating| over the other tournaments; null without a reference rating. */
  maxShift: number | null;
  /** True when some variant's rating lies outside the reference's 95% CI. */
  outsideReferenceCi: boolean;
}

export interface Robustness {
  tournaments: { id: string; promptVariant: string; matches: number }[];
  /** Spearman rank correlation of each tournament with the reference (the reference itself is 1). */
  spearman: (number | null)[];
  models: RobustnessModel[];
}

/** Spearman correlation with average ranks for ties; null with fewer than 2 shared values or no spread. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const rank = (v: number[]) => {
    const order = v.map((val, i) => ({ val, i })).sort((a, b) => a.val - b.val);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].val === order[i].val) j++;
      for (let k = i; k <= j; k++) r[order[k].i] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const mean = (v: number[]) => v.reduce((s, a) => s + a, 0) / v.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

export function compareLeaderboards(boards: Leaderboard[]): Robustness {
  if (boards.length < 2) throw new Error('Prompt robustness needs at least two tournaments.');
  const [ref] = boards;
  const names = [...new Set(boards.flatMap(b => b.models.map(m => m.model)))];
  const find = (b: Leaderboard, model: string) => b.models.find(m => m.model === model && m.rating !== null);

  const models: RobustnessModel[] = names.map(model => {
    const entries = boards.map(b => find(b, model));
    const base = entries[0];
    const others = entries.slice(1).filter(e => e !== undefined);
    return {
      model,
      ratings: entries.map(e => e?.rating ?? null),
      ranks: entries.map(e => e?.rank ?? null),
      maxShift: base && others.length ? Math.max(...others.map(e => Math.abs(e!.rating! - base.rating!))) : null,
      outsideReferenceCi: !!base && base.ciLow !== null && base.ciHigh !== null && others.some(e => e!.rating! < base.ciLow! || e!.rating! > base.ciHigh!),
    };
  });
  models.sort((a, b) => (b.ratings[0] ?? -Infinity) - (a.ratings[0] ?? -Infinity) || a.model.localeCompare(b.model));

  const correlations = boards.map(b => {
    const shared = names.filter(m => find(ref, m) && find(b, m));
    return spearman(shared.map(m => find(ref, m)!.rating!), shared.map(m => find(b, m)!.rating!));
  });

  return {
    tournaments: boards.map(b => ({ id: b.tournamentId, promptVariant: b.promptVariant, matches: b.matches })),
    spearman: correlations,
    models,
  };
}

const f0 = (v: number | null) => (v === null ? '-' : v.toFixed(0));
const f2 = (v: number | null) => (v === null ? '-' : v.toFixed(2));

export function renderRobustnessMarkdown(r: Robustness): string {
  const md = (row: string[]) => `| ${row.join(' | ')} |`;
  const label = (t: Robustness['tournaments'][number]) => `${t.promptVariant} (${t.id})`;
  const headers = ['Model', ...r.tournaments.map(t => `Rating / rank: ${label(t)}`), 'Max shift', 'Outside ref CI'];
  return [
    '# Prompt robustness',
    '',
    `Reference: ${label(r.tournaments[0])}. Shift = |rating - reference rating|; "Outside ref CI" = some variant's rating falls outside the reference's 95% CI.`,
    '',
    md(['Tournament', 'Prompt variant', 'Matches', 'Spearman vs reference']),
    md(['---', '---', '---', '---']),
    ...r.tournaments.map((t, i) => md([t.id, t.promptVariant, String(t.matches), f2(r.spearman[i])])),
    '',
    md(headers),
    md(headers.map(() => '---')),
    ...r.models.map(m =>
      md([
        m.model,
        ...m.ratings.map((v, i) => (v === null ? '-' : `${f0(v)} / #${m.ranks[i]}`)),
        f0(m.maxShift),
        m.outsideReferenceCi ? 'yes' : 'no',
      ]),
    ),
    '',
  ].join('\n');
}

function main(): void {
  const ids = (process.env.TOURNEY_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length < 2) throw new Error('Set TOURNEY_IDS to two or more comma-separated tournament ids; the first is the reference.');
  const r = compareLeaderboards(ids.map(id => computeLeaderboard(loadResults(id), { tournamentId: id })));
  const variants = r.tournaments.map(t => t.promptVariant);
  if (new Set(variants).size < variants.length) console.warn(`Warning: some tournaments share a prompt variant (${variants.join(', ')}); this measures run-to-run noise, not prompt sensitivity.`);
  const md = renderRobustnessMarkdown(r);
  console.log(md);
  const dir = join(TOURNAMENT_DIR, 'robustness');
  const base = join(dir, sanitizeKey(ids.join('+')));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 2) + '\n');
  writeFileSync(`${base}.md`, md);
  console.log(`Wrote ${base}.json and ${base}.md`);
}

if (require.main === module) main();
