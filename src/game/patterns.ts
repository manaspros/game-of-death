export interface Pattern {
  name: string;
  category: 'still' | 'oscillator' | 'spaceship' | 'chaotic' | 'special';
  cells: readonly [number, number][];
  width: number;
  height: number;
}

export interface RotatedPattern {
  name: string;
  category: 'still' | 'oscillator' | 'spaceship' | 'chaotic' | 'special';
  cells: [number, number][];
  width: number;
  height: number;
}

export const PATTERNS: readonly Pattern[] = [
  {
    name: 'Block',
    category: 'still',
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
    width: 2,
    height: 2,
  },
  {
    name: 'Beehive',
    category: 'still',
    cells: [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [2, 2]],
    width: 4,
    height: 3,
  },
  {
    name: 'Boat',
    category: 'still',
    cells: [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'Ship',
    category: 'still',
    cells: [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2], [2, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'Tub',
    category: 'still',
    cells: [[1, 0], [0, 1], [2, 1], [1, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'Blinker',
    category: 'oscillator',
    cells: [[0, 0], [1, 0], [2, 0]],
    width: 3,
    height: 1,
  },
  {
    name: 'Toad',
    category: 'oscillator',
    cells: [[1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1]],
    width: 4,
    height: 2,
  },
  {
    name: 'Beacon',
    category: 'oscillator',
    cells: [[0, 0], [1, 0], [0, 1], [3, 2], [2, 3], [3, 3]],
    width: 4,
    height: 4,
  },
  {
    name: 'Glider',
    category: 'spaceship',
    cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'LWSS',
    category: 'spaceship',
    cells: [
      [1, 0], [2, 0], [3, 0], [4, 0],
      [0, 1], [4, 1],
      [4, 2],
      [0, 3], [3, 3],
    ],
    width: 5,
    height: 4,
  },
  {
    name: 'MWSS',
    category: 'spaceship',
    cells: [[2, 0], [4, 1], [0, 1], [5, 2], [5, 3], [0, 3], [5, 4], [4, 4], [3, 4], [2, 4], [1, 4]],
    width: 6,
    height: 5,
  },
  {
    name: 'HWSS',
    category: 'spaceship',
    cells: [[3, 0], [2, 0], [5, 1], [0, 1], [6, 2], [6, 3], [0, 3], [6, 4], [5, 4], [4, 4], [3, 4], [2, 4], [1, 4]],
    width: 7,
    height: 5,
  },
  {
    name: 'R-pentomino',
    category: 'chaotic',
    cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'Acorn',
    category: 'chaotic',
    cells: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]],
    width: 7,
    height: 3,
  },
  {
    name: 'Diehard',
    category: 'chaotic',
    cells: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]],
    width: 8,
    height: 3,
  },
  {
    name: 'Pi-heptomino',
    category: 'chaotic',
    cells: [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
    width: 3,
    height: 3,
  },
  {
    name: 'Thunderbird',
    category: 'chaotic',
    cells: [[0, 0], [1, 0], [2, 0], [1, 2], [1, 3], [1, 4]],
    width: 3,
    height: 5,
  },
  {
    name: 'Pulsar',
    category: 'oscillator',
    cells: [
      [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0],
      [0, 2], [5, 2], [7, 2], [12, 2],
      [0, 3], [5, 3], [7, 3], [12, 3],
      [0, 4], [5, 4], [7, 4], [12, 4],
      [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5],
      [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
      [0, 8], [5, 8], [7, 8], [12, 8],
      [0, 9], [5, 9], [7, 9], [12, 9],
      [0, 10], [5, 10], [7, 10], [12, 10],
      [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
    ],
    width: 13,
    height: 13,
  },
  {
    name: 'Pentadecathlon',
    category: 'oscillator',
    cells: [[2, 0], [7, 0], [0, 1], [1, 1], [3, 1], [4, 1], [5, 1], [6, 1], [8, 1], [9, 1], [2, 2], [7, 2]],
    width: 10,
    height: 3,
  },
  {
    name: 'Heart',
    category: 'special',
    cells: [[1, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [3, 2], [2, 3]],
    width: 5,
    height: 4,
  },
] as const;

export function getPatternByName(name: string): Pattern | undefined {
  return PATTERNS.find(p => p.name === name);
}

export function rotatePattern(pattern: Pattern, times: number): RotatedPattern {
  const t = ((times % 4) + 4) % 4;
  if (t === 0) {
    return { ...pattern, cells: [...pattern.cells] };
  }

  let cells: [number, number][] = pattern.cells.map(([x, y]) => [x, y]);
  let w = pattern.width;
  let h = pattern.height;

  for (let i = 0; i < t; i++) {
    const newCells: [number, number][] = [];
    for (const [x, y] of cells) {
      newCells.push([h - 1 - y, x]);
    }
    cells = newCells;
    const tmp = w;
    w = h;
    h = tmp;
  }

  return { name: pattern.name, category: pattern.category, cells, width: w, height: h };
}
