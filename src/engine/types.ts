export type Owner = 'p1' | 'p2' | 'neutral';

export type Phase = 'build' | 'simulate' | 'resolve' | 'gameover';

export type VisibilityMode = 'semi-hidden' | 'visible';

export type SimSpeed = 'fast' | 'normal' | 'slow';

export type PresetName = 'quick' | 'standard' | 'epic' | 'skirmish';

export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardLayout {
  p1Build: Zone;
  battlefield: Zone;
  p2Build: Zone;
}

export interface Heart {
  hp: number;
  maxHp: number;
  placed: boolean;
  zone: Zone | null;
}
