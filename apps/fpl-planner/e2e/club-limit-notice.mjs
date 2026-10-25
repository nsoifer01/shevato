// E2E: the notice for a squad over the club limit because a player moved club.
//
// FPL lets a squad stand that a club change put over three from one club, and
// any transfer must bring it back (FINDINGS ledger row 38). The planner plans
// that squad; this suite checks what the manager reads about it on the page.
// Built from the committed in-season sample by moving held players' clubs in
// the bootstrap, which is exactly how a deadline-day transfer reaches FPL's
// payload.
//
//   A. one club over (four)      -> an informational notice with the plan
//   B. the same, on a phone      -> readable, nothing wider than the screen
//   C. two clubs over            -> both clubs listed with their counts
//   D. an ordinary squad         -> no notice, no note
import {
  recorder, waitPlan, evaluate, waitForExpr, errorsOf, payloadsFor, proxyRule, TEAM_ID, APP,
} from './helpers.mjs';
import { closePage, newPage, interceptNetwork, goto, setViewport, screenshot } from '../../../tests/browser/cdp.mjs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, '.screenshots', 'e2e-fpl-club-limit');

/**
 * The in-season sample with `clubs` held clubs pushed to four: for each, held
 * players from other clubs are moved into it. Returns the payloads and, per
 * club, its name and the four players FPL now lists there.
 */
async function overLimitPayloads(clubs) {
  const p = await payloadsFor('inseason', { teamId: TEAM_ID });
  const held = p.picks.picks.map((x) => x.element);
  const byId = new Map(p.bootstrap.elements.map((e) => [e.id, e]));
  const limit = p.bootstrap.game_settings.squad_team_limit;
  const count = () => {
    const n = new Map();
    for (const id of held) n.set(byId.get(id).team, (n.get(byId.get(id).team) || 0) + 1);
    return n;
  };
  const targets = [...count()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, clubs).map(([t]) => t);
  const moved = new Set();
  for (const team of targets) {
    while (count().get(team) <= limit) {
      const mover = held.find((id) => !moved.has(id) && !targets.includes(byId.get(id).team));
      byId.get(mover).team = team;
      moved.add(mover);
    }
  }
  const teamName = new Map(p.bootstrap.teams.map((t) => [t.id, t.name]));
  const over = targets.map((t) => ({ name: teamName.get(t), count: count().get(t), players: held.filter((id) => byId.get(id).team === t).map((id) => byId.get(id).web_name) }));
  return { p, over, limit };
}

// Screenshots after the plan's entrance animations have finished, so a shot
// shows the page as a person sees it rather than mid-fade.
const settled = (s) => waitForExpr(s, `document.getAnimations().every((a) => a.playState !== 'running')`, { timeout: 5000 });

async function openWith(cdpPort, base, p, viewport) {
  const s = await newPage(cdpPort);
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);
  await interceptNetwork(s, proxyRule(p));
  await goto(s, base + APP, { settle: 250 });
  // The proxy cache lives in localStorage per origin and would answer the next
  // state from this one's payloads (free-hit.mjs explains it).
  await evaluate(s, `(()=>{
    for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
    localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(JSON.stringify(String(TEAM_ID)))});
    return 1;
  })()`);
  await goto(s, base + APP, { settle: 900 });
  return s;
}

// What the manager reads: the club-limit notice (found by its title), where it
// sits, the plan's own headline, and the notes under the transfers.
const read = (s) => evaluate(s, `(()=>{
  const banners = [...document.querySelectorAll('.fpl-banner')];
  const b = banners.find((x) => /Your squad holds/.test(x.textContent));
  const r = b ? b.getBoundingClientRect() : null;
  const headline = (document.querySelector('.fpl-hero-headline') || {}).textContent || '';
  return {
    found: !!b,
    title: b ? b.querySelector('.fpl-banner-title').textContent.trim() : null,
    text: b ? b.textContent.replace(/\\s+/g, ' ').trim() : '',
    items: b ? [...b.querySelectorAll('li')].map((li) => li.textContent.trim()) : [],
    info: b ? b.classList.contains('is-info') : false,
    inDetails: b ? !!b.closest('details') : false,
    iconHidden: b ? b.querySelector('.fpl-banner-mark').getAttribute('aria-hidden') === 'true' : false,
    left: r ? r.left : null, right: r ? r.right : null, visible: r ? r.width > 0 && r.height > 0 : false,
    headline: headline.trim(),
    transfers: /Make \\d+ transfers?/.test(headline) || document.querySelectorAll('.fpl-transfer').length > 0,
    notes: [...document.querySelectorAll('.fpl-tr-club-note')].map((n) => n.textContent.trim()),
    // Who each note's own pair sells: the note must sit inside that pair.
    noteSells: [...document.querySelectorAll('.fpl-tr-club-note')].map((n) => {
      const pair = n.closest('.fpl-transfer');
      const out = pair && pair.querySelector('.fpl-tr-side.is-out .fpl-tr-name');
      return out ? out.textContent.trim() : null;
    }),
    // And on screen it sits between that pair's cards and its gain row, so it
    // reads as that pair's, not the next one's (it once sat after the gain row,
    // directly above the next sale).
    noteBetween: [...document.querySelectorAll('.fpl-tr-club-note')].map((n) => {
      const pair = n.closest('.fpl-transfer');
      const cards = [...pair.querySelectorAll('.fpl-tr-side')].map((c) => c.getBoundingClientRect().bottom);
      const gain = pair.querySelector('.fpl-tr-gain').getBoundingClientRect();
      const r = n.getBoundingClientRect();
      return r.top >= Math.max(...cards) - 0.5 && r.bottom <= gain.top + 0.5;
    }),
    dataQuality: [...document.querySelectorAll('.fpl-subhead')].some((h) => /Data quality/.test(h.textContent)
      && /Your squad holds|over the limit/.test(h.parentElement.textContent)),
    scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
  };
})()`);

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  await mkdir(SHOTS, { recursive: true });

  /* ---- A and B. one club at four, desktop then phone ---- */
  const one = await overLimitPayloads(1);
  for (const [label, viewport] of [['A', [1280, 900]], ['B', [390, 844]]]) {
    const s = await openWith(cdpPort, base, one.p, viewport);
    try {
      const ready = await waitPlan(s);
      await rec(`${label} the over-limit squad is planned`, ready, '', s);
      const v = await read(s);
      const club = one.over[0];
      await rec(`${label} an informational notice names the club and its count`,
        v.found && v.info && v.title === `Your squad holds ${club.count} players from ${club.name}`, `${v.title} | info ${v.info}`, s);
      await rec(`${label} it says FPL keeps the squad and the next transfer must restore the limit`,
        /FPL lets you keep it exactly as it is/.test(v.text) && new RegExp(`next transfer has to bring ${club.name} back to ${one.limit}`).test(v.text), v.text.slice(0, 200), s);
      await rec(`${label} it lists the four players`,
        v.items.length === 1 && club.players.every((n) => v.items[0].includes(n)), v.items.join(' | '), s);
      // The banner's account of this plan agrees with the plan the page shows.
      const says = /This plan makes transfers/.test(v.text) ? 'transfers' : /This plan makes no transfer/.test(v.text) ? 'roll' : 'other';
      await rec(`${label} its account of this plan matches the plan shown`,
        (says === 'transfers') === v.transfers && says !== 'other', `banner: ${says}, page transfers: ${v.transfers} (${v.headline})`, s);
      await rec(`${label} a transfer plan marks each required sale, a roll marks none`,
        v.transfers ? v.notes.length >= 1 && v.notes.every((t) => t.startsWith(`Partly required by the club limit: with any transfer, ${club.name} has to come back to ${one.limit}`)) : v.notes.length === 0,
        v.notes.join(' | ') || 'no notes', s);
      await rec(`${label} each note sits in the pair that sells one of the club's players`,
        v.noteSells.length === v.notes.length && v.noteSells.every((n) => club.players.includes(n)) && v.noteBetween.every(Boolean),
        `${v.noteSells.join(', ') || 'no notes'}; between cards and gain: ${v.noteBetween.join(',')}`, s);
      await rec(`${label} it is with the plan, not in Data quality, and its icon is hidden from screen readers`,
        !v.inDetails && !v.dataQuality && v.iconHidden, `inDetails ${v.inDetails} dataQuality ${v.dataQuality} iconHidden ${v.iconHidden}`, s);
      if (label === 'B') {
        await rec('B nothing is wider than the phone, and the notice is on screen',
          v.scrollWidth <= v.innerWidth && v.visible && v.left >= 0 && v.right <= v.innerWidth + 0.5, `scroll ${v.scrollWidth} / ${v.innerWidth}, banner ${v.left}-${v.right}`, s);
      }
      await settled(s);
      await screenshot(s, path.join(SHOTS, `${label}-one-club-${viewport[0]}.png`));
      if (v.notes.length) {
        await evaluate(s, `(document.querySelector('.fpl-tr-club-note').closest('.fpl-transfer').scrollIntoView({ block: 'center' }), 1)`);
        await settled(s);
        await screenshot(s, path.join(SHOTS, `${label}-sale-note-${viewport[0]}.png`));
      }
      const errs = errorsOf(s);
      await rec(`${label} no console errors`, errs.length === 0, errs.slice(0, 2).join(' | '), s);
    } finally {
      await closePage(cdpPort, s);
    }
  }

  /* ---- C. two clubs at four ---- */
  {
    const two = await overLimitPayloads(2);
    const s = await openWith(cdpPort, base, two.p, [1280, 900]);
    try {
      await waitPlan(s);
      const v = await read(s);
      await rec('C two clubs over the limit: one notice, titled for both',
        v.found && v.title === `Your squad holds more than ${two.limit} players from 2 clubs`, v.title, s);
      await rec('C both clubs are listed with their counts',
        v.items.length === 2 && two.over.every((c) => v.items.some((t) => t.startsWith(`${c.name}: ${c.count} players`))), v.items.join(' | '), s);
      await rec('C every one of them has to come back',
        new RegExp(`every one of these clubs back to ${two.limit}`).test(v.text), v.text.slice(0, 200), s);
      await settled(s);
      await screenshot(s, path.join(SHOTS, 'C-two-clubs-1280.png'));
    } finally {
      await closePage(cdpPort, s);
    }
  }

  /* ---- D. an ordinary squad ---- */
  {
    const p = await payloadsFor('inseason', { teamId: TEAM_ID });
    const s = await openWith(cdpPort, base, p, [1280, 900]);
    try {
      const ready = await waitPlan(s);
      const v = await read(s);
      await rec('D an ordinary squad has no club-limit notice and no note', ready && !v.found && v.notes.length === 0,
        `found ${v.found}, notes ${v.notes.length}`, s);
    } finally {
      await closePage(cdpPort, s);
    }
  }
  return R;
}
