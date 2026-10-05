import type { Phase, VisibilityMode, Zone } from '../engine/types';

export interface ObservedBlueprint {
  name: string;
  /** Moves it costs to deploy: its live cells. */
  cost: number;
  width: number;
  height: number;
  /** [dx, dy] offsets from the anchor (top-left), so a model can recall what it saved. */
  cells: [number, number][];
}

/** What happened to one player in one finished round, from that player's point of view. */
export interface RoundRecord {
  round: number;
  /** Compact list of the placements this player made that round, e.g. "LWSS/r0@9,18". */
  yourPlacements: string[];
  yourHeartHp: number;
  damageYouTook: number;
  enemyHeartHp: number;
  damageYouDealt: number;
  yourCellsOnBattlefield: number;
  enemyCellsOnBattlefield: number;
}

/** The anchor positions that keep a pattern inside the player's zone: x and y are [min, max]. */
export interface AnchorRange {
  x: [number, number];
  y: [number, number];
  /** Same pattern turned a quarter (rotations 1 and 3); only present when it differs. */
  rot90?: { x: [number, number]; y: [number, number] };
}

/** A live cell as [x, y]. */
export type CellXY = [number, number];

export interface Observation {
  round: number;
  maxRounds: number;
  generationsPerRound: number;
  /** A cell dies of old age this many generations after it was placed or born. */
  cellMaxAge: number;
  /** Board size in cells: x runs 0..width-1 and y runs 0..height-1. Anything that leaves it breaks up. */
  board: { width: number; height: number };
  phase: Phase;
  visibilityMode: VisibilityMode;
  you: {
    player: 1 | 2;
    side: 'left' | 'right';
    attackDirection: 'right' | 'left';
    movesLeft: number;
    heartHp: number;
    /** True once your Heart is on the board; never place it again. */
    heartPlaced: boolean;
    /** Box of your Heart, or null until you place it. Heart cells are fixed and never listed in `cells`. */
    heartZone: Zone | null;
    /** The actual squares of your Heart (fixed, always occupied); the rest of its box is empty. */
    heartCells: CellXY[];
    buildZone: Zone;
    blueprints: ObservedBlueprint[];
    /** For every pattern and blueprint you can place: the anchors that keep it inside your zone. Anything outside is rejected. */
    anchorRanges: Record<string, AnchorRange>;
    /** Your live cells inside your build zone (Heart excluded). */
    cells: CellXY[];
    /** Enemy or neutral cells currently inside your build zone: the ones that can hurt your Heart. */
    intruders: CellXY[];
    /** Enemy cells inside your Heart box right now; each costs you 1 HP when the generation ends and is then destroyed. */
    enemyCellsInsideHeartBox: CellXY[];
  };
  opponent: {
    heartHp: number;
    /** Box of their Heart once you have seen it (from round 2), else null. */
    heartZone: Zone | null;
    /** The actual squares of their Heart once seen (empty until then). */
    heartCells: CellXY[];
    buildZone: Zone;
    /**
     * Their placements at generation 0 of LAST round (launch pads before that round ran), NOT their live cells now;
     * with visibilityMode "visible" it is their cells right now.
     */
    visibleCells: CellXY[];
    /** Your own cells that are inside their zone, at their current positions. */
    yourCellsThere: CellXY[];
    /** Your cells inside their Heart box right now; each costs them 1 HP when the generation ends and is then destroyed. */
    yourCellsInsideHeartBox: CellXY[];
  };
  /** The only memory the model has between calls: what it wrote last time, plus what happened in earlier rounds. */
  memory: {
    notes: string;
    history: RoundRecord[];
    /** Plain-English facts about the round that just finished: what each of your placements did and what caused the damage. */
    lastRoundReport: string[];
    /** What you have already placed this turn (successful actions only). */
    thisTurn: string[];
  };
  battlefield: {
    zone: Zone;
    yours: CellXY[];
    theirs: CellXY[];
    neutral: CellXY[];
  };
}

export interface PlaceByCells {
  action: 'place';
  anchor: [number, number];
  cells: [number, number][];
}

export interface PlaceByPreset {
  action: 'place';
  anchor: [number, number];
  preset: string;
  rotation?: number;
}

export type PlaceAction = PlaceByCells | PlaceByPreset;

export interface SubmitAction {
  action: 'submit';
}

export interface ClearAction {
  action: 'clear';
  /** A box (x, y, w, h); only your own non-Heart cells inside your build zone are removed. */
  region: { x: number; y: number; w: number; h: number };
}

export interface SaveBlueprintAction {
  action: 'save_blueprint';
  name: string;
  cells: [number, number][];
}

export type BenchAction = PlaceAction | SubmitAction | SaveBlueprintAction | ClearAction;

export interface ActionResult {
  ok: boolean;
  /** For a successful pattern placement: the cells it really added (cells already alive are skipped). */
  placedCells?: [number, number][];
  /** Set when a placement was only partly applied: cells landed out of cells in the shape, and the squares skipped with the reason. */
  partial?: { placed: number; total: number; skipped: { x: number; y: number; reason: string }[] };
  /** Human-readable form of `partial`, fed back to the model while its turn is still open. */
  warning?: string;
  error?: string;
  submitted?: boolean;
}
