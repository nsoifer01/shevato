'use strict';

// Server-side mirror of drawCurve() in js/app.js — emits a complete SVG
// string with the line path, filled area, and per-episode dots so the
// curve renders without any client JS. Keep this in sync with the browser
// version's math so static pages and the SPA agree visually.
function renderCurve(episodes, opts) {
  const { width = 600, height = 200, padX = 6, padY = 10, showDots = true } = opts || {};
  if (!Array.isArray(episodes) || episodes.length === 0) {
    return `<svg class="season-curve" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>`;
  }
  const ratings = episodes.map((e) => e.rating);
  const lo = Math.max(0, Math.min(...ratings) - 0.3);
  const hi = Math.min(10, Math.max(...ratings) + 0.3);
  const span = Math.max(0.1, hi - lo);
  const n = episodes.length;
  const xStep = n > 1 ? (width - padX * 2) / (n - 1) : 0;

  const points = episodes.map((e, i) => {
    const x = padX + (n > 1 ? i * xStep : (width - padX * 2) / 2);
    const y = padY + (1 - (e.rating - lo) / span) * (height - padY * 2);
    return [x, y];
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${linePath} L${last[0].toFixed(1)},${height} L${first[0].toFixed(1)},${height} Z`;

  let dotsSvg = '';
  if (showDots) {
    const r = height > 100 ? 4 : 2.5;
    dotsSvg = points
      .map(([x, y], i) => {
        const ep = episodes[i];
        const namePart = ep.name ? `\n${ep.name}` : '';
        const title = `Ep ${ep.episode}: ${ep.rating.toFixed(1)} · ${ep.votes.toLocaleString()} votes${namePart}`;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"><title>${escapeXml(title)}</title></circle>`;
      })
      .join('');
  }

  return `<svg class="season-curve" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Episode rating trajectory">
  <path class="curve-area" d="${areaPath}"/>
  <path class="curve-line" d="${linePath}"/>
  <g class="curve-dots">${dotsSvg}</g>
</svg>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { renderCurve, escapeXml };
