// Loaded with `node --import` by frozen-fixture-clock.test.mjs: moves this
// process's wall clock to FAKE_NOW, keeping it ticking.

const target = Date.parse(process.env.FAKE_NOW);
if (!Number.isFinite(target)) throw new Error(`FAKE_NOW is not a date: ${process.env.FAKE_NOW}`);

const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
const offset = target - realNow();

globalThis.Date = class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(realNow() + offset);
    else super(...args);
  }

  static now() {
    return realNow() + offset;
  }
};
