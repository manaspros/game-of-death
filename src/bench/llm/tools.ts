import { HEART_DAMAGE_CELL_CAP_PER_GEN, HEART_DAMAGE_PER_CELL } from '../../engine/rules';
import { PATTERNS } from '../../game/patterns';
import { MAX_BATCH, MAX_BLUEPRINT_CELLS, MAX_BLUEPRINTS, MAX_CLEAR_BOXES, MAX_CUSTOM_BOUNDING_BOX } from '../blueprints';
import type { BenchAction, Observation } from '../types';

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const RATIONALE_PROPERTY = {
  type: 'string',
  description: 'One to three sentences: your target, your lane (start cell and heading) and when you expect it to arrive.',
};

const NOTES_PROPERTY = {
  type: 'string',
  description:
    'Your memory for your future self (at most about 600 characters): LESSONS in the form "did X -> result Y because Z -> next time W" (use memory.lastRoundReport, not guesses), ' +
    'enemy habits you spotted (Heart position, guards, lanes) and your plan for the next round. Your first notes each turn REPLACE last turn\'s, so carry forward what still matters; later calls in the same turn are appended.',
};

const NOTES_SHORT = { type: 'string', description: 'Notes for your future self (appended to the notes you already wrote this turn).' };

const ANALYSIS_PROPERTY = {
  type: 'string',
  description: 'Your brief per-attacker summary in under about 250 words: pattern, rotation, anchor, start cell, heading, and arrival generation.',
};

const PLACEMENT_PROPERTIES = {
  anchor: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: '[x, y] of the pattern\'s top-left cell.',
  },
  preset: { type: 'string', description: 'Pattern name or one of your blueprint names.' },
  rotation: { type: 'integer', description: '0-3 quarter turns clockwise (only with preset).' },
  cells: {
    type: 'array',
    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    description: 'Your own [dx, dy] offsets from the anchor, instead of preset.',
  },
};

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'place',
    description:
      `Place up to ${MAX_BATCH} patterns in one call, applied in order. Each placement is checked separately: failures are ` +
      'reported with the reason and the others still apply. Set end_turn to true to finish your turn in the same call; if a placement fails the turn stays open. placements may be [] with end_turn true.',
    parameters: {
      type: 'object',
      properties: {
        analysis: ANALYSIS_PROPERTY,
        placements: {
          type: 'array',
          maxItems: MAX_BATCH,
          items: { type: 'object', properties: PLACEMENT_PROPERTIES, required: ['anchor'] },
        },
        clear_boxes: {
          type: 'array',
          maxItems: MAX_CLEAR_BOXES,
          items: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } },
            required: ['x', 'y', 'w', 'h'],
          },
          description:
            'Optional. Boxes (x, y, w, h) inside your own zone whose leftover cells of yours are removed BEFORE the placements. Free: costs no moves and refunds none. Your Heart, enemy cells and anything outside your zone are never touched.',
        },
        end_turn: { type: 'boolean', description: 'End your turn after these placements.' },
        rationale: RATIONALE_PROPERTY,
        notes: NOTES_PROPERTY,
      },
      required: ['analysis', 'placements', 'rationale', 'notes'],
    },
  },
  {
    name: 'save_blueprint',
    description:
      `Save a formation under a name for the rest of this match (max ${MAX_BLUEPRINTS}, each at most ${MAX_CUSTOM_BOUNDING_BOX}x${MAX_CUSTOM_BOUNDING_BOX} ` +
      `and ${MAX_BLUEPRINT_CELLS} cells; same name replaces). Free. Deploy it later with place, preset = its name.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Starts with a letter; letters, digits, - or _; max 24 characters.' },
        cells: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          description: '[dx, dy] offsets of its live cells; its top-left becomes the anchor.',
        },
        rationale: RATIONALE_PROPERTY,
      },
      required: ['name', 'cells', 'rationale'],
    },
  },
  {
    name: 'end_turn',
    description: 'Finish your turn without placing anything more. Unspent moves are lost.',
    parameters: { type: 'object', properties: { rationale: RATIONALE_PROPERTY, notes: NOTES_SHORT }, required: ['rationale'] },
  },
];

/**
 * How far apart things must be, in EMPTY squares between bounding boxes, measured by simulation (see the tests).
 * Gap 0 means touching or overlapping.
 */
export const GAP = { glider: 2, spaceship: 4, stationary: 3, parallelExtraRows: 2 } as const;

/** What each preset really does, measured by simulating it (see the tests). */
const BEHAVIOUR: Record<string, string> = {
  Block: 'still life, never changes',
  Beehive: 'still life, never changes',
  Boat: 'still life, never changes',
  Ship: 'still life, never changes',
  Tub: 'still life, never changes',
  Blinker: 'oscillator, stays in place',
  Toad: 'oscillator, stays in place',
  Beacon: 'oscillator, stays in place',
  Pulsar: 'oscillator, stays in place (big)',
  Glider: 'spaceship: moves 1 cell diagonally every 4 generations',
  LWSS: 'spaceship: moves 2 cells in a straight line every 4 generations',
  MWSS: 'spaceship: like the LWSS but wider and heavier (moves 2 cells straight every 4 generations)',
  HWSS: 'spaceship: like the LWSS but the widest (moves 2 cells straight every 4 generations)',
  'R-pentomino': 'chaotic: grows to about 180 cells over 160 generations, spreading about 60 cells wide',
  Acorn: 'chaotic: grows to about 135 cells over 160 generations, spreading about 50 cells wide',
  Diehard: 'chaotic: dies out completely after about 130 generations',
  'Pi-heptomino': 'chaotic: grows to about 120 cells over 160 generations, spreading about 45 cells wide',
  Thunderbird: 'chaotic: grows slowly, to about 165 cells over 160 generations, spreading about 50 cells wide',
  Pentadecathlon: 'oscillator with period 15: its shape swells up to 16 x 9 squares around its middle, disturbing anything within about 3 squares',
};

function patternTable(): string {
  return PATTERNS.filter(p => p.name !== 'Heart')
    .map(p => `- ${p.name}: ${p.cells.length} cells, ${p.width}x${p.height}, ${BEHAVIOUR[p.name] ?? p.category}`)
    .join('\n');
}

export const SYSTEM_PROMPT = `You are playing GAMEOFDEATH, a two-player battle on a Conway's Game of Life board. Each call, you decide your build turn.

# GOAL
Bring the enemy Heart to 0 HP, or have more Heart HP after the last round. Both Hearts start at 100 HP.

# THE BOARD
- x grows to the RIGHT, y grows DOWN; (0,0) is the top-left cell. All coordinates are absolute board coordinates.
- Player 1 owns the LEFT zone, Player 2 the RIGHT zone, with a neutral battlefield between. Player 1 attacks toward +x (right), Player 2 toward -x (left). A zone is {x, y, w, h} = left, top, width, height.
- You may only place cells inside YOUR buildZone.

# EACH ROUND
1. BUILD: both players place cells at the same time and cannot see each other's current build. You have a move budget (you.movesLeft, renewed each round). A placement costs 1 move per cell that is NOT already alive.
2. SIMULATE: generationsPerRound generations run on the whole board. Each generation, in this order:
   a. Game of Life B3/S23 among each player's own cells: a live cell survives with 2 or 3 live neighbours of ITS OWNER, and an empty square gets a new cell of a player who has exactly 3 live cells around it (if both players have exactly 3 there, nothing is born). Neighbours are the 8 surrounding squares; enemy cells and Hearts are never counted as your neighbours.
   b. Contact: after that, a P1 cell touching (8 squares) a P2 cell dies together with it (both die).
   c. Old age: a cell dies cellMaxAge generations after it was placed or born, on a counter that restarts each round. In practice only cells placed in round 1 die of it (at its last generation); from round 2 on nothing does.
   d. Heart damage: every ENEMY cell inside a Heart's box deals ${HEART_DAMAGE_PER_CELL} damage to that Heart (at most ${HEART_DAMAGE_CELL_CAP_PER_GEN} cells count per generation, so at most ${HEART_DAMAGE_PER_CELL * HEART_DAMAGE_CELL_CAP_PER_GEN} HP), then ALL enemy cells inside that box are destroyed. A cell damages a Heart once: parking cells in a Heart box does not keep draining it.
3. RESOLVE: surviving cells stay and the next round begins, except that ALL cells (yours and the enemy's) inside both Heart boxes are cleared at the end of every round; Hearts themselves stay. A Heart at 0 HP at the end of a round loses (both at 0: draw). After the last round (maxRounds) the higher Heart HP wins (equal: draw).

# HEARTS
- Place your Heart first with preset "Heart" (free, once). you.heartPlaced says whether it is already on the board: if true, NEVER place it again; you.heartZone is its box (null until placed). Heart cells are FIXED: they never die or change, are nobody's neighbours and are not in your cell lists. Their squares are always occupied, so nothing can be born on them: a pattern that touches any Heart's cells loses cells and usually breaks up. Only the squares in heartCells are fixed obstacles; the rest of heartZone is ordinary empty space where patterns can be placed, fly and be born. The box is the target region: enemy cells inside it deal damage and are destroyed (2d), and all cells inside it are cleared each round (3). opponent.heartZone/heartCells are null/empty until seen (from round 2; at once with visibilityMode "visible").

# PATTERNS (preset names)
${patternTable()}
- A pattern's top-left is its anchor and it extends right and down. It must fit inside your buildZone: anchor x from buildZone.x to buildZone.x + w - width, anchor y from buildZone.y to buildZone.y + h - height. Rotations 1 and 3 swap width and height.
- rotation = quarter turns clockwise. Glider (diagonal, a step takes 4 generations): rotation 0 moves down-right, 1 down-left, 2 up-left, 3 up-right (steps (+1,+1), (-1,+1), (-1,-1), (+1,-1)). LWSS, MWSS and HWSS (straight, a step takes 2 generations): 0 moves right, 1 down, 2 left, 3 up (steps (+1,0), (0,+1), (-1,0), (0,-1)).
- Reach: in G = generationsPerRound generations a Glider moves G/4 cells in x AND G/4 in y; an LWSS, MWSS or HWSS moves G/2 cells along its heading. After k steps a mover is at about its start + k*(dx,dy). A Glider changes row with every column it crosses; an LWSS, MWSS or HWSS never changes row (rotations 0, 2) or column (1, 3). A spaceship that reaches the board edge breaks up.
- AIM CHECK for every attacker, using the board size and Heart boxes in the JSON: its path must enter opponent.heartZone's rectangle (x..x+w-1, y..y+h-1) within G generations while staying on the board, without being broken by Heart cells on the way (any Heart's, see HEARTS) or by your own box or other live cells. Which patterns and rotations can reach which rows depends on where you start and where the target is: work it out, do not assume.
- Budget: divide your moves by a pattern's cell count (table above). Lanes closer together than a pattern is tall touch and merge, so leave an empty row between them.
- Or give your own "cells": [dx, dy] offsets from the anchor (at most ${MAX_CUSTOM_BOUNDING_BOX}x${MAX_CUSTOM_BOUNDING_BOX}).

# INTERACTIONS: CHECK BEFORE YOU PLACE
A disturbed pattern rarely stays what it was. "Gap" below means empty squares between two patterns' boxes (0 = touching or overlapping).
- Your own patterns touching or overlapping merge into a different shape (two Gliders anchored 2 rows apart become one blob). An enemy cell touching yours kills both.
- Stationary patterns (still lifes, oscillators) stay unchanged only with a gap of at least ${GAP.stationary} (a gap of 2 usually works, 1 is a coin flip, touching nearly always changes them).
- A moving Glider is almost always destroyed if its path touches anything, and is a gamble at a gap of 1: keep at least ${GAP.glider} empty squares between its whole path and every other live cell.
- LWSS, MWSS and HWSS are more fragile: keep at least ${GAP.spaceship} empty squares between their whole path and every other live cell. Same-heading attackers launched side by side need anchors at least (their height + ${GAP.parallelExtraRows}) apart: 5 for Gliders, 6 for an LWSS, 7 for an MWSS or HWSS.
- Walk each lane before you commit: list the squares a mover passes (a Glider moves 1 square diagonally every 4 generations; the LWSS family moves 1 square every 2) and check each against ALL live cells: yours (you.cells, battlefield.yours, intruders), the enemy cells you can see, and your other placements this turn.
- Cells from earlier rounds still exist and keep evolving. If your own leftovers sit in a lane or within the gap, remove them with clear_boxes first; a mover flown into your own structures destroys both and can leave a mess that blocks your lanes for good.
- Chaotic patterns throw debris in every direction: keep them away from your own patterns; debris wrecks anything it touches.
- Reason about the future, not just generation 0: step an interaction forward (generation 1, 2, 4, 8) whenever two things are within the gaps above, and re-check at the generation the attacker arrives.

# YOUR JSON EACH CALL
round, maxRounds, generationsPerRound, cellMaxAge, board (width, height), phase
you: player, side, attackDirection, movesLeft, heartHp, heartPlaced, heartZone, heartCells, buildZone, blueprints (your saved formations with their cells), anchorRanges (for every pattern and blueprint: the anchor x and y [min, max] that keep it inside your zone; rot90 is for rotations 1 and 3; an anchor outside these is rejected), cells (your live cells in your zone, [x,y], Heart excluded), intruders, enemyCellsInsideHeartBox (enemy cells inside your Heart box now)
opponent: heartHp, heartZone, heartCells, buildZone, visibleCells (their placements at generation 0 of LAST round, i.e. launch pads before that round ran: they have since moved, evolved or died, so these are NOT their cells now; with visibilityMode "visible" it is their cells right now), yourCellsThere (YOUR cells inside their zone, where they are now), yourCellsInsideHeartBox (the ones inside their Heart box now)
memory: notes (what YOU wrote), lastRoundReport (plain facts about what each of your placements did last round and what hurt you), thisTurn (what you already placed this turn), history (one entry per finished round: yourPlacements, yourHeartHp, damageYouTook, enemyHeartHp, damageYouDealt, yourCellsOnBattlefield, enemyCellsOnBattlefield)
battlefield: zone, yours / theirs / neutral cell lists
previousActionRejected: only present if part of your last call failed or a placement landed only partly (skipped squares); it says exactly why.

# ANALYSIS (what to work through while you decide)
Keep the "analysis" field brief (under about 250 words) and decide: do not loop or restart. Cover:
- REVIEW (skip in round 1): for each line of memory.lastRoundReport state CAUSE -> EFFECT in one clause (what you did, what the report says, why) and what you will change; do not assume a plan worked.
- The target Heart box: x range and y range.
- For EACH attacker: pattern, rotation, anchor (quote that pattern's range from you.anchorRanges and confirm the anchor is inside it; its box must not overlap the fixed cells of your Heart (you.heartCells) or any of your live cells, since every cell must land on an EMPTY square), start cell, heading; its row at the target column (use the heading and reach rules) and whether that row is inside the target box; whether it stays on the board and clear of your own Heart cells the whole way; its arrival generation (at most generationsPerRound).
- INTERACTION CHECK: along each lane, count the empty squares to every other live cell (yours, visible enemy) and compare with the gap rules; what each close pair does at generation 1, 2, 4 and at arrival.
- Your own leftover cells (you.cells, battlefield.yours) in a lane or within the gap: remove them with clear_boxes.
- An attacker whose check fails: fix it once, else do not place it.
- Add up your moves against the pattern costs and use them all; note threats to your own Heart.

# TOOLS
- place: up to ${MAX_BATCH} placements per call. Fill in "analysis" first: a brief per-attacker summary (see ANALYSIS below). Plan the WHOLE turn and send it in ONE call with end_turn=true whenever you can; each call is slow and expensive. If a placement fails, end_turn is not applied: you get the reasons and can fix it in one more call. placements [] + end_turn=true places nothing.
- clear_boxes (a field of place): free removal of your OWN leftover cells inside your zone before your placements. Leftovers from earlier rounds persist, so a lane you blocked yourself stays blocked until you clear it.
- save_blueprint: save a formation (free) to redeploy later by name; deploying costs its live cells like placing them by hand.
- end_turn: when nothing useful fits in your remaining moves.

# MEMORY
Every call starts fresh: you do not remember earlier calls. Your only memory is memory.notes (written by you), memory.lastRoundReport (measured facts about last round), memory.thisTurn and memory.history. A report line compares a placement ALONE with the real round and, when it can be determined, names why it failed (died at your own Heart, hit enemy cells, left the board, path missed their Heart rows or columns, expired). Damage is ${HEART_DAMAGE_PER_CELL} per cell you deliver into their Heart box (at most ${HEART_DAMAGE_CELL_CAP_PER_GEN} cells per generation). Before planning, review: for each placement say what you expected, what the report says happened, and the cause; never assume it worked. Write notes as LESSONS (for example "LESSON: LWSS at (9,18) died at gen 12 hitting my own beehive at (15,18): clear it first"), not summaries. Your first notes each turn replace last turn's; later calls in the same turn are appended. If damageYouDealt is 0, change something.

# HOW TO PLAY: AGGRESSIVELY
- A passive build loses on Heart HP. Pressure the enemy Heart every round from several rows or lanes at once, and punish whatever you can see of their layout.
- Spend your whole move budget unless extra cells would clearly hurt you.
- Reason concretely before choosing: where is the enemy Heart box; which lane reaches it within generationsPerRound generations (AIM CHECK above); what will each pattern collide with on the way; what threatens YOUR Heart box and how do you stop it.
- Balance attack and defence: kill or block incoming structures before they reach your Heart box, then keep attackers coming.
- Learn between rounds: if last round's attackers died, missed or were intercepted, change lane, timing or pattern.

# COMMON MISTAKES
- Placing a pattern partly outside your buildZone (check anchor ranges above).
- A heading that moves away from the enemy, or a path that never enters opponent.heartZone (wrong row or column, off the board, too slow for generationsPerRound).
- Placing a pattern on top of live cells (your Heart cells, your leftovers): cells that are already alive are skipped, so the pattern comes out INCOMPLETE and does not behave (an LWSS dropped on Heart cells is not an LWSS) while the game still answers ok. Every cell must land on an empty square. The rest of your Heart box is empty but cleared every round: a poor place for launch pads.
- Anchoring outside you.anchorRanges (a 5-wide pattern cannot have anchor x 13 in a zone that ends at x 13).
- Confusing your Heart with the enemy's: your Heart is you.heartZone and is on YOUR side; attacks aim at opponent.heartZone.
- Placing an attacker whose own check failed ("I'll just place it and see" wastes the move and often wrecks your own lane).
- Placing patterns closer than the gaps above, or aiming a mover through your own cells, your own Heart cells or an enemy structure.
- Lanes that arrive outside the target box's rows (or columns): only cells inside the box hurt the Heart.
- Ending your turn with most of your moves unspent.`;

/** The user message: the observation, plus why the previous call partly failed if it did. */
export function buildUserMessage(observation: Observation, _availablePresets: string[], previousRejection?: string): string {
  const payload: Record<string, unknown> = { ...observation };
  if (previousRejection) {
    payload.previousActionRejected = previousRejection;
  }
  return JSON.stringify(payload);
}

/** Names of the required fields of a tool that are missing or empty in the model's arguments (empty string, empty array). */
export function missingRequiredFields(name: string, args: Record<string, unknown>): string[] {
  const tool = TOOL_DEFS.find(t => t.name === name || (name === 'place_many' && t.name === 'place') || (name === 'submit_turn' && t.name === 'end_turn'));
  if (!tool) return [];
  return (tool.parameters.required ?? []).filter(field => {
    const v = args[field];
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0 && field !== 'placements';
    return v === undefined || v === null;
  });
}

/** Prose fields a model may leave empty without the call becoming unusable. */
const LENIENT_FIELDS = new Set(['analysis', 'rationale', 'notes']);

/** Splits the missing required fields into those that make the call unusable (fatal) and empty prose that is only worth a warning (lenient). */
export function checkRequiredFields(name: string, args: Record<string, unknown>): { fatal: string[]; lenient: string[] } {
  const missing = missingRequiredFields(name, args);
  return { fatal: missing.filter(f => !LENIENT_FIELDS.has(f)), lenient: missing.filter(f => LENIENT_FIELDS.has(f)) };
}

export function extractAnalysis(args: Record<string, unknown>): string | undefined {
  return typeof args.analysis === 'string' && args.analysis.trim() ? args.analysis.trim().slice(0, 4000) : undefined;
}

export function extractNotes(args: Record<string, unknown>): string | undefined {
  return typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim().slice(0, 800) : undefined;
}

export function extractRationale(args: Record<string, unknown>): string | undefined {
  return typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim().slice(0, 500) : undefined;
}

/** Turn one tool call into the actions it stands for (several for place). */
export function toolCallToActions(name: string, args: Record<string, unknown>): BenchAction[] {
  if (name === 'place' || name === 'place_many') {
    const list = args.placements;
    if (!Array.isArray(list)) throw new Error('place needs a placements array (it may be empty with end_turn true).');
    if (list.length === 0 && args.end_turn !== true && !Array.isArray(args.clear_boxes)) throw new Error('place with an empty placements array needs end_turn true (to end the turn) or clear_boxes.');
    if (list.length > MAX_BATCH) throw new Error(`place accepts at most ${MAX_BATCH} placements (got ${list.length}).`);
    const clears: BenchAction[] = [];
    if (args.clear_boxes !== undefined && args.clear_boxes !== null) {
      if (!Array.isArray(args.clear_boxes)) throw new Error('clear_boxes must be an array of {x, y, w, h} boxes.');
      if (args.clear_boxes.length > MAX_CLEAR_BOXES) throw new Error(`clear_boxes accepts at most ${MAX_CLEAR_BOXES} boxes.`);
      for (const b of args.clear_boxes as Record<string, unknown>[]) {
        clears.push({ action: 'clear', region: { x: Number(b?.x), y: Number(b?.y), w: Number(b?.w), h: Number(b?.h) } });
      }
    }
    const actions = [...clears, ...list.map(p => toolCallToAction('place_pattern', (p ?? {}) as Record<string, unknown>))];
    if (args.end_turn === true) actions.push({ action: 'submit' });
    return actions;
  }
  return [toolCallToAction(name, args)];
}

export function toolCallToAction(name: string, args: Record<string, unknown>): BenchAction {
  if (name === 'save_blueprint') {
    if (typeof args.name !== 'string') throw new Error('save_blueprint needs a name.');
    if (!Array.isArray(args.cells)) throw new Error('save_blueprint needs a cells array.');
    const cells = (args.cells as unknown[]).map(c => {
      const pair = c as [number, number];
      return [Number(pair[0]), Number(pair[1])] as [number, number];
    });
    return { action: 'save_blueprint', name: args.name, cells };
  }

  if (name === 'end_turn' || name === 'submit_turn') return { action: 'submit' };

  if (name === 'place_pattern') {
    const anchor = args.anchor;
    if (!Array.isArray(anchor) || anchor.length !== 2) {
      throw new Error('A placement needs a valid [x, y] anchor.');
    }
    const anchorTuple: [number, number] = [Number(anchor[0]), Number(anchor[1])];

    if (Array.isArray(args.cells)) {
      const cells = (args.cells as unknown[]).map(c => {
        const pair = c as [number, number];
        return [Number(pair[0]), Number(pair[1])] as [number, number];
      });
      return { action: 'place', anchor: anchorTuple, cells };
    }

    if (typeof args.preset === 'string') {
      const rotation = typeof args.rotation === 'number' ? args.rotation : undefined;
      return { action: 'place', anchor: anchorTuple, preset: args.preset, rotation };
    }

    throw new Error('A placement needs either "preset" or "cells".');
  }

  throw new Error(`Unknown tool call: ${name}`);
}
