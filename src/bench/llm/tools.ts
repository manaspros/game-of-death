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
  description:
    'Work this out BEFORE choosing placements, in under about 250 words, then DECIDE: do not loop or restart. (0) REVIEW (skip in round 1): for each line of memory.lastRoundReport say CAUSE -> EFFECT in one clause (what you did, what the report says happened, why) and what you will change; do not assume a plan worked, the report is what happened. Then (1) The target Heart box: x range and y range. ' +
    '(2) For EACH planned attacker: pattern, rotation, anchor (quote that pattern\'s range from you.anchorRanges and check the anchor is inside it; check its box does not overlap your Heart box or any of your live cells, since every cell must land on an EMPTY square), start cell, heading; where it is when it reaches the target column ' +
    '(a Glider has moved k in x AND k in y; an LWSS keeps its row); whether that row is inside the target box; whether it ' +
    'stays inside the board the whole way; its arrival generation (must be at most generationsPerRound). ' +
    '(3) INTERACTION CHECK: for each pair of patterns and along each lane, count the empty squares to every other live cell ' +
    '(yours, neutral, visible enemy) and compare with the gap rules; say what each close pair does at generation 1, 2, 4 and at arrival. ' +
    '(4) Do any of YOUR OWN leftover cells (you.cells, battlefield.yours) sit in a lane or within the gap? If so, remove them with clear_boxes. ' +
    '(5) Fix any attacker whose check fails ONCE; if it still fails, do NOT place it. ' +
    '(6) Add up your moves against the pattern costs and use them all. (7) Threats to your own Heart.',
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
      'reported with the reason and the others still apply. Set end_turn to true to finish your turn in the same call.',
    parameters: {
      type: 'object',
      properties: {
        analysis: ANALYSIS_PROPERTY,
        placements: {
          type: 'array',
          minItems: 1,
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
Bring the enemy Heart to 0 HP, or have more Heart HP when the last round ends. Both Hearts start at 100 HP.

# THE BOARD
- x grows to the RIGHT, y grows DOWN; (0,0) is the top-left cell. All coordinates are absolute board coordinates.
- Player 1 owns the LEFT zone, Player 2 the RIGHT zone, with a neutral battlefield between. Player 1 attacks toward +x (right), Player 2 toward -x (left). A zone is {x, y, w, h} = left, top, width, height.
- You may only place cells inside YOUR buildZone.

# EACH ROUND
1. BUILD: both players place cells at the same time and cannot see each other's current build. You have a move budget (you.movesLeft). A placement costs 1 move per cell that is NOT already alive.
2. SIMULATE: Game of Life rules (B3/S23) run for generationsPerRound generations. A cell born from neighbours of only one player belongs to that player; any other birth is neutral. A cell that touches an enemy cell dies together with it; neutral cells touching a player's cell die.
3. RESOLVE: Heart damage is applied, surviving cells stay, the next round begins.

# HEARTS
- Place your Heart first with preset "Heart" (free, once). you.heartPlaced says whether it is already on the board: if true, NEVER place it again; you.heartZone is its box (null until placed). Heart cells are FIXED: they never die or change, ignore every rule, and are not listed in your cell lists. you.heartZone and opponent.heartZone give the Heart's box; opponent.heartZone is null until you have seen it (from round 2).
- Each generation, every ENEMY cell inside a Heart's box costs that Heart 1 HP (at most 5 HP per generation).

# PATTERNS (preset names)
${patternTable()}
- A pattern's top-left is its anchor and it extends right and down. It must fit inside your buildZone: anchor x from buildZone.x to buildZone.x + w - width, anchor y from buildZone.y to buildZone.y + h - height. Rotations 1 and 3 swap width and height.
- rotation = quarter turns clockwise. Glider: rotation 0 moves down-right, 1 down-left, 2 up-left, 3 up-right. LWSS, MWSS and HWSS: 0 moves right, 1 down, 2 left, 3 up.
- Timing: a Glider covers k cells diagonally in 4k generations (k in x AND k in y); an LWSS, MWSS or HWSS covers k cells in 2k generations. From (x0,y0) heading down-right a Glider passes (x0+k, y0+k). Example: a Glider with rotation 2 (up-left) launched at (30,25) is at (26,21) after 16 generations and at (22,17) after 32: it changes row as it travels, so check that its row matches the target when it gets there. An LWSS, MWSS or HWSS never changes row (rotations 0 and 2) or column (1 and 3). A spaceship that reaches the board edge breaks up.
- Budget: divide your moves by a pattern's cost to see how many you can afford (for example 30 moves = 6 Gliders or 3 LWSS). Lanes closer together than a pattern is tall touch and merge, so leave an empty row between them.
- Or give your own "cells": [dx, dy] offsets from the anchor (at most ${MAX_CUSTOM_BOUNDING_BOX}x${MAX_CUSTOM_BOUNDING_BOX}).

# INTERACTIONS: CHECK BEFORE YOU PLACE
Live cells that touch (any of the 8 surrounding squares) change each other from generation 1, and a pattern that is disturbed rarely stays what it was. "Gap" below means empty squares between two patterns' boxes (0 = touching or overlapping).
- Anything you place touching or overlapping another pattern merges with it into a different shape; it does not stay two patterns. Two Gliders anchored 2 rows apart share cells and become one blob.
- Stationary patterns (still lifes, oscillators) stay unchanged only with a gap of at least ${GAP.stationary} (a gap of 2 usually works, 1 is a coin flip, touching nearly always changes them).
- A moving Glider is almost always destroyed if its path touches anything, and is a gamble at a gap of 1: keep at least ${GAP.glider} empty squares between its whole path and every other live cell.
- LWSS, MWSS and HWSS are more fragile: keep at least ${GAP.spaceship} empty squares between their whole path and every other live cell. Same-heading attackers launched side by side need anchors at least (their height + ${GAP.parallelExtraRows}) apart: 5 for Gliders, 6 for an LWSS, 7 for an MWSS or HWSS.
- Walk each lane before you commit: list the squares a mover passes (a Glider moves 1 square diagonally every 4 generations; the LWSS family moves 1 square every 2) and check each against ALL live cells: yours (you.cells, battlefield.yours, intruders), neutral, the enemy cells you can see, and your other placements this turn.
- Cells from earlier rounds still exist and keep evolving. Do not place beside them without checking the gap. If your own leftovers sit in a lane or within the gap, remove them with clear_boxes first; never fly a mover into your own structures (it destroys both and can blow up into a mess that blocks your lanes for the rest of the match).
- Chaotic patterns throw debris in every direction: keep them well away from your own patterns and aim them, since their debris wrecks anything it touches, yours included.
- Reason about the future, not just generation 0: step an interaction forward (generation 1, 2, 4, 8) whenever two things are within the gaps above, and re-check at the generation the attacker arrives.

# YOUR JSON EACH CALL
round, maxRounds, generationsPerRound, board (width, height), phase
you: player, side, attackDirection, movesLeft, heartHp, heartPlaced, heartZone, buildZone, blueprints (your saved formations with their cells), anchorRanges (for every pattern and blueprint: the anchor x and y [min, max] that keep it inside your zone; rot90 is for rotations 1 and 3; an anchor outside these is rejected), cells (your live cells in your zone, [x,y], Heart excluded), intruders, enemyCellsInsideHeartBox (enemy cells inside your Heart box now: each costs you HP every generation)
opponent: heartHp, heartZone, buildZone, visibleCells (what you can see of their zone: last round's cells unless visibility is "visible"), yourCellsThere (YOUR cells inside their zone, where they are now), yourCellsInsideHeartBox (the ones hurting their Heart right now)
memory: notes (what YOU wrote), lastRoundReport (plain facts about what each of your placements did last round and what hurt you), thisTurn (what you already placed this turn), history (one entry per finished round: yourPlacements, yourHeartHp, damageYouTook, enemyHeartHp, damageYouDealt, yourCellsOnBattlefield, enemyCellsOnBattlefield)
battlefield: zone, yours / theirs / neutral cell lists
previousActionRejected: only present if part of your last call failed; it says exactly why.

# TOOLS
- place: up to ${MAX_BATCH} placements per call. Fill in "analysis" first: it is where you check your plan before committing to it. Plan the WHOLE turn and send it in ONE call with end_turn=true whenever you can; each call is slow and expensive. If something fails you get the reasons and can fix it in one more call.
- clear_boxes (a field of place): remove your OWN leftover cells from boxes {x, y, w, h} inside your zone before your placements. Free (no moves spent, none refunded). It cannot touch your Heart, enemy cells, or anything outside your zone. Leftovers from earlier rounds persist, so a lane you blocked yourself stays blocked until you clear it.
- save_blueprint: save a formation (free) to redeploy later by name; deploying costs its live cells like placing them by hand.
- end_turn: when nothing useful fits in your remaining moves.

# MEMORY
Every call starts fresh: you do not remember earlier calls. Your only memory is memory.notes (written by you), memory.lastRoundReport (measured facts about last round), memory.thisTurn and memory.history. A report line compares a placement ALONE with the real round: if alone it hurts the Heart but in the real round it did not, something on the board stopped it. If damage came from a cell of yours inside their Heart box, it keeps dealing damage every generation (and next round) until destroyed. Before planning, review: for each placement say what you expected, what the report says happened, and the cause; never assume it worked. Write notes as LESSONS (for example "LESSON: LWSS at (9,18) died at gen 12 hitting my own beehive at (15,18): clear it first"), not summaries. Your first notes each turn replace last turn's; later calls in the same turn are appended. If damageYouDealt is 0, change something.

# HOW TO PLAY: AGGRESSIVELY
- A passive build loses on Heart HP. Pressure the enemy Heart every round from several rows or lanes at once, and punish whatever you can see of their layout.
- Spend your whole move budget unless extra cells would clearly hurt you.
- Reason concretely before choosing: where is the enemy Heart box; which lane reaches it within generationsPerRound generations (use the timing and heading facts above); what will each pattern collide with on the way; what threatens YOUR Heart box and how do you stop it.
- Balance attack and defence: kill or block incoming structures before they reach your Heart box, then keep attackers coming.
- Learn between rounds: if last round's attackers died, missed or were intercepted, change lane, timing or pattern.

# COMMON MISTAKES
- Placing a pattern partly outside your buildZone (check anchor ranges above).
- Gliders launched in the wrong heading: from the right side use rotation 1 or 2; from the left side use 0 or 3.
- Targeting a row your heading cannot reach in time (a Glider changes row by 1 per 4 generations).
- Placing a pattern on top of live cells (your Heart box, your leftovers): cells that are already alive are skipped, so the pattern comes out INCOMPLETE and does not behave (an LWSS dropped on your Heart is not an LWSS) while the game still answers ok. Every cell must land on an empty square. Your Heart box is full of live cells, so keep launch pads off it.
- Anchoring outside you.anchorRanges (a 5-wide pattern cannot have anchor x 13 in a zone that ends at x 13).
- Confusing your Heart with the enemy's: your Heart is you.heartZone and is on YOUR side; attacks aim at opponent.heartZone.
- Placing an attacker whose own check failed ("I'll just place it and see" wastes the move and often wrecks your own lane).
- Placing patterns closer than the gaps above, or aiming a mover through your own cells or an enemy structure without checking its path.
- Spreading lanes wider than the target Heart box: only a lane that arrives inside the box's rows (or columns) can hurt it.
- Ending your turn with most of your moves unspent.
- Sending several tool calls when one place call with end_turn would do.

# RATIONALE
Every call needs a short rationale: your target (coordinates), your lane (start cell + heading) and the generation you expect to arrive. Every place call also needs notes for your future self.`;

/** The user message: the observation, plus why the previous call partly failed if it did. */
export function buildUserMessage(observation: Observation, _availablePresets: string[], previousRejection?: string): string {
  const payload: Record<string, unknown> = { ...observation };
  if (previousRejection) {
    payload.previousActionRejected = previousRejection;
  }
  return JSON.stringify(payload);
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
    if (!Array.isArray(list) || list.length === 0) throw new Error('place needs a non-empty placements array.');
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
