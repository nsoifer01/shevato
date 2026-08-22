// E2E: the gameweek lifecycle boundaries.
//
// These are the states the audit found the app could not survive, and none of
// them is reachable from `?demo=1`: they need a payload standing at a specific
// point in the season and, for the deadline, a clock on the other side of it.
// The suite serves both by intercepting the proxy and shifting the page's Date.
import { closePage } from '../../../tests/browser/cdp.mjs';
import {
  recorder, openPlanner, heroRead, activeView, waitPlan, waitForExpr, evaluate,
  sleep, errorsOf, clickText, payloadsFor, proxyRule, TEAM_ID,
} from './helpers.mjs';
import { interceptNetwork, setViewport, goto, newPage } from '../../../tests/browser/cdp.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);

  /* ------------------------------------------------- 1. deadline in the future */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason' });
    try {
      const hero = await heroRead(s);
      await rec('before the deadline the hero counts down to it',
        /Deadline in/.test(hero.deadline || ''), hero.deadline, s);
      await rec('and says "Deadline passed" nowhere',
        !/Deadline passed/i.test(hero.deadline || ''), hero.deadline, s);
      await rec('the plan is presented as actionable', !hero.outdated, hero.banners.join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------- 2. the deadline crosses while open */
  {
    // Deadline four minutes out, then the page clock jumps past it. The app's
    // own 30 second ticker is what has to notice.
    const s = await openPlanner(cdpPort, base, { state: 'deadline-soon', waitFor: 'plan' });
    try {
      let hero = await heroRead(s);
      await rec('a deadline minutes away is counted in minutes',
        /Deadline in/.test(hero.deadline || ''), hero.deadline, s);

      // Move the page clock past the deadline and let the ticker fire.
      await evaluate(s, `(()=>{
        const RD = window.__realDate || Date;
        window.__realDate = RD;
        const SHIFT = 10 * 60 * 1000;
        const P = new Proxy(RD, {
          construct: (t, a) => (a.length ? new t(...a) : new t(t.now() + SHIFT)),
          get: (t, k) => (k === 'now' ? () => RD.now() + SHIFT : t[k]),
        });
        window.Date = P;
        return 1;
      })()`);

      const reacted = await waitForExpr(s,
        `/Deadline passed/i.test(document.body.textContent) || /deadline/i.test((document.querySelector('.fpl-banner')||{}).textContent||'')`,
        { timeout: 45000 });
      hero = await heroRead(s);
      await rec('the app notices the deadline going by', reacted, hero.deadline, s);

      // Exactly once: zero means the hero never worded the crossing, and two is
      // the guarded defect itself ("Deadline passed Deadline passed", from the
      // prefix and countdown() both writing it). `<= 1` passed at zero and could
      // not catch a hero that said nothing.
      const passedCount = (hero.deadline || '').match(/Deadline passed/gi) || [];
      await rec('and says so exactly once', passedCount.length === 1,
        `"${hero.deadline}" contains it ${passedCount.length} times`, s);

      await rec('the plan is no longer presented as actionable',
        hero.outdated || /no longer be acted on|Plan outdated/i.test(hero.banners.join(' ')),
        hero.banners.join(' | ').slice(0, 160), s);

      const errs = errorsOf(s);
      await rec('no console errors across the crossing', errs.length === 0, errs.slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------- 3. a tab that slept through the deadline */
  {
    const s = await openPlanner(cdpPort, base, { state: 'deadline-soon', waitFor: 'plan' });
    try {
      // Hide the tab (the ticker deliberately does nothing while hidden), move
      // the clock past the deadline, then come back.
      await s.send('Emulation.setPageVisibilityOverride', { visible: false }).catch(() => {});
      await evaluate(s, `(()=>{ Object.defineProperty(document,'hidden',{value:true,configurable:true});
        document.dispatchEvent(new Event('visibilitychange')); return 1 })()`);
      await evaluate(s, `(()=>{
        const RD = window.__realDate || Date; window.__realDate = RD;
        const SHIFT = 20 * 60 * 1000;
        window.Date = new Proxy(RD, {
          construct: (t,a)=> a.length? new t(...a) : new t(t.now()+SHIFT),
          get: (t,k)=> k==='now' ? ()=>RD.now()+SHIFT : t[k],
        });
        return 1 })()`);
      await sleep(400);
      // Return to the tab.
      await evaluate(s, `(()=>{ Object.defineProperty(document,'hidden',{value:false,configurable:true});
        document.dispatchEvent(new Event('visibilitychange')); return 1 })()`);

      const reacted = await waitForExpr(s,
        `/Deadline passed/i.test(document.body.textContent) || /no longer be acted on/i.test(document.body.textContent)`,
        { timeout: 30000 });
      const hero = await heroRead(s);
      await rec('coming back to a tab that slept through the deadline updates it',
        reacted, hero.deadline, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------- 4. pre-season becomes in-season on a live check */
  {
    // Boot pre-season, then swap the payloads underneath for a started season
    // and press the app's own "Check for changes".
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900, false);
      const pre = await payloadsFor('preseason', { teamId: TEAM_ID });
      const started = await payloadsFor('gw1-locked', { teamId: TEAM_ID });
      let live = pre;
      await interceptNetwork(s, (url, req) => proxyRule(live)(url, req));
      await goto(s, base + '/apps/fpl-planner/', { settle: 250 });
      // Clear this app's keys first. A squad saved by an earlier block in the
      // same browser profile would be restored on boot (which is the point of
      // that feature) and this block is about the intro.
      await evaluate(s, `(()=>{
        for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
        localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
        return 1;
      })()`);
      await goto(s, base + '/apps/fpl-planner/', { settle: 500 });

      const onIntro = await waitForExpr(s, `/season has not started/i.test(document.body.textContent)`, { timeout: 30000 });
      await rec('pre-season explains there is no squad to import', onIntro, '', s);

      await clickText(s, 'Build the optimal 15', { settle: 600 });
      await waitPlan(s);
      await rec('a pre-season plan can still be built', (await evaluate(s, `document.querySelectorAll('.fpl-pp-meta').length`)) >= 15, '', s);

      // The season starts underneath the open tab.
      live = started;
      await clickText(s, 'Check for changes', { settle: 800 });
      const routed = await waitForExpr(s,
        `!/season has not started/i.test(document.body.textContent) && document.querySelectorAll('.fpl-pp-meta').length >= 15`,
        { timeout: 60000 });
      await rec('checking for changes discovers the season has started and re-routes',
        routed, (await heroRead(s)).gw || '', s);

      const view = await activeView(s);
      await rec('and the in-season squad views are offered',
        view !== null, `active view: ${view}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------- 5. "Check for changes" records that it ran, always */
  {
    const s = await openPlanner(cdpPort, base, { state: 'preseason', waitFor: 'intro' });
    try {
      await clickText(s, 'Build the optimal 15', { settle: 600 });
      await waitPlan(s);
      const before = await evaluate(s, `/Checked for changes/i.test(document.body.textContent)`);
      await clickText(s, 'Check for changes', { settle: 1200 });
      const after = await evaluate(s, `/Checked for changes/i.test(document.body.textContent)`);
      // The receipt must APPEAR because of the click: present after and absent
      // before. The old expression (`after && !before === false ? after : after`)
      // reduced to `after` whatever `before` said.
      await rec('a pre-season "Check for changes" reports that it ran',
        after && !before, `before=${before} after=${after}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------ 6. a real transfer made between the gameweeks --------- */
  {
    // `gw2-window` freezes GW1's picks exactly as FPL serves them and puts the
    // move on the transfers endpoint alone, which is the shape the planner has
    // to reconcile.
    const s = await openPlanner(cdpPort, base, { state: 'gw2-window' });
    try {
      const t = s.payloads.madeTransfer;
      // Switch to the "Current team" view; the evaluate is for its click side
      // effect only.
      await evaluate(s, `(()=>{
        const seg=[...document.querySelectorAll('.fpl-card-tools .fpl-seg > button')].find(b=>/Current team/.test(b.textContent));
        if (seg) seg.click();
        return 1;
      })()`);
      await sleep(500);
      const squad = await evaluate(s, `[...document.querySelectorAll('.fpl-pp-name')].map(e=>e.textContent.trim())`);

      // Read the two player names out of the payload the suite served.
      const outLabel = s.payloads.bootstrap.elements.find(e => e.id === t.outId).web_name;
      const inLabel = s.payloads.bootstrap.elements.find(e => e.id === t.inId).web_name;

      await rec('the squad shows the player who was bought',
        squad.includes(inLabel), `${inLabel} in [${squad.slice(0, 6).join(', ')}...]`, s);
      await rec('and no longer shows the player who was sold',
        !squad.includes(outLabel), `${outLabel}`, s);

      // The negative assertion below passes trivially on a blank page, so first
      // prove a recommendation is actually on screen to be checked.
      const rendered = await evaluate(s, `!!document.querySelector('.fpl-hero-headline')
        && /This gameweek/i.test(document.body.textContent)`);
      await rec('a recommendation rendered to check the transfer against', rendered, '', s);

      // web_name is player-supplied text ("O'Riley", "N.Williams"): escape it
      // before building a regex from it, or the dot matches anything and an
      // apostrophe variant silently never matches.
      const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = await evaluate(s, `document.body.textContent`);
      await rec('the plan does not re-recommend the transfer already made',
        !new RegExp(`${escapeRe(outLabel)}[^]{0,80}${escapeRe(inLabel)}`).test(body),
        `looked for "${outLabel} -> ${inLabel}" in the recommendation`, s);

      const errs = errorsOf(s);
      await rec('no console errors reconciling the transfer', errs.length === 0, errs.slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* -------------------- 7. a pre-season squad survives a reload ------------- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'preseason', waitFor: 'intro' });

    // The user-visible STORY of the pre-season plan, not just its contents.
    // The reload used to keep the squad but swap the story: the restored plan
    // re-entered through the manual path, and every surface that read money or
    // transfer state straight off the plan flipped to "£0.0m of the £0.0m
    // budget", "Roll your transfer" and "Your bank fell from £100.0m to
    // £0.0m" while the squad itself was perfectly intact. Asserting the story
    // is identical before and after the reload is what pins the class.
    const storyOf = () => evaluate(s, `(() => {
      const t = document.body.innerText;
      const h = document.querySelector('.fpl-hero-headline');
      // Roll copy is judged on the hero only: the future-plan card correctly
      // says "Roll your transfer" for the gameweeks AFTER the first deadline.
      const hero = document.querySelector('.fpl-hero');
      const heroText = hero ? hero.innerText : '';
      return JSON.stringify({
        headline: h ? h.textContent.trim() : '',
        rollCopy: /Roll your transfer|Bank this week's transfer|go into next week with/i.test(heroText),
        zeroBudget: /£0\\.0m of the £0\\.0m/.test(t),
        unlimited: /Unlimited until the GW\\d+ deadline/i.test(t),
        bankMoved: /bank (fell|rose)/i.test(t),
        cards: [...document.querySelectorAll('.fpl-card .fpl-card-head h3')].map(e => e.textContent.trim()),
      });
    })()`).then(JSON.parse);

    try {
      await clickText(s, 'Build the optimal 15', { settle: 600 });
      await waitPlan(s);
      const before = await evaluate(s, `[...document.querySelectorAll('.fpl-pp-name')].map(e=>e.textContent.trim()).sort()`);
      await rec('a squad can be built pre-season', before.length >= 15, `${before.length} players`, s);

      const built = await storyOf();
      await rec('the built squad reads as an opening 15, not an in-season roll',
        built.headline === 'Build this opening 15' && !built.rollCopy, built.headline, s);
      await rec('the built squad prices itself against the real budget',
        !built.zeroBudget, '', s);
      await rec('and says transfers are unlimited until the first deadline',
        built.unlimited, '', s);

      const saved = await evaluate(s, `(()=>{ const raw=localStorage.getItem('fplPlannerSquadSnapshot');
        if(!raw) return null; const v=JSON.parse(raw); return {ids:(v.ids||[]).length, gw:v.gw, source:v.source}; })()`);
      await rec('and it is written to storage with the context to restore it',
        saved && saved.ids === 15, JSON.stringify(saved), s);

      // Reload the page exactly as a returning user would.
      await goto(s, base + '/apps/fpl-planner/', { settle: 600 });
      const restored = await waitPlan(s, 60000);
      const after = await evaluate(s, `[...document.querySelectorAll('.fpl-pp-name')].map(e=>e.textContent.trim()).sort()`);

      await rec('reloading returns the squad instead of the empty intro',
        restored && after.length >= 15, `${after.length} players`, s);
      await rec('and it is the SAME fifteen',
        JSON.stringify(after) === JSON.stringify(before),
        `${after.slice(0, 4).join(', ')}...`, s);
      await rec('the app says where the squad came from',
        /saved on an earlier visit/i.test(await evaluate(s, `document.body.textContent`)), '', s);
      await rec('and offers a way to change it',
        /Edit this squad|Start over/i.test(await evaluate(s, `document.body.textContent`)), '', s);

      const back = await storyOf();
      await rec('the restored squad still reads as an opening 15, not an in-season roll',
        back.headline === 'Build this opening 15' && !back.rollCopy, back.headline, s);
      await rec('the restored squad still prices itself against the real budget',
        !back.zeroBudget, '', s);
      await rec('restoring does not claim the bank moved',
        !back.bankMoved, '', s);
      await rec('transfers still read as unlimited until the first deadline',
        back.unlimited, '', s);
      await rec('the reload renders the same set of cards it rendered when built',
        JSON.stringify(back.cards) === JSON.stringify(built.cards),
        `built [${built.cards.join(', ')}] vs restored [${back.cards.join(', ')}]`, s);

      // A manual squad's picks are a roster in position order, not a lineup:
      // seeding the sandbox "current" from those slots used to put both
      // goalkeepers in the eleven and greet the user with "This team is not
      // legal yet", and the pitch offered a "Current team" view of the same
      // nonsense arrangement. The scenario must seed from the plan, and no
      // current-team view exists before a real lineup does.
      await clickText(s, 'My scenario', { settle: 800 });
      await sleep(1500);
      const sandbox = await evaluate(s, `(() => {
        const t = document.body.innerText;
        return JSON.stringify({
          seeded: /ready to edit/i.test(t),
          notLegal: /This team is not legal yet|would field 2 GKP/i.test(t),
          currentTab: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Current team'),
        });
      })()`).then(JSON.parse);
      await rec('the restored squad seeds a LEGAL scenario from the plan',
        sandbox.seeded && !sandbox.notLegal, JSON.stringify(sandbox), s);
      await rec('no "Current team" view is offered before a real lineup exists',
        !sandbox.currentTab, '', s);

      // The comparison strip must compare against the seed, not against an
      // eleven fabricated from roster slots: untouched, "This gameweek"
      // reads level, never a phantom gain over a two-goalkeeper baseline.
      const cmp = await evaluate(s, `(() => {
        const cell = [...document.querySelectorAll('.fpl-cmp')]
          .find(c => /This gameweek/i.test(c.textContent));
        if (!cell) return JSON.stringify({ found: false });
        return JSON.stringify({
          found: true,
          before: (cell.querySelector('.fpl-cmp-before') || {}).textContent || '',
          after: (cell.querySelector('.fpl-cmp-after') || {}).textContent || '',
        });
      })()`).then(JSON.parse);
      await rec('an untouched restored scenario compares level, not against a fabricated eleven',
        cmp.found && cmp.before === cmp.after, JSON.stringify(cmp), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------ 8. a gameweek in play is shown as live, not finalised ------- */
  {
    // GW1 is current with its fixtures played but NOT data-checked, which is
    // the real overnight state: the score exists and bonus has not been applied.
    const s = await openPlanner(cdpPort, base, { state: 'gw1-live' });
    try {
      await clickText(s, 'History', { settle: 900 });
      const view = await evaluate(s, `(()=>{
        const t = document.body.textContent;
        return {
          live: /is being played/i.test(t) && /provisional/i.test(t),
          liveChip: !!document.querySelector('.fpl-chip.is-live'),
          rankTile: (()=>{ const tiles=[...document.querySelectorAll('.fpl-tile')];
            const el=tiles.find(x=>/Overall rank/i.test(x.textContent));
            return el ? el.textContent.replace(/\\s+/g,' ').trim() : null; })(),
          pointsTile: (()=>{ const tiles=[...document.querySelectorAll('.fpl-tile')];
            const el=tiles.find(x=>/Total points/i.test(x.textContent));
            return el ? el.textContent.replace(/\\s+/g,' ').trim() : null; })(),
          // The overall rank the live row prints, so the tile can be held to it.
          rowRank: (()=>{ const r=[...document.querySelectorAll('tr.is-live')]
            .find(x=>/^GW\\s*1(?!\\d)/.test((x.children[0]||{}).textContent.trim()));
            return r ? (r.children[3] || {}).textContent.trim() : null; })(),
        };
      })()`);
      await rec('a gameweek in play is labelled provisional', view.live, JSON.stringify(view).slice(0, 140), s);
      await rec('and the row carries a live marker', view.liveChip, '', s);
      // Pass 3 of the GW1 runbook (2026-08-22) found the tile reading "-" while
      // the same rank sat in the row below it. The tile shows the known rank and
      // says it is provisional; it never invents one.
      await rec('the rank tile shows the rank the live row prints, marked provisional',
        !!view.rankTile && !!view.rowRank && view.rowRank !== '-'
          && view.rankTile.includes(view.rowRank) && /provisional/i.test(view.rankTile),
        `${view.rankTile} | row ${view.rowRank}`, s);
      await rec('and the live points total is labelled provisional, not a season total',
        !!view.pointsTile && /provisional/i.test(view.pointsTile), view.pointsTile, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ---------- 9. missing picks in season is not "the season has not started" */
  {
    // Season under way, this manager started at GW1, and picks 404. He owns a
    // squad; the API just did not hand it over.
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900, false);
      const p = await payloadsFor('gw1-finished', { teamId: TEAM_ID });
      p.entry = { ...p.entry, started_event: 1 };
      const withoutPicks = { ...p, picksGw: null };
      await interceptNetwork(s, proxyRule(withoutPicks));
      await goto(s, base + '/apps/fpl-planner/', { settle: 250 });
      await evaluate(s, `(()=>{
        for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
        localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
        return 1;
      })()`);
      await goto(s, base + '/apps/fpl-planner/', { settle: 900 });
      await waitForExpr(s, `/could not be read|has not started|not played a gameweek/i.test(document.body.textContent)`, { timeout: 30000 });

      const text = await evaluate(s, `document.body.textContent`);
      await rec('an in-season manager is not told the season has not started',
        !/season has not started/i.test(text), text.slice(0, 160), s);
      await rec('he is told his squad could not be read',
        /could not be read/i.test(text), '', s);
      await rec('and warned that what is shown is not his team',
        /Nothing below is your team/i.test(text), '', s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------- 10. a failure screen survives navigating away and back --------- */
  {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      // Everything 503s: the load fails outright.
      await interceptNetwork(s, proxyRule(p, { fail: () => ({ status: 503, body: { error: 'upstream_unavailable' } }) }));
      await goto(s, base + '/apps/fpl-planner/', { settle: 250 });
      await evaluate(s, `(()=>{
        for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
        localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
        return 1;
      })()`);
      await goto(s, base + '/apps/fpl-planner/', { settle: 900 });
      await waitForExpr(s, `/could not load the data/i.test(document.body.textContent)`, { timeout: 30000 });

      const first = await evaluate(s, `(()=>({
        text: document.body.textContent,
        actions: [...document.querySelectorAll('.fpl-btn')].map(b=>b.textContent.trim()),
      }))()`);
      await rec('a failed load explains itself in a sentence, not an exception',
        /did not respond|could not be loaded|rate limiting/i.test(first.text)
        && !/Cannot read properties|undefined \(reading/i.test(first.text),
        first.text.match(/Fantasy Premier League[^.]*\./)?.[0] || '', s);
      await rec('and offers a way to recover', first.actions.some(a => /Try again/i.test(a)), first.actions.join(' | '), s);

      // Leave the failure and come back.
      await clickText(s, 'History', { settle: 700 });
      await clickText(s, 'Plan', { settle: 700 });
      const back = await evaluate(s, `(()=>({
        empty: /No plan yet\./.test(document.body.textContent),
        actions: [...document.querySelectorAll('.fpl-btn')].map(b=>b.textContent.trim()),
        explained: /could not load the data/i.test(document.body.textContent),
      }))()`);
      await rec('returning to Plan is not a dead end', !back.empty && back.explained, JSON.stringify(back).slice(0, 140), s);
      await rec('and the recovery actions are still there',
        back.actions.some(a => /Try again/i.test(a)), back.actions.join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ---- 11. a gameweek in play: live points, and advice that pauses itself --- */
  {
    // The 2026-08-21 incident, as a browser check. GW1 is being played, so the
    // squad has ACTUAL points and the data cannot yet carry transfer or chip
    // advice. Both facts have to be visible and neither may be mistaken for
    // the other.
    const s = await openPlanner(cdpPort, base, { state: 'gw1-live', waitFor: 'plan' });
    try {
      await clickText(s, 'Current team', { settle: 800 });
      const live = await evaluate(s, `(() => {
        const cards = [...document.querySelectorAll('.fpl-pp')];
        const live = cards.map(c => {
          const v = c.querySelector('.fpl-pp-live-v');
          const l = c.querySelector('.fpl-pp-live-l');
          const xpEl = c.querySelector('.fpl-pp-xp');
          return {
            name: (c.querySelector('.fpl-pp-name') || {}).textContent || '',
            v: v ? v.textContent.trim() : null,
            l: l ? l.textContent.trim() : null,
            xp: xpEl ? xpEl.textContent.trim() : null,
          };
        });
        return JSON.stringify({
          cards: cards.length,
          withLive: live.filter(r => r.v !== null).length,
          scorers: live.filter(r => r.v && /^[0-9]+$/.test(r.v)).map(r => r.v),
          dashes: live.filter(r => r.v === '-').length,
          bothShown: live.filter(r => r.v !== null && r.xp && /xP/.test(r.xp)).length,
          labels: [...new Set(live.map(r => r.l).filter(Boolean))],
          badges: [...document.querySelectorAll('.fpl-pp-move')].map(b => b.textContent.trim()),
        });
      })()`).then(JSON.parse);

      await rec('every player card carries a live score line', live.withLive === live.cards,
        `${live.withLive} of ${live.cards}`, s);
      await rec('the players who played show their points',
        ['6', '5', '3'].every(v => live.scorers.includes(v)), live.scorers.join(','), s);
      // Three states, three renderings, and the difference matters: a player
      // whose match FINISHED and who did not appear genuinely scored zero, and
      // a player whose match has not kicked off has no score at all. Printing
      // zero for the second reads exactly like a bad performance.
      await rec('a player whose match has not started shows a dash, not a zero',
        live.dashes >= 10, `${live.dashes} dashes for ${live.cards} cards`, s);
      await rec('actual points and expected points are both shown, and distinguishable',
        live.bothShown === live.cards, `${live.bothShown} of ${live.cards}`, s);
      await rec('the live line says which match state it describes',
        live.labels.some(l => /yet to play|pts/.test(l)), live.labels.join(' | '), s);
      await rec('no card is marked OUT on the team the manager owns',
        !live.badges.includes('OUT'), live.badges.join(',') || '(none)', s);

      // The header total and the pitch must tell the same story.
      const totals = await evaluate(s, `(() => {
        const t = document.body.innerText;
        const m = t.match(/TOTAL POINTS\\s*\\n?\\s*(-?[0-9]+)/i);
        const cards = [...document.querySelectorAll('.fpl-pp-live-v')]
          .map(e => e.textContent.trim()).filter(v => /^[0-9]+$/.test(v)).map(Number);
        return JSON.stringify({ header: m ? Number(m[1]) : null, sum: cards.reduce((a, b) => a + b, 0) });
      })()`).then(JSON.parse);
      await rec('the pitch adds up to something a manager can check against the header',
        totals.sum === 14, JSON.stringify(totals), s);

      // Advice, meanwhile, has to say it is paused rather than invent a chip.
      const advice = await evaluate(s, `(() => {
        const t = document.body.innerText;
        return JSON.stringify({
          paused: /Recommendations paused|advice is paused|Paused:/i.test(t),
          bestWindow: /best window for it/i.test(t),
          wildcard: /Play your Wildcard/i.test(t),
          contradiction: /Moderate confidence/i.test(t) && /minutes are unclear/i.test(t),
        });
      })()`).then(JSON.parse);
      await rec('chip advice is paused rather than invented', !advice.wildcard && !advice.bestWindow,
        JSON.stringify(advice), s);
      await rec('and the pause is stated, not left to be inferred', advice.paused, '', s);
      await rec('confidence never reads moderate while the minutes are unclear',
        !advice.contradiction, '', s);

      const errs = errorsOf(s);
      await rec('no console errors through a live gameweek', errs.length === 0, errs.slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  return R;
}