// Marketing-site regression: the 8 root pages plus navigation and responsive
// behaviour. Assertions here are deliberately about structure and wiring, not
// wording, so ordinary copy edits do not turn the suite red.
import {
  newPage, closePage, goto, evaluate, clickSel, setViewport, sleep, cleanErrors,
} from '../cdp.mjs';

const PAGES = ['home', 'work', 'apps', 'about', 'contact', 'privacy', '404', 'moadon-alef'];

// moadon-alef is a standalone, separately-branded landing: it injects its own
// footer partial (footer-moadon-alef) and deliberately carries no site header
// or nav. 404 deliberately has no canonical, because it carries noindex and is
// not a real page. Both are design decisions, not omissions.
const NO_SITE_CHROME = new Set(['moadon-alef']);
const NO_CANONICAL = new Set(['404']);

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });

  const s = await newPage(cdpPort);
  await setViewport(s, 1280, 900);

  for (const p of PAGES) {
    await goto(s, `${base}/${p}.html`, { settle: 2600 });
    const d = await evaluate(s, `(()=>({
      title: document.title,
      h1count: document.querySelectorAll('h1').length,
      header: !!document.querySelector('#header'),
      footer: !!document.querySelector('#footer'),
      navLinks: document.querySelectorAll('#header nav a').length,
      canonical: !!document.querySelector('link[rel=canonical]'),
      desc: !!document.querySelector('meta[name=description]'),
      lang: document.documentElement.lang || null,
      imgsNoAlt: [...document.images].filter(i=>!i.hasAttribute('alt')).length,
      unnamedLinks: [...document.querySelectorAll('a')].filter(a=>
        !a.textContent.trim() && !a.getAttribute('aria-label')
        && !a.querySelector('img[alt]:not([alt=""])')).length
    }))()`);

    t(`${p}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    t(`${p}: has a title`, !!d.title && d.title.length > 5, d.title);
    t(`${p}: exactly one h1`, d.h1count === 1, `found ${d.h1count}`);
    t(`${p}: footer partial injected`, d.footer);
    t(`${p}: meta description present`, d.desc);
    t(`${p}: html lang set`, !!d.lang, String(d.lang));
    t(`${p}: every image has alt`, d.imgsNoAlt === 0, `${d.imgsNoAlt} missing`);
    t(`${p}: no unnamed links`, d.unnamedLinks === 0, `${d.unnamedLinks} unnamed`);
    if (!NO_CANONICAL.has(p)) t(`${p}: canonical present`, d.canonical);
    if (!NO_SITE_CHROME.has(p)) {
      t(`${p}: header partial injected`, d.header);
      if (p !== '404') t(`${p}: nav links present`, d.navLinks >= 5, `${d.navLinks} links`);
    }
  }

  // --- hero CTAs + app grid ------------------------------------------------
  await goto(s, `${base}/home.html`, { settle: 2600 });
  const home = await evaluate(s, `(()=>{
    const btns=[...document.querySelectorAll('.hero .cta-row .button')];
    return { ctaCount:btns.length,
      variants:[...new Set(btns.map(b=>b.className))],
      backgrounds:[...new Set(btns.map(b=>getComputedStyle(b).backgroundColor))],
      appLinksGone: !document.querySelector('.home-app-links') };})()`);
  t('home: three hero CTAs', home.ctaCount === 3, String(home.ctaCount));
  t('home: CTAs share one variant', home.variants.length === 1, home.variants.join(' / '));
  t('home: CTAs share one background', home.backgrounds.length === 1, home.backgrounds.join(' / '));
  // The per-app grid was removed 2026-08-12: /apps is the one route, via the
  // hero button, so the homepage carries no app inventory to drift.
  t('home: no per-app link grid', home.appLinksGone, 'stale .home-app-links present');

  // Every app must resolve from the hub's linked preview images, which are
  // the canonical browse surface now that home carries no per-app grid.
  await goto(s, `${base}/apps.html`, { settle: 2000 });
  const hub = await evaluate(s, `(()=>{
    const links=[...document.querySelectorAll('a.app-preview-link')];
    return { hrefs:links.map(a=>a.getAttribute('href')),
      names:links.map(a=>(a.getAttribute('aria-label')||'').replace(/^Open /,'')) };})()`);
  t('apps hub: every preview image is a link', hub.hrefs.length > 0 && hub.hrefs.every(h => /^apps\/[a-z0-9-]+\/$/.test(h)), hub.hrefs.join(', '));
  for (let i = 0; i < hub.hrefs.length; i++) {
    await goto(s, `${base}/${hub.hrefs[i]}`, { settle: 1500 });
    const ok = await evaluate(s, "document.title.length>0 && !!document.querySelector('h1,h2')");
    t(`apps hub: preview link ${hub.names[i]} resolves`, !!ok, hub.hrefs[i]);
  }

  // --- nav by real click ---------------------------------------------------
  for (const label of ['work', 'apps', 'about', 'contact']) {
    await goto(s, `${base}/home.html`, { settle: 1800 });
    const clicked = await clickSel(s, `#header nav a[href*="${label}"]`);
    const pathNow = await evaluate(s, 'location.pathname');
    t(`nav: "${label}" navigates`, clicked && pathNow.includes(label), `-> ${pathNow}`);
  }

  // --- contact form --------------------------------------------------------
  await goto(s, `${base}/contact.html`, { settle: 2200 });
  const cf = await evaluate(s, `(()=>{
    const f=document.querySelector('form'); if(!f) return {none:true};
    const fields=[...f.querySelectorAll('input,textarea,select')].filter(x=>x.type!=='hidden');
    return { count:fields.length,
      labelled: fields.every(x=> !!f.querySelector('label[for="'+x.id+'"]')
        || !!x.getAttribute('aria-label') || !!x.closest('label') || !!x.placeholder) };})()`);
  t('contact: form present', !cf.none);
  if (!cf.none) t('contact: all fields labelled', cf.labelled, `${cf.count} fields`);

  // --- mobile menu ---------------------------------------------------------
  await setViewport(s, 390, 844, true);
  await goto(s, `${base}/home.html`, { settle: 2600 });
  const opened = await clickSel(s, 'a[href="#menu"]');
  await sleep(700);
  const menu = await evaluate(s, `(()=>{
    const m=document.querySelector('#menu'), c=document.querySelector('#menu .close');
    return { visible: !!m && getComputedStyle(m).visibility!=='hidden',
      links: m?m.querySelectorAll('a').length:0,
      closeNamed: !!c && !!(c.getAttribute('aria-label')||c.textContent.trim()) };})()`);
  t('mobile: menu opens', opened && menu.visible);
  t('mobile: menu has links', menu.links >= 5, String(menu.links));
  t('mobile: close control is named', menu.closeNamed);

  // --- responsive ----------------------------------------------------------
  for (const [w, h, label] of [[390, 844, 'mobile'], [768, 1024, 'tablet'], [1280, 900, 'desktop']]) {
    await setViewport(s, w, h, w < 500);
    for (const p of ['home', 'apps', 'work']) {
      await goto(s, `${base}/${p}.html`, { settle: 1600 });
      const over = await evaluate(s, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      t(`${label} ${p}: no horizontal overflow`, over <= 1, `${over}px`);
    }
  }

  await closePage(cdpPort, s);
  return R;
}
