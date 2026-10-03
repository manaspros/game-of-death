import { PATTERNS, type Pattern } from '../game/patterns';
import type { ObservedBlueprint } from './types';

/** A custom (non-preset) shape must fit in this box. Harness-level limit, not an engine rule. */
export const MAX_CUSTOM_BOUNDING_BOX = 12;
export const MAX_BLUEPRINTS = 5;
export const MAX_BLUEPRINT_CELLS = 40;
/** Placements allowed in one place_many call. */
export const MAX_BATCH = 8;
/** Boxes allowed in the clear_boxes list of one place call. */
export const MAX_CLEAR_BOXES = 4;

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const RESERVED = new Set([...PATTERNS.map(p => p.name.toLowerCase()), 'custom']);

type SaveResult = { ok: true; replaced: boolean } | { ok: false; error: string };

/**
 * A player's saved formations for one match. Saving is free; deploying one
 * costs its live cells exactly like placing those cells by hand.
 */
export class BlueprintBook {
  private items = new Map<string, Pattern>();

  save(name: unknown, rawCells: unknown): SaveResult {
    if (typeof name !== 'string' || !NAME.test(name)) {
      return { ok: false, error: 'Blueprint name must start with a letter and use only letters, digits, - or _ (max 24 characters).' };
    }
    if (RESERVED.has(name.toLowerCase())) {
      return { ok: false, error: `"${name}" is a built-in pattern name; pick another name.` };
    }
    if (!Array.isArray(rawCells) || rawCells.length === 0) {
      return { ok: false, error: 'cells must be a non-empty array of [dx, dy] pairs.' };
    }

    const seen = new Set<string>();
    const cells: [number, number][] = [];
    for (const c of rawCells) {
      if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1])) {
        return { ok: false, error: 'Every cell must be a pair of whole numbers [dx, dy].' };
      }
      const key = `${c[0]},${c[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push([c[0], c[1]]);
      }
    }
    if (cells.length > MAX_BLUEPRINT_CELLS) {
      return { ok: false, error: `A blueprint can have at most ${MAX_BLUEPRINT_CELLS} live cells (got ${cells.length}).` };
    }

    const minX = Math.min(...cells.map(c => c[0]));
    const minY = Math.min(...cells.map(c => c[1]));
    const normalized = cells.map(([x, y]) => [x - minX, y - minY] as [number, number]);
    const width = Math.max(...normalized.map(c => c[0])) + 1;
    const height = Math.max(...normalized.map(c => c[1])) + 1;
    if (width > MAX_CUSTOM_BOUNDING_BOX || height > MAX_CUSTOM_BOUNDING_BOX) {
      return { ok: false, error: `A blueprint must fit in ${MAX_CUSTOM_BOUNDING_BOX}x${MAX_CUSTOM_BOUNDING_BOX} (got ${width}x${height}).` };
    }

    const key = name.toLowerCase();
    const replaced = this.items.has(key);
    if (!replaced && this.items.size >= MAX_BLUEPRINTS) {
      return { ok: false, error: `You already have ${MAX_BLUEPRINTS} blueprints. Save under an existing name to replace one.` };
    }
    this.items.set(key, { name, category: 'special', cells: normalized, width, height });
    return { ok: true, replaced };
  }

  get(name: string): Pattern | undefined {
    return this.items.get(name.toLowerCase());
  }

  list(): ObservedBlueprint[] {
    return [...this.items.values()].map(p => ({
      name: p.name,
      cost: p.cells.length,
      width: p.width,
      height: p.height,
      cells: p.cells.map(([x, y]) => [x, y] as [number, number]),
    }));
  }
}
