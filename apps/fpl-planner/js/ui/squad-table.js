// The squad as a sortable table: the same fifteen the pitch draws, for anyone
// who wants to scan numbers rather than a formation. Purely an alternative
// presentation of the pitch view-model; sorting reorders rows on screen and
// changes nothing else.

import { el } from './dom.js';
import { formatMoney, xp } from './format.js';
import { describePlayer, getProjection, availability, fixtureLabel } from './plan-model.js';

function xpOverHorizon(projections, playerId, gwFrom, horizon) {
  let sum = 0;
  for (let k = 0; k < horizon; k++) {
    const row = getProjection(projections, playerId, gwFrom + k);
    if (row && Number.isFinite(row.xPoints)) sum += row.xPoints;
  }
  return sum;
}

const COLUMNS = [
  { key: 'role', label: '', sortable: false },
  { key: 'name', label: 'Player', sortable: true },
  { key: 'position', label: 'Pos', sortable: true },
  { key: 'club', label: 'Club', sortable: true },
  { key: 'price', label: 'Price', sortable: true, numeric: true },
  { key: 'ownership', label: 'Own %', sortable: true, numeric: true },
  { key: 'xpGw', label: 'xP this GW', sortable: true, numeric: true },
  { key: 'xpHorizon', label: 'xP horizon', sortable: true, numeric: true },
  { key: 'fixtures', label: 'Fixtures', sortable: false },
];

// Build the row records once; sorting works on these, not on the DOM.
export function squadTableRows({ vm, gameState, projections, gw, horizon }) {
  const benchIds = vm.bench ? [vm.bench.gk, ...(vm.bench.order || [])].filter(Boolean) : [];
  const make = (id, role, benchIndex = null) => {
    const info = describePlayer(gameState, id);
    const player = gameState.players instanceof Map ? gameState.players.get(id) : null;
    const row = getProjection(projections, id, gw);
    return {
      id,
      role, // 'xi' | 'bench'
      benchIndex,
      isCaptain: id === vm.captain,
      isVice: id === vm.viceCaptain,
      move: vm.movesIn.has(id) ? 'in' : vm.movesOut.has(id) ? 'out' : null,
      name: info.name,
      position: info.position,
      positionShort: info.positionShort,
      club: info.club,
      price: info.priceTenths,
      ownership: player && Number.isFinite(player.selectedByPercent) ? player.selectedByPercent : null,
      xpGw: row ? row.xPoints : null,
      xpHorizon: xpOverHorizon(projections, id, gw, horizon),
      fixtures: fixtureLabel(row, gameState),
      isBlank: !!row && row.fixtures.length === 0,
      avail: player ? availability(player) : null,
    };
  };
  return [
    ...vm.startingXI.map(id => make(id, 'xi')),
    ...benchIds.map((id, i) => make(id, 'bench', i)),
  ];
}

export function sortSquadRows(rows, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  const value = (r) => r[key];
  return rows.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'string') return mul * va.localeCompare(vb);
    return mul * (va - vb);
  });
}

export function renderSquadTable({ vm, gameState, projections, gw, horizon, onPlayerClick = null }) {
  let sortKey = null; // null = squad order (XI then bench)
  let sortDir = 'desc';
  const baseRows = squadTableRows({ vm, gameState, projections, gw, horizon });

  const tbody = el('tbody', {});
  const table = el('table', { class: 'fpl-squad-table' });

  const paintBody = () => {
    const rows = sortKey ? sortSquadRows(baseRows, sortKey, sortDir) : baseRows;
    tbody.replaceChildren(...rows.map(r => {
      const roleBadge = r.isCaptain
        ? el('span', { class: 'fpl-pp-arm is-c is-inline', text: 'C', title: 'Captain' })
        : r.isVice
          ? el('span', { class: 'fpl-pp-arm is-v is-inline', text: 'V', title: 'Vice-captain' })
          : r.role === 'bench'
            ? el('span', { class: 'fpl-role-bench', text: r.benchIndex === 0 && vm.bench.gk ? 'GK' : `B${r.benchIndex + (vm.bench.gk ? 0 : 1)}`, title: 'Bench' })
            : null;
      const tr = el('tr', {
        class: [
          r.role === 'bench' ? 'is-bench' : '',
          r.move ? `is-move-${r.move}` : '',
          onPlayerClick ? 'is-clickable' : '',
        ].filter(Boolean).join(' '),
        tabindex: onPlayerClick ? '0' : null,
        role: onPlayerClick ? 'button' : null,
        'aria-label': onPlayerClick ? `${r.name}: open player details` : null,
      }, [
        el('td', { class: 'is-role' }, roleBadge),
        el('td', { class: 'is-strong is-name' }, [
          el('span', { class: `fpl-pos-dot pos-${r.position}`, 'aria-hidden': 'true' }),
          r.name,
          // Same wording as the pitch ribbon: a transfer marker, never an
          // availability one. The injury chip beside it is the availability
          // one, and the two used to read identically at a glance.
          r.move ? el('span', {
            class: `fpl-pp-move is-inline is-${r.move}`,
            text: r.move === 'in' ? 'BUY' : 'SELL',
            title: r.move === 'in' ? 'The plan buys this player' : 'The plan sells this player',
          }) : null,
          r.avail ? el('span', { class: `fpl-chip ${r.avail.kind === 'out' ? 'is-inj' : 'is-doubt'}`, text: r.avail.label }) : null,
        ]),
        el('td', { text: r.positionShort }),
        el('td', { text: r.club }),
        el('td', { class: 'is-num', text: formatMoney(r.price) }),
        el('td', { class: 'is-num', text: r.ownership === null ? '-' : `${r.ownership.toFixed(1)}%` }),
        el('td', { class: 'is-num is-strong', text: r.xpGw === null ? '-' : xp(r.xpGw) }),
        el('td', { class: 'is-num', text: xp(r.xpHorizon) }),
        el('td', { class: r.isBlank ? 'is-blank-fix' : '', text: r.fixtures }),
      ]);
      if (onPlayerClick) {
        tr.addEventListener('click', () => onPlayerClick(r.id, { trigger: tr }));
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPlayerClick(r.id, { trigger: tr });
          }
        });
      }
      return tr;
    }));
  };

  const thead = el('thead', {}, el('tr', {}, COLUMNS.map(col => {
    if (!col.sortable) return el('th', { class: col.numeric ? 'is-num' : '', text: col.label });
    const th = el('th', {
      class: `is-sortable ${col.numeric ? 'is-num' : ''}`.trim(),
      'aria-sort': 'none',
    });
    const button = el('button', { type: 'button', class: 'fpl-sort-btn' }, [
      col.label,
      el('i', { class: 'fa-solid fa-sort fpl-sort-icon', 'aria-hidden': 'true' }),
    ]);
    button.addEventListener('click', () => {
      if (sortKey === col.key) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortKey = col.key;
        sortDir = col.numeric ? 'desc' : 'asc';
      }
      for (const h of thead.querySelectorAll('th[aria-sort]')) h.setAttribute('aria-sort', 'none');
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
      paintBody();
    });
    th.appendChild(button);
    return th;
  })));

  table.append(thead, tbody);
  paintBody();

  return el('div', {}, [
    el('div', { class: 'fpl-note', style: 'margin-bottom:12px' }, [
      'The same squad as the pitch, as a table. Starting eleven first, then the bench. Click a column to sort; click a player for detail. Expected points are for Gameweek ',
      el('b', { text: String(gw) }),
      '.',
    ]),
    el('div', { class: 'fpl-table-wrap' }, table),
  ]);
}
