// Small shared pieces used by more than one view: banners, the positive
// "no action needed" statement, the sample-data label, the freshness line and
// the staged loading screen.
//
// They live together because each is a handful of nodes and splitting them into
// files would cost more attention than it saves.

import { el } from './dom.js';
import { PROGRESS_STAGES } from '../engine/planner.js';

export function btn(label, onClick, { variant = '', size = '', title = null, disabled = false, dataset = null } = {}) {
  return el('button', {
    type: 'button',
    class: ['fpl-btn', variant, size].filter(Boolean).join(' '),
    onclick: onClick,
    title,
    disabled,
    dataset,
  }, label);
}

// Every surface that shows sample numbers carries this, so a screenshot of any
// part of the app is self-labelling.
export function sampleTag() {
  return el('span', { class: 'fpl-tag-sample', text: 'Sample data' });
}

export function sampleBanner() {
  return el('div', { class: 'fpl-sample-banner' }, [
    sampleTag(),
    el('span', {}, [
      el('strong', { text: 'You are looking at sample data.' }),
      ' Not a real Fantasy Premier League team, and never a stand-in for live data. Remove ',
      el('code', { text: '?demo=1' }),
      ' to plan your own team.',
    ]),
  ]);
}

// Tone decides the icon: callers still pass a text `mark` as the fallback for
// the odd tone (the plan-change card passes its own), but the three standard
// tones always render the same recognisable symbol.
const BANNER_ICONS = {
  info: 'fa-circle-info',
  warn: 'fa-triangle-exclamation',
  error: 'fa-circle-exclamation',
};

export function banner({ tone = 'info', mark = 'i', title, text = null, list = null, actions = null }) {
  const icon = BANNER_ICONS[tone];
  return el('div', { class: `fpl-banner is-${tone}` }, [
    icon
      ? el('div', { class: 'fpl-banner-mark', 'aria-hidden': 'true' }, el('i', { class: `fa-solid ${icon}` }))
      : el('div', { class: 'fpl-banner-mark', text: mark }),
    el('div', { class: 'fpl-banner-body' }, [
      el('div', { class: 'fpl-banner-title', text: title }),
      text ? el('div', { class: 'fpl-banner-text' }, text) : null,
      list && list.length
        // A list entry may be a plain string or `{ text, title }`, so a banner
        // can show a sentence a person reads while keeping the technical detail
        // reachable on hover and in the accessibility tree.
        ? el('ul', { class: 'fpl-missing' }, list.map(item => (typeof item === 'string'
          ? el('li', { text: item })
          : el('li', { text: item.text, title: item.title || null }))))
        : null,
      actions && actions.length ? el('div', { class: 'fpl-banner-actions' }, actions) : null,
    ]),
  ]);
}

// A recommendation to do nothing is still a recommendation. This is what keeps
// "Roll your transfer" and "Do not use a chip" from reading like empty states.
export function affirm({ mark = '✓', title, body, tone = '' }) {
  const icon = mark === '✓' ? 'fa-check' : mark === '★' ? 'fa-star' : null;
  return el('div', { class: `fpl-affirm ${tone}`.trim() }, [
    icon
      ? el('div', { class: 'fpl-affirm-mark', 'aria-hidden': 'true' }, el('i', { class: `fa-solid ${icon}` }))
      : el('div', { class: 'fpl-affirm-mark', text: mark }),
    el('div', {}, [
      el('div', { class: 'fpl-affirm-title', text: title }),
      body ? el('div', { class: 'fpl-affirm-body' }, body) : null,
    ]),
  ]);
}

// The confidence band, which never renders without the sentence that earned it.
// `bare` drops the tinted panel for surfaces that are already inside one.
export function confidenceStrip(assessment, { bare = false } = {}) {
  if (!assessment) return null;
  const sentence = `${assessment.because.charAt(0).toUpperCase()}${assessment.because.slice(1)}.`;
  return el('div', { class: `fpl-conf is-${assessment.band} ${bare ? 'is-bare' : ''}`.trim() }, [
    el('span', { class: 'fpl-conf-pill', text: assessment.label }),
    el('span', { class: 'fpl-conf-why', text: sentence }),
  ]);
}

// What changed since the last plan, and why. The previous recommendation is
// restated in full rather than implied, because "it changed" without "from
// what" is the version of this message that helps nobody.
export function planChangeCard(change) {
  if (!change) return null;

  if (!change.changed) {
    return el('div', { class: 'fpl-unchanged' }, [
      el('span', { class: 'fpl-unchanged-mark', text: '✓' }),
      el('span', {}, [
        el('b', { text: 'Plan unchanged.' }),
        ` ${change.why}`,
      ]),
    ]);
  }

  return el('div', { class: 'fpl-banner is-info fpl-change' }, [
    el('div', { class: 'fpl-banner-mark', text: '↻' }),
    el('div', { class: 'fpl-banner-body' }, [
      el('div', { class: 'fpl-banner-title', text: change.headline }),
      el('dl', { class: 'fpl-change-rows' }, [
        el('dt', { text: 'Previously' }),
        el('dd', { class: 'is-prev', text: change.previousLine || 'No earlier plan' }),
        el('dt', { text: 'Now' }),
        el('dd', { class: 'is-now', text: change.currentLine || '-' }),
        el('dt', { text: 'Why' }),
        el('dd', { text: change.why }),
      ]),
    ]),
  ]);
}

export function freshness(items) {
  return el('div', { class: 'fpl-freshness' }, items.filter(Boolean).map(([label, value]) => el('span', {}, [
    `${label} `,
    el('b', { text: value }),
  ])));
}

// `wide` spans the value across the whole grid (for one long sentence in a
// grid of short facts); `muted` renders it as secondary prose rather than a
// bold value.
export function kv(label, value, { wide = false, muted = false } = {}) {
  const cls = [wide ? 'fpl-kv-wide' : '', muted ? 'fpl-kv-muted' : ''].filter(Boolean).join(' ');
  return el('div', { class: cls || null }, [
    el('div', { class: 'fpl-kv-k', text: label }),
    el('div', { class: 'fpl-kv-v', text: value }),
  ]);
}

// Display-only emphasis: wraps the numeric facts inside an engine-written
// sentence (money, points, formations, gameweeks, percentages) so they can be
// found at a glance. The text itself is never altered - every character of
// the input is emitted exactly once, some inside an emphasis span.
const EM_PATTERN = /(£\d+(?:\.\d+)?m?|\b\d+(?:\.\d+)?\s?(?:xP|points?|pts)\b|\b\d-\d-\d\b|\b(?:GW|Gameweek)\s?\d+\b|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\b)/g;

export function emphasize(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(EM_PATTERN)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(el('strong', { class: 'fpl-em', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

// The staged loading screen. The stages are the planner's own
// (PROGRESS_STAGES), in the planner's own order, so the screen is reporting
// real progress rather than animating a guess.
export function progressView({ activeKey = null, done = [], title = 'Building your gameweek plan', sub = '' } = {}) {
  const activeIndex = PROGRESS_STAGES.findIndex(s => s.key === activeKey);
  const pct = activeIndex >= 0 ? PROGRESS_STAGES[activeIndex].pct : 0;

  return el('div', { class: 'fpl-progress' }, [
    el('div', { class: 'fpl-progress-title', text: title }),
    sub ? el('div', { class: 'fpl-progress-sub', text: sub }) : null,
    el('div', { class: 'fpl-bar' }, el('div', { class: 'fpl-bar-fill', style: `width:${Math.round(pct * 100)}%` })),
    el('ul', { class: 'fpl-stages' }, PROGRESS_STAGES.map((stage, i) => {
      const isDone = done.includes(stage.key) || (activeIndex >= 0 && i < activeIndex);
      const isActive = stage.key === activeKey;
      return el('li', { class: `fpl-stage ${isDone ? 'is-done' : ''} ${isActive ? 'is-active' : ''}`.trim() }, [
        el('span', { class: 'fpl-stage-dot', text: isDone ? '✓' : String(i + 1) }),
        el('span', { text: stage.label }),
      ]);
    })),
  ]);
}
