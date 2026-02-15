import { formatTime } from './components.js';

interface SleepBubble {
  startTime: Date;
  endTime: Date | null;
  type: 'nap' | 'night';
  status: 'completed' | 'active' | 'predicted';
}

interface ArcConfig {
  arcStartHour: number; // e.g. 6 for day, 18 for night
  arcEndHour: number;   // e.g. 18 for day, 30 (6+24) for night
  startIcon: string;
  endIcon: string;
}

function getDayArcConfig(wakeUpTime?: string | null): ArcConfig {
  let arcStartHour = 6;
  if (wakeUpTime) {
    const wake = new Date(wakeUpTime);
    arcStartHour = wake.getHours() + wake.getMinutes() / 60;
  }
  // Arc spans ~12 hours from wake-up
  return { arcStartHour, arcEndHour: arcStartHour + 12, startIcon: '☀️', endIcon: '🌅' };
}

function getNightArcConfig(): ArcConfig {
  return { arcStartHour: 18, arcEndHour: 30, startIcon: '🌅', endIcon: '☀️' };
}

function hourOfDay(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

/** Convert a Date to a fractional hour on the arc (0..12 range). */
function timeToArcFraction(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  // For night arc, hours 0-6 need to be treated as 24-30
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  const frac = (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
  return Math.max(0, Math.min(1, frac));
}

/** Convert fraction (0..1) to a point on a semicircular arc. */
function fracToPoint(frac: number, cx: number, cy: number, r: number): { x: number; y: number } {
  // Arc goes from left (π) to right (0) — a top semicircle
  const angle = Math.PI * (1 - frac);
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

export interface ArcInput {
  todaySleeps: Array<{ start_time: string; end_time: string | null; type: 'nap' | 'night' }>;
  activeSleep: { start_time: string; type: 'nap' | 'night' } | null;
  prediction: { nextNap: string; bedtime?: string; predictedNaps?: Array<{ startTime: string; endTime: string }> } | null;
  isNightMode: boolean;
  wakeUpTime?: string | null;
}

export function renderArc(input: ArcInput): SVGElement {
  const config = input.isNightMode ? getNightArcConfig() : getDayArcConfig(input.wakeUpTime);
  const W = 340, H = 200;
  const cx = W / 2, cy = H - 20, r = 140;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'sleep-arc');

  // Defs for animations
  const defs = document.createElementNS(ns, 'defs');

  // Glow filter for active sleep
  const filter = document.createElementNS(ns, 'filter');
  filter.setAttribute('id', 'arc-glow');
  filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
  const blur = document.createElementNS(ns, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '3');
  blur.setAttribute('result', 'glow');
  filter.appendChild(blur);
  const merge = document.createElementNS(ns, 'feMerge');
  const mn1 = document.createElementNS(ns, 'feMergeNode'); mn1.setAttribute('in', 'glow');
  const mn2 = document.createElementNS(ns, 'feMergeNode'); mn2.setAttribute('in', 'SourceGraphic');
  merge.appendChild(mn1); merge.appendChild(mn2);
  filter.appendChild(merge);
  defs.appendChild(filter);
  svg.appendChild(defs);

  // Draw arc track
  const arcPath = document.createElementNS(ns, 'path');
  const startPt = fracToPoint(0, cx, cy, r);
  const endPt = fracToPoint(1, cx, cy, r);
  arcPath.setAttribute('d', `M ${startPt.x} ${startPt.y} A ${r} ${r} 0 0 1 ${endPt.x} ${endPt.y}`);
  arcPath.setAttribute('fill', 'none');
  arcPath.setAttribute('stroke', 'var(--cream-dark)');
  arcPath.setAttribute('stroke-width', '6');
  arcPath.setAttribute('stroke-linecap', 'round');
  arcPath.setAttribute('class', 'arc-track');
  svg.appendChild(arcPath);

  // Hour tick marks
  for (let h = 0; h <= 12; h += 3) {
    const frac = h / 12;
    const outerPt = fracToPoint(frac, cx, cy, r + 8);
    const innerPt = fracToPoint(frac, cx, cy, r - 8);
    const tick = document.createElementNS(ns, 'line');
    tick.setAttribute('x1', String(outerPt.x)); tick.setAttribute('y1', String(outerPt.y));
    tick.setAttribute('x2', String(innerPt.x)); tick.setAttribute('y2', String(innerPt.y));
    tick.setAttribute('stroke', 'var(--text-light)'); tick.setAttribute('stroke-width', '1.5');
    tick.setAttribute('opacity', '0.5');
    svg.appendChild(tick);

    // Hour label
    const labelPt = fracToPoint(frac, cx, cy, r + 20);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(labelPt.x)); label.setAttribute('y', String(labelPt.y));
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('class', 'arc-hour-label');
    const displayHour = (config.arcStartHour + h) % 24;
    label.textContent = `${String(displayHour).padStart(2, '0')}`;
    svg.appendChild(label);
  }

  // Anchor icons
  const iconStart = document.createElementNS(ns, 'text');
  iconStart.setAttribute('x', String(startPt.x - 18)); iconStart.setAttribute('y', String(startPt.y + 6));
  iconStart.setAttribute('font-size', '18'); iconStart.setAttribute('text-anchor', 'middle');
  iconStart.textContent = config.startIcon;
  svg.appendChild(iconStart);

  const iconEnd = document.createElementNS(ns, 'text');
  iconEnd.setAttribute('x', String(endPt.x + 18)); iconEnd.setAttribute('y', String(endPt.y + 6));
  iconEnd.setAttribute('font-size', '18'); iconEnd.setAttribute('text-anchor', 'middle');
  iconEnd.textContent = config.endIcon;
  svg.appendChild(iconEnd);

  // Collect bubbles
  const bubbles: SleepBubble[] = [];

  for (const s of input.todaySleeps) {
    if (input.activeSleep && !s.end_time) continue; // skip active, handled separately
    if (!s.end_time) continue;
    bubbles.push({
      startTime: new Date(s.start_time),
      endTime: new Date(s.end_time),
      type: s.type as 'nap' | 'night',
      status: 'completed',
    });
  }

  if (input.activeSleep) {
    bubbles.push({
      startTime: new Date(input.activeSleep.start_time),
      endTime: null,
      type: input.activeSleep.type as 'nap' | 'night',
      status: 'active',
    });
  }

  // Add all predicted naps for the day (when no sleeps yet)
  if (input.prediction?.predictedNaps && !input.activeSleep) {
    for (const pred of input.prediction.predictedNaps) {
      bubbles.push({
        startTime: new Date(pred.startTime),
        endTime: new Date(pred.endTime),
        type: 'nap',
        status: 'predicted',
      });
    }
  } else if (input.prediction?.nextNap && !input.activeSleep) {
    // Fallback: show single next nap prediction
    const predTime = new Date(input.prediction.nextNap);
    bubbles.push({
      startTime: predTime,
      endTime: new Date(predTime.getTime() + 45 * 60000),
      type: 'nap',
      status: 'predicted',
    });
  }
  
  // Add predicted bedtime bubble
  if (input.prediction?.bedtime && !input.activeSleep) {
    const bedtime = new Date(input.prediction.bedtime);
    bubbles.push({
      startTime: bedtime,
      endTime: null,
      type: 'night',
      status: 'predicted',
    });
  }

  // Render bubbles on the arc
  for (const bubble of bubbles) {
    const isBedtime = bubble.type === 'night' && bubble.status === 'predicted' && !bubble.endTime;
    
    const startFrac = timeToArcFraction(bubble.startTime, config);
    const endFrac = bubble.endTime
      ? timeToArcFraction(bubble.endTime, config)
      : (isBedtime ? startFrac : timeToArcFraction(new Date(), config));

    // Skip if entirely outside arc range
    if (startFrac > 1 && endFrac > 1) continue;
    if (startFrac < 0 && endFrac < 0) continue;

    const midFrac = (startFrac + endFrac) / 2;
    const spanFrac = isBedtime ? 0.04 : Math.max(0.02, Math.abs(endFrac - startFrac));

    const midPt = fracToPoint(midFrac, cx, cy, r);
    // Pill width proportional to duration, min 20px
    const pillW = Math.max(20, Math.min(60, spanFrac * Math.PI * r));
    const pillH = isBedtime ? 20 : 14;

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', `arc-bubble arc-bubble-${bubble.status}${isBedtime ? ' arc-bedtime' : ''}`);

    if (isBedtime) {
      // Bedtime: show moon icon instead of pill
      const moon = document.createElementNS(ns, 'text');
      moon.setAttribute('x', String(midPt.x));
      moon.setAttribute('y', String(midPt.y));
      moon.setAttribute('font-size', '18');
      moon.setAttribute('text-anchor', 'middle');
      moon.setAttribute('dominant-baseline', 'middle');
      moon.textContent = '🌙';
      g.appendChild(moon);
    } else {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(midPt.x - pillW / 2));
      rect.setAttribute('y', String(midPt.y - pillH / 2));
      rect.setAttribute('width', String(pillW));
      rect.setAttribute('height', String(pillH));
      rect.setAttribute('rx', String(pillH / 2));
      rect.setAttribute('ry', String(pillH / 2));

      if (bubble.status === 'completed') {
        rect.setAttribute('fill', 'var(--moon)');
        rect.setAttribute('opacity', '0.8');
      } else if (bubble.status === 'active') {
        rect.setAttribute('fill', 'var(--moon-glow)');
        rect.setAttribute('filter', 'url(#arc-glow)');
        rect.setAttribute('class', 'arc-active-pulse');
      } else {
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', 'var(--moon)');
        rect.setAttribute('stroke-width', '2');
        rect.setAttribute('stroke-dasharray', '4 3');
        rect.setAttribute('opacity', '0.6');
      }
      g.appendChild(rect);
    }

    // Time label on bubble (below for bedtime)
    const timeLabel = document.createElementNS(ns, 'text');
    timeLabel.setAttribute('x', String(midPt.x));
    timeLabel.setAttribute('y', String(midPt.y + (isBedtime ? 16 : 1)));
    timeLabel.setAttribute('text-anchor', 'middle');
    timeLabel.setAttribute('dominant-baseline', 'middle');
    timeLabel.setAttribute('class', 'arc-bubble-label');
    timeLabel.textContent = formatTime(bubble.startTime);
    g.appendChild(timeLabel);

    svg.appendChild(g);
  }

  // Short naps indicator (clouds below arc for naps < 30min)
  const shortNaps = input.todaySleeps.filter(s => {
    if (!s.end_time) return false;
    const dur = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
    return dur < 30 * 60000 && s.type === 'nap';
  });

  if (shortNaps.length > 0) {
    const cloudY = cy + 10;
    let cloudX = cx - (shortNaps.length - 1) * 20;
    for (const sn of shortNaps) {
      const dur = Math.round((new Date(sn.end_time!).getTime() - new Date(sn.start_time).getTime()) / 60000);
      const cloud = document.createElementNS(ns, 'text');
      cloud.setAttribute('x', String(cloudX)); cloud.setAttribute('y', String(cloudY));
      cloud.setAttribute('text-anchor', 'middle');
      cloud.setAttribute('class', 'arc-short-nap');
      cloud.textContent = `☁️ ${dur}m`;
      svg.appendChild(cloud);
      cloudX += 40;
    }
  }

  return svg;
}
