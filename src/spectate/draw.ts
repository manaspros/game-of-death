import type { Snapshot } from '../bench/snapshot';

export const COLORS = {
  p1: '#4a9eff',
  p2: '#ff6b8a',
  neutral: '#ffffff',
  p1Heart: '#b8dcff',
  p2Heart: '#ffc2d0',
  p1Zone: 'rgba(74,158,255,0.10)',
  p2Zone: 'rgba(255,107,138,0.10)',
  battlefield: '#0a0a10',
};

export function cellSizeFor(s: Snapshot, maxWidth: number, maxHeight: number): number {
  return Math.max(2, Math.floor(Math.min(maxWidth / s.width, maxHeight / s.height)));
}

/** Draws zones, cells and dashed heart-zone outlines with the board's top-left at (ox, oy). */
export function drawBoardAt(ctx: CanvasRenderingContext2D, s: Snapshot, ox: number, oy: number, cell: number): void {
  const fill = (z: Snapshot['zones']['p1'], color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(ox + z.x * cell, oy + z.y * cell, z.w * cell, z.h * cell);
  };
  fill(s.zones.p1, COLORS.p1Zone);
  fill(s.zones.battlefield, COLORS.battlefield);
  fill(s.zones.p2, COLORS.p2Zone);

  const size = cell - (cell > 4 ? 1 : 0);
  for (let i = 0; i < s.cells.length; i += 3) {
    const owner = s.cells[i + 2];
    ctx.fillStyle =
      owner === 1 ? COLORS.p1
        : owner === 2 ? COLORS.p2
          : owner === 4 ? COLORS.p1Heart
            : owner === 5 ? COLORS.p2Heart
              : COLORS.neutral;
    ctx.fillRect(ox + s.cells[i] * cell, oy + s.cells[i + 1] * cell, size, size);
  }

  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  for (const [side, color] of [[s.p1, COLORS.p1], [s.p2, COLORS.p2]] as const) {
    const z = side.heartZone;
    if (!z) continue;
    ctx.strokeStyle = color;
    ctx.strokeRect(ox + z.x * cell - 1, oy + z.y * cell - 1, z.w * cell + 2, z.h * cell + 2);
  }
  ctx.setLineDash([]);
}
