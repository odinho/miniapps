import { formatTime, formatDuration } from './components.js';

interface SleepBubble {
  startTime: Date;
  endTime: Date | null;
  type: 'nap' | 'night';
  status: 'completed' | 'active' | 'predicted';
}

interface ArcConfig {
  arcStartHour: number;
  arcEndHour: number;
  startIcon: string;
  endIcon: string;
}

function getDayArcConfig(wakeUpTime?: string | null): ArcConfig {
  let arcStartHour = 6;
  if (wakeUpTime) {
    const wake = new Date(wakeUpTime);
    arcStartHour = wake.getHours() + wake.getMinutes() / 60;
  }
  return { arcStartHour, arcEndHour: arcStartHour + 12, startIcon: '☀️', endIcon: '🌙' };
}

function getNightArcConfig(): ArcConfig {
  return { arcStartHour: 18, arcEndHour: 30, startIcon: '🌙', endIcon: '☀️' };
}

function hourOfDay(d: Date): number {
  return d.getHours() + d.getMinutes() / 60;
}

function timeToArcFraction(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  const frac = (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
  return Math.max(0, Math.min(1, frac));
}

function timeToArcFractionRaw(d: Date, config: ArcConfig): number {
  let h = hourOfDay(d);
  if (config.arcStartHour >= 18 && h < 12) h += 24;
  return (h - config.arcStartHour) / (config.arcEndHour - config.arcStartHour);
}

// 270-degree arc: starts at bottom-left (225°) and goes clockwise to bottom-right (315°)
// The gap is at the bottom center
const ARC_START_ANGLE = (5 / 4) * Math.PI;  // 225° = bottom-left
const ARC_SWEEP = (3 / 2) * Math.PI;         // 270° sweep

function fracToPoint(frac: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const angle = ARC_START_ANGLE - frac * ARC_SWEEP;
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

function describeArc(cx: number, cy: number, r: number, startFrac: number, endFrac: number): string {
  const start = fracToPoint(startFrac, cx, cy, r);
  const end = fracToPoint(endFrac, cx, cy, r);
  const sweep = (endFrac - startFrac) * ARC_SWEEP;
  const largeArc = sweep > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
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
  const S = 320; // square viewbox
  const cx = S / 2, cy = S / 2, r = 130;
  const trackWidth = 12;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'sleep-arc');

  // Defs
  const defs = document.createElementNS(ns, 'defs');

  // Glow filter
  const filter = document.createElementNS(ns, 'filter');
  filter.setAttribute('id', 'arc-glow');
  filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
  const blur = document.createElementNS(ns, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '4');
  blur.setAttribute('result', 'glow');
  filter.appendChild(blur);
  const merge = document.createElementNS(ns, 'feMerge');
  const mn1 = document.createElementNS(ns, 'feMergeNode'); mn1.setAttribute('in', 'glow');
  const mn2 = document.createElementNS(ns, 'feMergeNode'); mn2.setAttribute('in', 'SourceGraphic');
  merge.appendChild(mn1); merge.appendChild(mn2);
  filter.appendChild(merge);
  defs.appendChild(filter);
  svg.appendChild(defs);

  // Background track (270-degree arc)
  const trackPath = document.createElementNS(ns, 'path');
  trackPath.setAttribute('d', describeArc(cx, cy, r, 0, 1));
  trackPath.setAttribute('fill', 'none');
  // Use a visible color that works on both day and night themes
  const isNight = document.documentElement.getAttribute('data-theme') === 'night';
  trackPath.setAttribute('stroke', isNight ? 'rgba(160, 150, 200, 0.35)' : 'var(--lavender-dark)');
  trackPath.setAttribute('stroke-width', String(trackWidth));
  trackPath.setAttribute('stroke-linecap', 'round');
  svg.appendChild(trackPath);

  // Endpoint icons at the gap
  const startPt = fracToPoint(0, cx, cy, r);
  const endPt = fracToPoint(1, cx, cy, r);

  const iconStart = document.createElementNS(ns, 'text');
  iconStart.setAttribute('x', String(startPt.x));
  iconStart.setAttribute('y', String(startPt.y + 24));
  iconStart.setAttribute('font-size', '16');
  iconStart.setAttribute('text-anchor', 'middle');
  iconStart.textContent = config.startIcon;
  svg.appendChild(iconStart);

  const iconEnd = document.createElementNS(ns, 'text');
  iconEnd.setAttribute('x', String(endPt.x));
  iconEnd.setAttribute('y', String(endPt.y + 24));
  iconEnd.setAttribute('font-size', '16');
  iconEnd.setAttribute('text-anchor', 'middle');
  iconEnd.textContent = config.endIcon;
  svg.appendChild(iconEnd);

  // Current time indicator (thin line)
  const nowFracRaw = timeToArcFractionRaw(new Date(), config);
  if (nowFracRaw >= 0 && nowFracRaw <= 1) {
    const nowFrac = Math.max(0, Math.min(1, nowFracRaw));
    const nowOuter = fracToPoint(nowFrac, cx, cy, r + trackWidth / 2 + 4);
    const nowInner = fracToPoint(nowFrac, cx, cy, r - trackWidth / 2 - 4);
    const marker = document.createElementNS(ns, 'line');
    marker.setAttribute('x1', String(nowOuter.x)); marker.setAttribute('y1', String(nowOuter.y));
    marker.setAttribute('x2', String(nowInner.x)); marker.setAttribute('y2', String(nowInner.y));
    marker.setAttribute('stroke', 'var(--sun)');
    marker.setAttribute('stroke-width', '2.5');
    marker.setAttribute('stroke-linecap', 'round');
    marker.setAttribute('opacity', '0.9');
    svg.appendChild(marker);
  }

  // Collect bubbles
  const bubbles: SleepBubble[] = [];

  for (const s of input.todaySleeps) {
    if (input.activeSleep && !s.end_time) continue;
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
    const predTime = new Date(input.prediction.nextNap);
    bubbles.push({
      startTime: predTime,
      endTime: new Date(predTime.getTime() + 45 * 60000),
      type: 'nap',
      status: 'predicted',
    });
  }

  if (input.prediction?.bedtime && !input.activeSleep) {
    const bedtime = new Date(input.prediction.bedtime);
    bubbles.push({
      startTime: bedtime,
      endTime: null,
      type: 'night',
      status: 'predicted',
    });
  }

  // Render bubbles as arc segments
  for (const bubble of bubbles) {
    const isBedtime = bubble.type === 'night' && bubble.status === 'predicted' && !bubble.endTime;

    const startFracRaw = timeToArcFractionRaw(bubble.startTime, config);
    const endFracRaw = bubble.endTime
      ? timeToArcFractionRaw(bubble.endTime, config)
      : (isBedtime ? startFracRaw : timeToArcFractionRaw(new Date(), config));

    if (startFracRaw > 1.05 && endFracRaw > 1.05) continue;
    if (startFracRaw < -0.05 && endFracRaw < -0.05) continue;

    const startFrac = timeToArcFraction(bubble.startTime, config);
    const endFrac = bubble.endTime
      ? timeToArcFraction(bubble.endTime, config)
      : (isBedtime ? Math.min(1, startFrac + 0.03) : timeToArcFraction(new Date(), config));

    if (Math.abs(endFrac - startFrac) < 0.005 && !isBedtime) continue;

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', `arc-bubble arc-bubble-${bubble.status}${isBedtime ? ' arc-bedtime' : ''}`);

    if (isBedtime) {
      // Bedtime: moon icon on the arc
      const midFrac = startFrac;
      const pt = fracToPoint(midFrac, cx, cy, r);
      const moon = document.createElementNS(ns, 'text');
      moon.setAttribute('x', String(pt.x));
      moon.setAttribute('y', String(pt.y + 1));
      moon.setAttribute('font-size', '20');
      moon.setAttribute('text-anchor', 'middle');
      moon.setAttribute('dominant-baseline', 'middle');
      moon.textContent = '🌙';
      g.appendChild(moon);
    } else {
      // Arc segment for sleep
      const segPath = document.createElementNS(ns, 'path');
      segPath.setAttribute('d', describeArc(cx, cy, r, startFrac, endFrac));
      segPath.setAttribute('fill', 'none');
      segPath.setAttribute('stroke-linecap', 'round');

      const segWidth = trackWidth + 4;

      if (bubble.status === 'completed') {
        segPath.setAttribute('stroke', 'var(--moon)');
        segPath.setAttribute('stroke-width', String(segWidth));
        segPath.setAttribute('opacity', '0.85');
      } else if (bubble.status === 'active') {
        segPath.setAttribute('stroke', 'var(--moon-glow)');
        segPath.setAttribute('stroke-width', String(segWidth + 2));
        segPath.setAttribute('filter', 'url(#arc-glow)');
        segPath.setAttribute('class', 'arc-active-pulse');
      } else {
        segPath.setAttribute('stroke', 'var(--moon)');
        segPath.setAttribute('stroke-width', String(segWidth));
        segPath.setAttribute('stroke-dasharray', '6 4');
        segPath.setAttribute('opacity', '0.4');
      }
      g.appendChild(segPath);

      // Duration label outside the arc for completed/active sleeps
      if (bubble.status === 'completed' && bubble.endTime) {
        const durationMs = bubble.endTime.getTime() - bubble.startTime.getTime();
        if (durationMs > 10 * 60000) { // Only show for > 10min
          const midFrac = (startFrac + endFrac) / 2;
          const labelPt = fracToPoint(midFrac, cx, cy, r + 22);
          const durLabel = document.createElementNS(ns, 'text');
          durLabel.setAttribute('x', String(labelPt.x));
          durLabel.setAttribute('y', String(labelPt.y));
          durLabel.setAttribute('text-anchor', 'middle');
          durLabel.setAttribute('dominant-baseline', 'middle');
          durLabel.setAttribute('class', 'arc-bubble-label');
          durLabel.setAttribute('fill', 'var(--text-light)');
          durLabel.setAttribute('font-size', '9');
          durLabel.textContent = formatDuration(durationMs);
          g.appendChild(durLabel);
        }
      }

      // Time labels for predicted naps (outside arc)
      if (bubble.status === 'predicted') {
        const midFrac = (startFrac + endFrac) / 2;
        const labelPt = fracToPoint(midFrac, cx, cy, r + 22);
        const timeLabel = document.createElementNS(ns, 'text');
        timeLabel.setAttribute('x', String(labelPt.x));
        timeLabel.setAttribute('y', String(labelPt.y));
        timeLabel.setAttribute('text-anchor', 'middle');
        timeLabel.setAttribute('dominant-baseline', 'middle');
        timeLabel.setAttribute('fill', 'var(--text-light)');
        timeLabel.setAttribute('font-size', '9');
        timeLabel.setAttribute('opacity', '0.7');
        timeLabel.textContent = formatTime(bubble.startTime);
        g.appendChild(timeLabel);
      }
    }

    svg.appendChild(g);
  }

  return svg;
}
