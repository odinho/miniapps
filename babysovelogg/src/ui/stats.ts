import { el, formatDuration } from './components.js';
import { getStatsData } from '../api.js';
import { getWeekStats, getAverageWakeWindow, type SleepEntry, type WeekStats } from '../engine/stats.js';

function svgEl(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short' });
}

function renderBarChart(weekStats: WeekStats): SVGElement {
  const W = 320, H = 180, PAD_L = 36, PAD_B = 28, PAD_T = 12, PAD_R = 8;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const days = weekStats.days.slice(-7);
  if (days.length === 0) {
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
    const t = svgEl('text', { x: String(W / 2), y: String(H / 2), 'text-anchor': 'middle', fill: 'var(--text-light)', 'font-size': '14' });
    t.textContent = 'No data yet';
    svg.appendChild(t);
    return svg;
  }

  const maxMin = Math.max(60, ...days.map(d => d.stats.totalNapMinutes + d.stats.totalNightMinutes));
  const barW = Math.min(36, (chartW / days.length) * 0.7);
  const gap = chartW / days.length;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'stats-chart' });

  // Y-axis labels
  for (let i = 0; i <= 4; i++) {
    const mins = Math.round((maxMin / 4) * i);
    const y = PAD_T + chartH - (chartH * mins / maxMin);
    const line = svgEl('line', { x1: String(PAD_L), x2: String(W - PAD_R), y1: String(y), y2: String(y), stroke: 'var(--cream-dark)', 'stroke-width': '1' });
    svg.appendChild(line);
    if (i > 0) {
      const label = svgEl('text', { x: String(PAD_L - 4), y: String(y + 4), 'text-anchor': 'end', fill: 'var(--text-light)', 'font-size': '10', 'font-family': 'var(--font)' });
      label.textContent = `${Math.round(mins / 60)}h`;
      svg.appendChild(label);
    }
  }

  // Bars
  days.forEach((day, i) => {
    const x = PAD_L + gap * i + (gap - barW) / 2;
    const napH = (day.stats.totalNapMinutes / maxMin) * chartH;
    const nightH = (day.stats.totalNightMinutes / maxMin) * chartH;
    const totalH = napH + nightH;
    const baseY = PAD_T + chartH;

    // Night bar (bottom)
    if (nightH > 0) {
      svg.appendChild(svgEl('rect', {
        x: String(x), y: String(baseY - totalH), width: String(barW), height: String(nightH),
        rx: '4', fill: 'var(--moon)'
      }));
    }
    // Nap bar (top of night)
    if (napH > 0) {
      svg.appendChild(svgEl('rect', {
        x: String(x), y: String(baseY - napH), width: String(barW), height: String(napH),
        rx: '4', fill: 'var(--peach-dark)'
      }));
    }

    // Day label
    const label = svgEl('text', {
      x: String(x + barW / 2), y: String(H - 6),
      'text-anchor': 'middle', fill: 'var(--text-light)', 'font-size': '10', 'font-family': 'var(--font)'
    });
    label.textContent = dayLabel(day.date);
    svg.appendChild(label);
  });

  return svg;
}

function statCard(value: string, label: string): HTMLElement {
  return el('div', { className: 'stats-card' }, [
    el('div', { className: 'stat-value' }, [value]),
    el('div', { className: 'stat-label' }, [label]),
  ]);
}

function section(title: string, children: (HTMLElement | SVGElement)[]): HTMLElement {
  const div = el('div', { className: 'stats-section' });
  div.appendChild(el('h3', { className: 'stats-section-title' }, [title]));
  for (const c of children) div.appendChild(c as any);
  return div;
}

export async function renderStats(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const view = el('div', { className: 'view stats-view' });
  container.appendChild(view);

  view.appendChild(el('h1', { className: 'history-header' }, ['📊 Statistics']));

  // Loading
  const loading = el('div', { className: 'history-empty' }, ['Loading...']);
  view.appendChild(loading);

  let sleeps: SleepEntry[];
  try {
    sleeps = await getStatsData();
  } catch {
    loading.textContent = 'Could not load stats';
    return;
  }
  view.removeChild(loading);

  if (sleeps.length === 0) {
    view.appendChild(el('div', { className: 'history-empty' }, ['No sleep data yet. Start tracking to see statistics!']));
    return;
  }

  const mapped: SleepEntry[] = sleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type }));
  const week7 = mapped.filter(s => new Date(s.start_time).getTime() > Date.now() - 7 * 86400000);
  const weekStats = getWeekStats(week7);
  const allStats = getWeekStats(mapped);

  // 1. Weekly bar chart
  const chartContainer = el('div', { className: 'stats-chart-wrap' });
  chartContainer.appendChild(renderBarChart(weekStats) as any);
  // Legend
  const legend = el('div', { className: 'stats-legend' }, [
    el('span', { className: 'stats-legend-item' }, [
      el('span', { className: 'stats-dot', style: { background: 'var(--peach-dark)' } }),
      ' Naps'
    ]),
    el('span', { className: 'stats-legend-item' }, [
      el('span', { className: 'stats-dot', style: { background: 'var(--moon)' } }),
      ' Night'
    ]),
  ]);
  chartContainer.appendChild(legend);
  view.appendChild(section('Last 7 Days', [chartContainer]));

  // 2. Wake windows
  const wakeAvg = getAverageWakeWindow(week7);
  view.appendChild(section('Wake Windows', [
    el('div', { className: 'stats-row' }, [
      statCard(wakeAvg ? formatDuration(wakeAvg * 60000) : '—', 'Avg Wake Window'),
    ]),
  ]));

  // 3. Sleep trends — 7d vs 30d
  const avgTotalSleep7 = weekStats.avgNapMinutesPerDay + weekStats.avgNightMinutesPerDay;
  const avgTotalSleep30 = allStats.avgNapMinutesPerDay + allStats.avgNightMinutesPerDay;

  view.appendChild(section('Sleep Trends', [
    el('div', { className: 'stats-trends-table' }, [
      trendRow('', '7 days', '30 days'),
      trendRow('Total sleep/day', formatDuration(avgTotalSleep7 * 60000), formatDuration(avgTotalSleep30 * 60000)),
      trendRow('Avg nap duration', formatDuration(weekStats.avgNapMinutesPerDay * 60000 / Math.max(1, weekStats.avgNapsPerDay)), formatDuration(allStats.avgNapMinutesPerDay * 60000 / Math.max(1, allStats.avgNapsPerDay))),
      trendRow('Naps/day', String(weekStats.avgNapsPerDay), String(allStats.avgNapsPerDay)),
      trendRow('Night sleep', formatDuration(weekStats.avgNightMinutesPerDay * 60000), formatDuration(allStats.avgNightMinutesPerDay * 60000)),
    ]),
  ]));

  // 4. Best/worst days
  const daysWithTotal = weekStats.days.map(d => ({
    date: d.date,
    total: d.stats.totalNapMinutes + d.stats.totalNightMinutes
  })).filter(d => d.total > 0);

  if (daysWithTotal.length >= 2) {
    daysWithTotal.sort((a, b) => b.total - a.total);
    const best = daysWithTotal[0];
    const worst = daysWithTotal[daysWithTotal.length - 1];
    const fmtDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    view.appendChild(section('Best & Worst', [
      el('div', { className: 'stats-row' }, [
        statCard(`${fmtDate(best.date)}`, `Most sleep: ${formatDuration(best.total * 60000)}`),
        statCard(`${fmtDate(worst.date)}`, `Least sleep: ${formatDuration(worst.total * 60000)}`),
      ]),
    ]));
  }
}

function trendRow(label: string, val7: string, val30: string): HTMLElement {
  const isHeader = label === '';
  const cls = isHeader ? 'stats-trend-row stats-trend-header' : 'stats-trend-row';
  return el('div', { className: cls }, [
    el('div', { className: 'stats-trend-label' }, [label || '']),
    el('div', { className: 'stats-trend-val' }, [isHeader ? '7 days' : val7]),
    el('div', { className: 'stats-trend-val' }, [isHeader ? '30 days' : val30]),
  ]);
}
