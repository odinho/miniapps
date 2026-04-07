/** Justified layout: pack images into rows filling a container */

export interface Rect { x: number; y: number; w: number; h: number; }

export function justifiedLayout(
  items: Array<{ w: number; h: number }>,
  containerW: number,
  containerH: number,
  gap: number = 4
): Rect[] {
  if (!items.length) return [];
  const aspects = items.map(it => it.w / (it.h || 1));

  let bestLayout: { rects: Rect[]; fill: number } | null = null;
  let bestFill = 0;
  const maxRows = Math.min(items.length, Math.ceil(Math.sqrt(items.length) + 1));

  for (let nRows = 1; nRows <= maxRows; nRows++) {
    const layout = computeRows(aspects, containerW, containerH, gap, nRows);
    if (layout && layout.fill > bestFill) { bestLayout = layout; bestFill = layout.fill; }
  }
  return bestLayout ? bestLayout.rects : items.map((_, i) => ({ x: 0, y: i * 100, w: 100, h: 100 }));
}

function computeRows(
  aspects: number[], W: number, H: number, gap: number, nRows: number
): { rects: Rect[]; fill: number } | null {
  const n = aspects.length;
  const totalAspect = aspects.reduce((s, a) => s + a, 0);
  const targetPerRow = totalAspect / nRows;

  const rows: number[][] = [];
  let cur: number[] = [];
  let curAspect = 0;
  for (let i = 0; i < n; i++) {
    cur.push(i);
    curAspect += aspects[i];
    if (rows.length < nRows - 1 && curAspect >= targetPerRow * 0.8 && cur.length > 0) {
      rows.push(cur);
      cur = []; curAspect = 0;
    }
  }
  if (cur.length) rows.push(cur);

  const totalGapH = gap * (rows.length - 1);
  const availH = H - totalGapH;
  if (availH <= 0) return null;

  const rowData = rows.map(indices => ({
    indices,
    rowAspect: indices.reduce((s, i) => s + aspects[i], 0),
    rowGapW: gap * (indices.length - 1),
  }));

  const rawHeights = rowData.map(r => (W - r.rowGapW) / r.rowAspect);
  const totalRawH = rawHeights.reduce((s, h) => s + h, 0);
  const scale = Math.min(1, availH / totalRawH);

  const rects: Rect[] = [];
  let y = 0;
  let usedArea = 0;
  for (let r = 0; r < rows.length; r++) {
    const rowH = rawHeights[r] * scale;
    let x = 0;
    for (const i of rows[r]) {
      const imgW = rowH * aspects[i];
      rects[i] = { x, y, w: imgW, h: rowH };
      usedArea += imgW * rowH;
      x += imgW + gap;
    }
    y += rowH + gap;
  }

  return { rects, fill: usedArea / (W * H) };
}
