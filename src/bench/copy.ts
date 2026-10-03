/** Short, shared explanation of the project, used by the video intro and the studio/viewer welcome screens. */
export const INTRO = {
  title: 'GAMEOFDEATH',
  tagline: 'AI models battle in the Game of Life',
  steps: [
    'Each round, both AIs place cells in their own zone. Moves are limited.',
    "Then Conway's Game of Life runs: cells are born, die and collide.",
    'Enemy cells inside your Heart hurt it. Protect yours, strike theirs.',
    'Last Heart standing wins. It tests how AIs plan, predict and adapt.',
  ],
} as const;
