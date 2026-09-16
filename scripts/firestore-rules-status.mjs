#!/usr/bin/env node
// What is in firestore.rules, versus what has actually been released.
//
// Rules are not deployed by CI, by a Netlify build, or by merging a PR: a
// merged PR looks exactly like a deploy from inside the repo, which is how the
// ruleset sat five weeks behind production between 2026-08-04 and 2026-09-08.
// firestore-rules-deploy.json is the repo's memory of what shipped, and
// tests/static/firestore-rules-deploy.test.mjs refuses to let an undeployed
// change go unrecorded.
//
//   node scripts/firestore-rules-status.mjs                    print the state
//   node scripts/firestore-rules-status.mjs --record-deployed  after deploying
//
// --record-deployed is a PROMISE, not proof: nothing here can read the live
// ruleset (firebaserules.googleapis.com needs a quota project the local
// Application Default Credentials do not set). Run it only straight after a
// successful deploy. To read what production is really serving, see the
// "Deploying the network rules" section of apps/maptap-rivals/README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RULES = resolve(ROOT, 'firestore.rules');
export const RECORD = resolve(ROOT, 'firestore-rules-deploy.json');

export const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const rulesDigest = () => digestOf(readFileSync(RULES, 'utf8'));
export const readRecord = () => JSON.parse(readFileSync(RECORD, 'utf8'));

const DEPLOY_CMD = 'npx -y firebase-tools@15.27.0 deploy --only firestore:rules --project shevato-site';

function main() {
  const record = readRecord();
  const now = rulesDigest();
  const deployed = record.lastConfirmedDeploy.digest;

  console.log(`firestore.rules      ${now}`);
  console.log(`last deployed        ${deployed}  (${record.lastConfirmedDeploy.on})`);

  if (process.argv.includes('--record-deployed')) {
    const today = new Date().toISOString().slice(0, 10);
    record.digest = now;
    record.lastConfirmedDeploy = { digest: now, on: today, how: DEPLOY_CMD };
    record.awaitingDeploy = null;
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nRecorded as deployed on ${today}. Commit firestore-rules-deploy.json.`);
    return;
  }

  if (now === deployed) {
    console.log('\nIn step: the committed ruleset is the one last recorded as deployed.');
    return;
  }
  console.log('\nOUT OF STEP: the committed ruleset has not been recorded as deployed.');
  if (record.awaitingDeploy) console.log(`\n  ${record.awaitingDeploy}`);
  console.log(`\nTo release it:\n  ${DEPLOY_CMD}\n  node scripts/firestore-rules-status.mjs --record-deployed`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
