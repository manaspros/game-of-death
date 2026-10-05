import type { Grid } from '../engine/grid';
import type { Owner, Zone } from '../engine/types';
import type { GameState } from '../game/state';
import type { BlueprintBook } from './blueprints';
import type { MatchMemory } from './memory';
import { PATTERNS } from '../game/patterns';
import type { AnchorRange, CellXY, Observation } from './types';

/**
 * Serialize GameState into a compact, zone-scoped observation for one player.
 * Never dumps the full dense grid, and lists cells as bare [x, y] pairs: see
 * docs/AI_INTEGRATION.md sections 3-4 for why.
 */
export function serializeObservation(
  state: GameState,
  playerId: 1 | 2,
  book?: BlueprintBook,
  memory?: MatchMemory,
): Observation {
  const you = state.players[playerId - 1];
  const opponent = state.players[playerId === 1 ? 1 : 0];
  const ownOwner: Owner = playerId === 1 ? 'p1' : 'p2';
  const oppOwner: Owner = playerId === 1 ? 'p2' : 'p1';
  const ownZone = playerId === 1 ? state.layout.p1Build : state.layout.p2Build;
  const oppZone = playerId === 1 ? state.layout.p2Build : state.layout.p1Build;

  // What the player may see of the opponent's zone: the live board in "visible" mode, otherwise last round's.
  const seenGrid = state.visibility === 'visible' ? state.grid : state.previousRoundGrid;

  const battlefield = { yours: [] as CellXY[], theirs: [] as CellXY[], neutral: [] as CellXY[] };
  forEachLive(state.grid, state.layout.battlefield, (x, y, owner, fixed) => {
    if (fixed) return;
    (owner === ownOwner ? battlefield.yours : owner === oppOwner ? battlefield.theirs : battlefield.neutral).push([x, y]);
  });

  const cells: CellXY[] = [];
  const intruders: CellXY[] = [];
  forEachLive(state.grid, ownZone, (x, y, owner, fixed) => {
    if (fixed) return;
    (owner === ownOwner ? cells : intruders).push([x, y]);
  });

  const visibleCells: CellXY[] = [];
  if (seenGrid) {
    forEachLive(seenGrid, oppZone, (x, y, owner, fixed) => {
      if (!fixed && owner === oppOwner) visibleCells.push([x, y]);
    });
  }
  // Your own cells are never hidden from you: show them where they are right now.
  const yourCellsThere: CellXY[] = [];
  forEachLive(state.grid, oppZone, (x, y, owner, fixed) => {
    if (!fixed && owner === ownOwner) yourCellsThere.push([x, y]);
  });

  const ownHeartCells = you.heartPlaced ? heartCells(state.grid, ownZone, ownOwner) : [];
  const oppHeartCells = seenGrid ? heartCells(seenGrid, oppZone, oppOwner) : [];
  const ownBox = you.heartPlaced && you.heartZone ? you.heartZone : null;
  const oppBox = seenGrid ? heartBox(seenGrid, oppZone, oppOwner) : null;
  const inside = (box: Zone | null, cells: CellXY[]) =>
    box ? cells.filter(([x, y]) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) : [];

  return {
    round: state.round,
    maxRounds: state.maxRounds,
    generationsPerRound: state.preset.generationsPerRound,
    cellMaxAge: state.preset.cellMaxAge,
    board: { width: state.grid.width, height: state.grid.height },
    phase: state.phase,
    visibilityMode: state.visibility,
    you: {
      player: playerId,
      side: playerId === 1 ? 'left' : 'right',
      attackDirection: playerId === 1 ? 'right' : 'left',
      movesLeft: you.movesLeft,
      heartHp: you.heartHp,
      heartPlaced: you.heartPlaced,
      heartZone: you.heartPlaced && you.heartZone ? { ...you.heartZone } : null,
      heartCells: ownHeartCells,
      buildZone: { ...ownZone },
      blueprints: book ? book.list() : [],
      anchorRanges: anchorRanges(ownZone, you.heartPlaced, book),
      cells,
      intruders,
      enemyCellsInsideHeartBox: inside(ownBox, intruders),
    },
    opponent: {
      heartHp: opponent.heartHp,
      heartZone: oppBox,
      heartCells: oppHeartCells,
      buildZone: { ...oppZone },
      visibleCells,
      yourCellsThere,
      yourCellsInsideHeartBox: inside(oppBox, yourCellsThere),
    },
    memory: memory ? memory.view(playerId) : { notes: '', history: [], lastRoundReport: [], thisTurn: [] },
    battlefield: { zone: { ...state.layout.battlefield }, ...battlefield },
  };
}

function forEachLive(grid: Grid, zone: Zone, visit: (x: number, y: number, owner: Owner, fixed: boolean) => void): void {
  for (let y = zone.y; y < zone.y + zone.h; y++) {
    for (let x = zone.x; x < zone.x + zone.w; x++) {
      const cell = grid.getCell(x, y);
      if (cell?.alive) visit(x, y, cell.owner ?? 'neutral', cell.fixed);
    }
  }
}

/** The squares of an owner's fixed (Heart) cells inside a zone, row by row. */
function heartCells(grid: Grid, zone: Zone, owner: Owner): CellXY[] {
  const out: CellXY[] = [];
  forEachLive(grid, zone, (x, y, cellOwner, fixed) => {
    if (fixed && cellOwner === owner) out.push([x, y]);
  });
  return out;
}

/** Bounding box of an owner's fixed (Heart) cells inside a zone, or null if there are none. */
function heartBox(grid: Grid, zone: Zone, owner: Owner): Zone | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachLive(grid, zone, (x, y, cellOwner, fixed) => {
    if (!fixed || cellOwner !== owner) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return maxX < minX ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Anchor ranges inside a zone for every placeable pattern (Heart only until it is placed) and blueprint. */
function anchorRanges(zone: Zone, heartPlaced: boolean, book?: BlueprintBook): Record<string, AnchorRange> {
  const box = (w: number, h: number) => ({
    x: [zone.x, zone.x + zone.w - w] as [number, number],
    y: [zone.y, zone.y + zone.h - h] as [number, number],
  });
  const make = (w: number, h: number): AnchorRange => {
    const upright = box(w, h);
    return w === h ? upright : { ...upright, rot90: box(h, w) };
  };
  const out: Record<string, AnchorRange> = {};
  for (const p of PATTERNS) {
    if (p.name === 'Heart' && heartPlaced) continue;
    out[p.name] = p.name === 'Heart' ? box(p.width, p.height) : make(p.width, p.height);
  }
  for (const b of book ? book.list() : []) out[b.name] = make(b.width, b.height);
  return out;
}
