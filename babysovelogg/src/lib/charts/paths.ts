// SVG path generators for the stats charts. Pure string builders that take
// pre-formatted "x,y" point strings (the shape the builders already produce) so
// the output is byte-identical to the previous inline code. Multi-series charts
// reuse these per series.

/** A polyline through the points: `M x,y L x,y …`. */
export function polyline(pts: string[]): string {
  return `M${pts.join(" L")}`;
}

/** A filled area under a polyline, closed down to `baseY` between `x0` and `xN`. */
export function areaUnder(pts: string[], x0: number, xN: number, baseY: number): string {
  return `M${x0},${baseY} L${pts.join(" L")} L${xN},${baseY} Z`;
}

/** A filled band between an upper line and a lower line. `lowerInOrder` must be
 *  in the order it should be appended (i.e. already reversed when closing a
 *  polygon back along the bottom). */
export function band(upperPts: string[], lowerInOrder: string[]): string {
  return `M${upperPts.join(" L")} L${lowerInOrder.join(" L")} Z`;
}

/** A step line: horizontal then vertical between points (`M`, then `H x V y`). */
export function stepPath(xs: number[], ys: number[]): string {
  const segments: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i === 0) segments.push(`M${xs[i]},${ys[i]}`);
    else segments.push(`H${xs[i]} V${ys[i]}`);
  }
  return segments.join(" ");
}
