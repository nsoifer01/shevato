// Run as the only "test file" of a `node --test --experimental-test-coverage`
// run, to give Node's own reporter the raw V8 coverage of every shard.
//
// Node decides whether a line is covered AFTER merging V8's ranges across all
// processes, so a one-line ternary whose two sides ran in different processes
// counts as covered. Combining each shard's finished LCOV cannot recover that
// (it read 96.03% for a file a whole run reads as 96.30%, 2026-11-09). The
// runner reads whatever is in NODE_V8_COVERAGE when it finishes, so the raw
// files are copied there and Node merges them exactly as it merges one run.
import assert from 'node:assert/strict';
import { copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const sources = JSON.parse(process.env.COVERAGE_REPLAY_SOURCES);
const expected = Number(process.env.COVERAGE_REPLAY_EXPECT);
let copied = 0;
for (const [index, dir] of sources.entries()) {
  for (const name of readdirSync(dir)) {
    const m = /^coverage-(\d+)-(\d{13})-(\d+)\.json$/.exec(name);
    if (!m) continue;
    // The shard's index in the process id keeps names from colliding across runners.
    copyFileSync(path.join(dir, name), path.join(process.env.NODE_V8_COVERAGE, `coverage-${index + 1}${m[1]}-${m[2]}-${m[3]}.json`));
    copied++;
  }
}
assert.equal(copied, expected, 'every raw coverage file the shards reported was found');
