/**
 * Accessible equivalents for canvas charts.
 *
 * THE PROBLEM (2026-09-05 audit F16): a <canvas> is a picture. Chart.js is
 * given labels, datasets and tooltip callbacks, and it draws them - none of
 * which reaches the accessibility tree. An axe pass over these pages was
 * clean, because axe checks the markup that IS there; it cannot notice that
 * the only route to a plotted value is hovering a point with a mouse. The
 * headings above the charts name them ("Score over time") without conveying
 * a single number.
 *
 * THE RULE THIS ENFORCES: the text and the table are built from the SAME
 * series object that was handed to Chart.js, in the same call. There is no
 * second copy of the numbers to drift when a filter changes, because there is
 * no second copy at all.
 *
 * What a chart gets:
 *   - role="img" plus an aria-label naming it and stating its shape, so a
 *     screen reader announces something useful instead of "canvas";
 *   - a visible one-line trend summary;
 *   - a <details> holding the full series as a real table. Collapsed by
 *     default, so sighted users are not handed a duplicate of every chart,
 *     and reachable by keyboard because <details><summary> already is.
 *
 * Deliberately NOT done: duplicating history tables that already exist
 * elsewhere on the page in accessible form. This is for values that exist
 * ONLY inside the picture.
 *
 * UMD-ish: attaches to window.ChartA11y, and exports for node:test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartA11y = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Numbers only, in order, from a Chart.js dataset's `data`. */
  function numeric(data) {
    return (Array.isArray(data) ? data : [])
      .map(function (v) {
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object' && typeof v.y === 'number') return v.y;
        return null;
      });
  }

  function round(n) {
    if (!Number.isFinite(n)) return null;
    return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  }

  /**
   * One sentence about a series: where it started, where it ended, which way
   * it went, and its range. This is the part a hover tooltip can never give
   * somebody who is not hovering.
   *
   * @param {string} label
   * @param {Array<number|null>} values
   * @returns {string}
   */
  function summariseSeries(label, values) {
    var present = values.filter(function (v) { return Number.isFinite(v); });
    if (!present.length) return label + ': no data';
    if (present.length === 1) return label + ': ' + round(present[0]);
    var first = present[0];
    var last = present[present.length - 1];
    var delta = last - first;
    var direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'level';
    var min = Math.min.apply(null, present);
    var max = Math.max.apply(null, present);
    var avg = present.reduce(function (a, v) { return a + v; }, 0) / present.length;
    return label + ': ' + round(first) + ' to ' + round(last)
      + ' (' + direction + (delta ? ' ' + round(Math.abs(delta)) : '') + ')'
      + ', low ' + round(min) + ', high ' + round(max)
      + ', average ' + round(avg);
  }

  /**
   * The whole accessible description of a chart, derived from a Chart.js
   * configuration object.
   *
   * @param {object} config a Chart.js config ({ data: { labels, datasets } })
   * @param {{title: string, axis?: string}} meta
   * @returns {{label: string, summary: string, columns: string[], rows: Array}}
   */
  function describeConfig(config, meta) {
    var data = (config && config.data) || {};
    var labels = Array.isArray(data.labels) ? data.labels : [];
    var datasets = (Array.isArray(data.datasets) ? data.datasets : [])
      .filter(function (d) { return d && d.data; });
    var series = datasets.map(function (d, i) {
      return { name: String(d.label || ('Series ' + (i + 1))), values: numeric(d.data) };
    });

    var pointCount = labels.length
      || series.reduce(function (a, s) { return Math.max(a, s.values.length); }, 0);
    var sentences = series.map(function (s) { return summariseSeries(s.name, s.values); });
    var summary = sentences.join('. ') + (sentences.length ? '.' : '');

    return {
      label: meta.title + ': ' + (series.length === 1 ? 'chart' : series.length + '-series chart')
        + ' of ' + pointCount + ' point' + (pointCount === 1 ? '' : 's')
        + '. ' + summary,
      summary: summary,
      columns: [meta.axis || 'Point'].concat(series.map(function (s) { return s.name; })),
      rows: Array.from({ length: pointCount }, function (_, i) {
        return [labels[i] === undefined ? String(i + 1) : String(labels[i])]
          .concat(series.map(function (s) {
            var v = s.values[i];
            return Number.isFinite(v) ? String(round(v)) : '';
          }));
      }),
    };
  }

  /**
   * Attach (or refresh) the accessible equivalent of `canvas`.
   *
   * Idempotent: called again after a filter change it REPLACES what it wrote,
   * so the table and the picture cannot disagree.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {object} config the same Chart.js config the chart was built from
   * @param {{title: string, axis?: string}} meta
   */
  function attach(canvas, config, meta) {
    if (!canvas || typeof document === 'undefined') return null;
    var described = describeConfig(config, meta);

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', described.label);

    var host = canvas.parentElement;
    if (!host) return described;
    var id = canvas.id || ('chart-' + Math.random().toString(36).slice(2, 8));
    canvas.id = id;

    var wrap = host.parentElement || host;
    var existing = wrap.querySelector('[data-chart-a11y="' + id + '"]');
    if (existing) existing.remove();

    var details = document.createElement('details');
    details.className = 'chart-a11y';
    details.setAttribute('data-chart-a11y', id);

    var summaryEl = document.createElement('summary');
    summaryEl.textContent = 'Chart data (' + described.rows.length + ' row'
      + (described.rows.length === 1 ? '' : 's') + ')';
    details.appendChild(summaryEl);

    var trend = document.createElement('p');
    trend.className = 'chart-a11y-trend';
    trend.textContent = described.summary;
    details.appendChild(trend);

    var table = document.createElement('table');
    table.className = 'chart-a11y-table';
    var caption = document.createElement('caption');
    caption.textContent = meta.title;
    table.appendChild(caption);

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    described.columns.forEach(function (c) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    described.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (cell, i) {
        var el = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) el.scope = 'row';
        el.textContent = cell;
        tr.appendChild(el);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    details.appendChild(table);

    wrap.appendChild(details);
    return described;
  }

  return { attach: attach, describeConfig: describeConfig, summariseSeries: summariseSeries };
}));
