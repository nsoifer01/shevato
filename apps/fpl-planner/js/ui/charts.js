// Small chart components: a column chart, a trend line and a sparkline.
//
// Presentation only. Every figure a chart shows also exists as text nearby (the
// table under the history charts, the per-gameweek columns under the horizon
// chart, the value chips beside a drawer sparkline), so a chart is never the
// only way to read a number. Built as HTML + inline SVG so there is nothing to
// bundle and nothing to fetch.
//
// Marks follow one spec across all three: single accent hue for a single
// series, thin marks with rounded data-ends, hairline solid gridlines, values
// in text tokens rather than the series colour, and a hover/focus tooltip on
// every mark with the mark itself as the hit target.

import { el } from './dom.js';

// 1,234,567 -> "1.2M"; 45,300 -> "45.3k". Axis ticks and rank labels only:
// tables keep full locale numbers.
export function compactNumber(value) {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

// Clean axis bounds: 0-based for magnitudes, padded min..max for trends.
function bounds(values, { zeroBased = true } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (zeroBased) min = Math.min(0, min);
  if (min === max) { max = min + 1; }
  if (!zeroBased) {
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function tooltip(lines) {
  return el('span', { class: 'fpl-tip', role: 'presentation' },
    lines.filter(Boolean).map((line, i) => el('span', { class: i === 0 ? 'fpl-tip-t' : 'fpl-tip-b', text: line })));
}

/* ------------------------------------------------------------ column chart */

// points: [{ label, value, note?, active?, muted? }]
// Values are magnitudes, so columns grow from a shared zero baseline. Caps are
// labelled when there is room for all of them; on dense charts only the peak
// and the newest column carry a label and the tooltip holds the rest.
export function columnChart({
  points,
  formatValue = (v) => String(v),
  ariaLabel = 'Column chart',
  labelCaps = 'auto', // 'auto' | 'all' | 'sparse'
} = {}) {
  const values = points.map(p => p.value);
  const { max } = bounds(values);
  const dense = labelCaps === 'sparse' || (labelCaps === 'auto' && points.length > 10);
  const peak = Math.max(...values.filter(Number.isFinite));
  const lastIdx = points.length - 1;

  const cols = points.map((p, i) => {
    const h = Number.isFinite(p.value) && max > 0 ? Math.max(1.5, (p.value / max) * 100) : 0;
    const showCap = !dense || p.value === peak || i === lastIdx || p.active;
    return el('div', {
      class: `fpl-col ${p.active ? 'is-active' : ''} ${p.muted ? 'is-muted' : ''}`.trim(),
      tabindex: '0',
      role: 'img',
      'aria-label': `${p.label}: ${formatValue(p.value)}${p.note ? `. ${p.note}` : ''}`,
    }, [
      tooltip([`${p.label} · ${formatValue(p.value)}`, p.note]),
      showCap ? el('span', { class: 'fpl-col-cap', text: formatValue(p.value) }) : null,
      el('div', { class: 'fpl-col-track' }, el('div', { class: 'fpl-col-fill', style: `height:${h}%` })),
      el('span', { class: `fpl-col-x ${dense && !(i === 0 || i === lastIdx || p.value === peak || p.active) ? 'is-quiet' : ''}`.trim(), text: p.label }),
    ]);
  });

  return el('div', { class: `fpl-chart fpl-chart-cols ${dense ? 'is-dense' : ''}`.trim(), role: 'group', 'aria-label': ariaLabel }, cols);
}

/* -------------------------------------------------------------- trend line */

// points: [{ label, value, tooltip? }]. `invert` flips the y axis for series
// where DOWN is the good direction (overall rank).
export function trendChart({
  points,
  invert = false,
  formatValue = (v) => String(v),
  formatTick = compactNumber,
  ariaLabel = 'Trend chart',
  endLabel = true,
} = {}) {
  const values = points.map(p => p.value);
  const { min, max } = bounds(values, { zeroBased: false });
  const span = max - min || 1;
  // y as a percentage from the top of the plot.
  const yPct = (v) => {
    const t = (v - min) / span;
    const up = invert ? t : 1 - t;
    return up * 100;
  };
  const xPct = (i) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xPct(i)} ${yPct(p.value)}`)
    .join(' ');
  const area = `${path} L 100 100 L 0 100 Z`;

  const svg = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path class="fpl-line-area" d="${area}"></path>
      <path class="fpl-line-path" d="${path}" vector-effect="non-scaling-stroke"></path>
    </svg>`;

  // Three hairline gridlines with the tick values they stand for. The middle
  // tick is the midpoint of the scale, which is honest even on an inverted axis.
  const gridValues = invert ? [min, (min + max) / 2, max] : [max, (min + max) / 2, min];
  const grid = el('div', { class: 'fpl-line-grid', 'aria-hidden': 'true' }, gridValues.map(v => el('div', { class: 'fpl-line-gridrow' }, [
    el('span', { class: 'fpl-line-tick', text: formatTick(v) }),
  ])));

  const dots = points.map((p, i) => el('button', {
    type: 'button',
    class: `fpl-dot-hit ${i === points.length - 1 ? 'is-end' : ''}`.trim(),
    style: `left:${xPct(i)}%;top:${yPct(p.value)}%`,
    'aria-label': `${p.label}: ${formatValue(p.value)}`,
  }, [
    el('span', { class: 'fpl-dot', 'aria-hidden': 'true' }),
    tooltip([`${p.label} · ${formatValue(p.value)}`, p.tooltip]),
  ]));

  const last = points[points.length - 1];
  const xLabels = el('div', { class: 'fpl-line-x', 'aria-hidden': 'true' }, [
    el('span', { text: points[0] ? points[0].label : '' }),
    el('span', { text: last ? last.label : '' }),
  ]);

  return el('div', { class: 'fpl-chart fpl-chart-line', role: 'group', 'aria-label': ariaLabel }, [
    el('div', { class: 'fpl-line-plot' }, [
      grid,
      el('div', { class: 'fpl-line-svg', html: svg }),
      ...dots,
      endLabel && last ? el('span', {
        class: 'fpl-line-endlabel',
        style: `top:${yPct(last.value)}%`,
        text: formatValue(last.value),
      }) : null,
    ]),
    xLabels,
  ]);
}

/* --------------------------------------------------------------- sparkline */

// A bare trend for inside a tile or drawer: the line, a dot on the newest
// point, no axes. The values themselves are printed beside it by the caller.
export function sparkline({ values, height = 36 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const { min, max } = bounds(values, { zeroBased: false });
  const span = max - min || 1;
  const y = (v) => (1 - (v - min) / span) * 100;
  const x = (i) => (i / (values.length - 1)) * 100;
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
  const svg = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path class="fpl-line-path" d="${path}" vector-effect="non-scaling-stroke"></path>
    </svg>`;
  const last = values[values.length - 1];
  return el('span', { class: 'fpl-spark', style: `height:${height}px`, 'aria-hidden': 'true' }, [
    el('span', { class: 'fpl-line-svg', html: svg }),
    el('span', { class: 'fpl-dot is-static', style: `left:${x(values.length - 1)}%;top:${y(last)}%` }),
  ]);
}
