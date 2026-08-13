// Settings, including the two deletion actions and the honest statement about
// the one this app cannot perform.
//
// The deletion wording is checkable: the site privacy policy says what these
// controls do, so they must do exactly that and say which of the two copies
// (this device, your Shevato account) each one actually removed.

import { el, card } from './dom.js';
import { relativeTime, dateTime } from './format.js';
import { btn } from './parts.js';
import { KEYS, SYNC_NAMESPACE, HORIZON_CHOICES, allKeys, disconnectTeamKeys, removeKeys } from './store.js';

// Signed-in state comes from the shared auth object the site header mounts.
// Read at call time: the module can load before Firebase has resolved a session.
export function currentUser() {
  try {
    const auth = typeof window !== 'undefined' ? window.firebaseAuth : null;
    return auth && typeof auth.getCurrentUser === 'function' ? auth.getCurrentUser() : null;
  } catch {
    return null;
  }
}

// What the user is told after a deletion. Separated from the DOM so the
// "say which copy was removed" rule is testable.
export function deletionOutcomeText({ scope, signedIn, cloudOk, cloudError }) {
  const what = scope === 'all' ? 'All FPL Planner data' : 'Your FPL team link';
  if (!signedIn) {
    return `${what} was removed from this device. You are not signed in, so there was no copy in a Shevato account to remove.`;
  }
  if (cloudOk) {
    return `${what} was removed from this device and from your Shevato account. Other devices drop it on their next sync.`;
  }
  return `${what} was removed from this device, but the copy in your Shevato account could not be deleted (${cloudError}). Try again while online.`;
}

async function eraseCloud() {
  const mod = await import('../../../sync-system/storage-sync-robust.js');
  await mod.eraseCloudData(SYNC_NAMESPACE);
}

function settingRow({ title, text, actions, statusNode }) {
  return el('div', { class: 'fpl-setting' }, [
    el('div', { class: 'fpl-setting-title', text: title }),
    el('div', { class: 'fpl-setting-text' }, text),
    el('div', { class: 'fpl-setting-actions' }, [...actions, statusNode].filter(Boolean)),
  ]);
}

export function settingsView({
  settings, teamId, squadState, dataStatus, sample, onApply, onChangeTeam, onDataRemoved, now = Date.now(),
}) {
  // Both options are small closed sets, so they render as segmented controls
  // rather than dropdowns: every choice is visible, and the current one is
  // marked rather than hidden behind a closed select.
  let chosenHorizon = settings.horizon;
  let chosenRisk = settings.risk;

  const segFor = ({ options, chosen, onPick, ariaLabel }) => {
    const seg = el('div', { class: 'fpl-seg', role: 'group', 'aria-label': ariaLabel }, options.map(([value, label]) => el('button', {
      type: 'button',
      class: value === chosen ? 'is-on' : '',
      dataset: { value: String(value) },
      'aria-pressed': value === chosen ? 'true' : 'false',
      onclick: () => {
        onPick(value);
        for (const b of seg.children) {
          const on = b.dataset.value === String(value);
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      },
    }, label)));
    return seg;
  };

  const horizonSeg = segFor({
    options: HORIZON_CHOICES.map(n => [n, `${n} gameweeks`]),
    chosen: chosenHorizon,
    onPick: (v) => { chosenHorizon = v; },
    ariaLabel: 'Planning horizon',
  });
  const riskSeg = segFor({
    options: [['balanced', 'Balanced'], ['aggressive', 'Aggressive'], ['conservative', 'Conservative']],
    chosen: chosenRisk,
    onPick: (v) => { chosenRisk = v; },
    ariaLabel: 'Risk profile',
  });

  const planner = card('Planner settings', [
    el('div', { class: 'fpl-opt-row' }, [
      el('div', { class: 'fpl-opt' }, [
        el('span', { class: 'fpl-field-label', text: 'Planning horizon' }),
        horizonSeg,
      ]),
      el('div', { class: 'fpl-opt' }, [
        el('span', { class: 'fpl-field-label', text: 'Risk profile' }),
        riskSeg,
      ]),
      btn('Apply and recalculate', () => onApply({
        horizon: Number(chosenHorizon),
        risk: chosenRisk,
      }), { variant: 'fpl-btn-primary' }),
    ]),
    el('p', { class: 'fpl-setting-text', style: 'margin-top:14px' }, 'The horizon is how many gameweeks a transfer is judged over. The risk profile moves four things at once: how much a hit has to win by, how many hits are allowed, whether upside or a floor is preferred, and how much a banked free transfer is worth.'),
  ]);

  const team = card('Your Fantasy Premier League team', [
    el('div', { class: 'fpl-kv' }, [
      el('div', {}, [
        el('div', { class: 'fpl-kv-k', text: 'Team ID' }),
        el('div', { class: 'fpl-kv-v', text: sample ? `${teamId} (sample)` : String(teamId || 'not connected') }),
      ]),
      el('div', {}, [
        el('div', { class: 'fpl-kv-k', text: 'Team name' }),
        el('div', { class: 'fpl-kv-v', text: (squadState && squadState.entryName) || '-' }),
      ]),
      el('div', {}, [
        el('div', { class: 'fpl-kv-k', text: 'Last synced' }),
        el('div', {
          class: 'fpl-kv-v',
          text: dataStatus && dataStatus.fetchedAt
            ? (sample ? dateTime(dataStatus.fetchedAt) : relativeTime(dataStatus.fetchedAt, now))
            : 'unknown',
        }),
      ]),
    ]),
    el('div', { class: 'fpl-setting-actions' }, [
      btn('Use a different Team ID', onChangeTeam, { variant: 'fpl-btn-quiet' }),
    ]),
  ]);

  const danger = card('Removing your data', [
    disconnectRow({ onDataRemoved }),
    deleteAllRow({ onDataRemoved }),
    settingRow({
      title: 'Deleting your whole Shevato account',
      text: 'That is not offered here, because it is not this app\'s to delete: your account covers every app on the site. Email nikita@shevato.com and it will be done for you.',
      actions: [],
      statusNode: null,
    }),
  ], { className: 'fpl-danger-zone' });

  return el('div', {}, [planner, team, danger]);
}

function disconnectRow({ onDataRemoved }) {
  const status = el('span', { class: 'fpl-setting-status' });
  const action = btn('Disconnect FPL team', async () => {
    action.disabled = true;
    const user = currentUser();
    removeKeys(disconnectTeamKeys());
    let cloudOk = false;
    let cloudError = '';
    if (user) {
      // The per-key removal above already writes a tombstone through the sync
      // layer, so the cloud copy of these two keys goes with it. Nothing else
      // in the namespace is touched, which is what makes this reversible.
      cloudOk = true;
    }
    const message = deletionOutcomeText({ scope: 'team', signedIn: !!user, cloudOk, cloudError });
    status.textContent = message;
    if (onDataRemoved) onDataRemoved('disconnect', message);
  }, { variant: 'fpl-btn-quiet' });

  return settingRow({
    title: 'Disconnect your FPL team',
    text: `Clears the linked Team ID (${KEYS.teamId}) and the cached squad snapshot (${KEYS.squadSnapshot}), on this device and in your Shevato account. Your saved plans and your planner settings are kept, and connecting the same Team ID again brings everything back.`,
    actions: [action],
    statusNode: status,
  });
}

function deleteAllRow({ onDataRemoved }) {
  const status = el('span', { class: 'fpl-setting-status' });
  const confirmBox = el('div', { class: 'fpl-confirm', hidden: true });
  const row = el('div');

  const confirmBtn = btn('Yes, delete everything', async () => {
    confirmBtn.disabled = true;
    const user = currentUser();
    removeKeys(allKeys());
    let cloudOk = false;
    let cloudError = '';
    if (user) {
      try {
        await eraseCloud();
        cloudOk = true;
      } catch (err) {
        cloudError = String((err && err.message) || err);
      }
    }
    confirmBox.hidden = true;
    confirmBtn.disabled = false;
    const message = deletionOutcomeText({ scope: 'all', signedIn: !!user, cloudOk, cloudError });
    status.textContent = message;
    if (onDataRemoved) onDataRemoved('delete-all', message);
  }, { variant: 'fpl-btn-danger' });

  confirmBox.append(
    el('div', { class: 'fpl-confirm-text' }, [
      'This deletes ',
      el('b', { text: 'all four' }),
      ' FPL Planner keys from this device, and deletes the whole ',
      el('code', { text: SYNC_NAMESPACE }),
      ' document from your Shevato account if you are signed in. Saved plans and gameweek history go with it. It cannot be undone.',
    ]),
    el('div', { class: 'fpl-setting-actions' }, [
      confirmBtn,
      btn('Cancel', () => { confirmBox.hidden = true; }, { variant: 'fpl-btn-quiet' }),
    ]),
  );

  const start = btn('Delete FPL Planner data', () => { confirmBox.hidden = false; }, { variant: 'fpl-btn-danger' });

  row.append(settingRow({
    title: 'Delete all FPL Planner data',
    text: 'Removes your Team ID, your planner settings, every saved plan and the cached squad snapshot. Signed in, it also deletes this app\'s document from your Shevato account, so other devices lose it on their next sync. No other app is touched.',
    actions: [start],
    statusNode: status,
  }));
  row.firstChild.appendChild(confirmBox);
  return row;
}
