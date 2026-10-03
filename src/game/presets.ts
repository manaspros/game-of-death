import type { BoardLayout, PresetName } from '../engine/types';

export interface Preset {
  name: string;
  width: number;
  height: number;
  buildZoneWidth: number;
  movesPerRound: number;
  maxRounds: number;
  generationsPerRound: number;
  cellMaxAge: number;
}

export const PRESETS: Record<PresetName, Preset> = {
  quick: {
    name: 'Quick',
    width: 150,
    height: 70,
    buildZoneWidth: 20,
    movesPerRound: 25,
    maxRounds: 8,
    generationsPerRound: 80,
    cellMaxAge: 80,
  },
  standard: {
    name: 'Standard',
    width: 180,
    height: 80,
    buildZoneWidth: 24,
    movesPerRound: 40,
    maxRounds: 10,
    generationsPerRound: 100,
    cellMaxAge: 100,
  },
  skirmish: {
    name: 'Skirmish',
    width: 48,
    height: 40,
    buildZoneWidth: 14,
    movesPerRound: 30,
    maxRounds: 8,
    generationsPerRound: 160,
    cellMaxAge: 160,
  },
  epic: {
    name: 'Epic',
    width: 200,
    height: 90,
    buildZoneWidth: 28,
    movesPerRound: 60,
    maxRounds: 15,
    generationsPerRound: 150,
    cellMaxAge: 150,
  },
};

export function getPreset(name: string): Preset {
  return PRESETS[name as PresetName] ?? PRESETS.standard;
}

export function getBoardLayout(preset: Preset): BoardLayout {
  const bw = preset.buildZoneWidth;
  const fw = preset.width - 2 * bw;
  return {
    p1Build: { x: 0, y: 0, w: bw, h: preset.height },
    battlefield: { x: bw, y: 0, w: fw, h: preset.height },
    p2Build: { x: bw + fw, y: 0, w: bw, h: preset.height },
  };
}
