// A node:test reporter: every test file's seconds, as JSON, for balancing the
// coverage shards (tests/coverage/file-seconds.json).
import path from 'node:path';
import { fileTimes } from '../../scripts/test-file-times.mjs';

export default async function* report(source) {
  const events = [];
  for await (const ev of source) events.push(ev);
  const seconds = {};
  for (const [file, t] of fileTimes(events)) seconds[path.relative(process.cwd(), file).split(path.sep).join('/')] = Number((t.ms / 1000).toFixed(1));
  yield JSON.stringify(seconds);
}
