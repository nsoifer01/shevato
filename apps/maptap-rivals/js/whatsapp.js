'use strict';

// MapTap Rivals - pure WhatsApp chat-export parsing.
//
// A WhatsApp export is plain text, one message per header line, with
// continuation lines for multi-line bodies. The header shape depends on the
// phone, not on the chat, and the importer used to understand exactly one of
// them ("M/D/YY, HH:MM - Name:", the 24-hour Android export from a US-locale
// phone). Everything else was reported as "No WhatsApp messages found" or,
// worse for day/month-first locales, silently mis-dated. This module reads:
//
//   Android   8/10/26, 21:05 - Name: body
//   Android   8/10/26, 9:05 PM - Name: body        (12-hour locales)
//   iOS       [8/10/26, 21:05:12] Name: body       (bracketed, with seconds)
//   iOS       [8/10/26, 9:05:12 PM] Name: body     (U+202F before AM/PM)
//   locale    10.08.26, 21:05 - Name: body         (. or - separators)
//   locale    2026-08-10, 21:05 - Name: body       (year first)
//
// with 2- or 4-digit years, optional seconds, optional AM/PM (also "a.m."),
// and the invisible marks iOS sprinkles in (U+200E/U+200F, U+202F, U+00A0).
//
// Day/month order is never assumed. `detectDateOrder` reads evidence across
// the whole file (a first field above 12 means day-first, a second field
// above 12 means month-first, a 4-digit first field means year-first, and a
// MapTap share's own "Aug 10" body line confirms which field is the month).
// When nothing in the file settles it, the result is flagged ambiguous and
// the caller must ask rather than guess.
//
// Dual export like js/stats.js: `module.exports` for node, `window
// .MapTapWhatsApp` in the browser. The MapTap share parser is injected so
// this file has no dependency of its own.
(function (root) {

  const HEADER_ANDROID =
    /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\s+-\s+([^:]+?):\s?(.*)$/i;
  const HEADER_IOS =
    /^\[(\d{1,4})[./-](\d{1,2})[./-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+([^:]+?):\s?(.*)$/i;

  // Strip the direction marks and turn the narrow/no-break spaces iOS uses
  // around the time into plain spaces so one regex reads every variant.
  function normalizeLine(line) {
    return String(line == null ? '' : line)
      .replace(/[‎‏]/g, '')
      .replace(/[  ]/g, ' ')
      .replace(/\s+$/, '');
  }

  function toYear(raw) {
    const n = Number(raw);
    if (raw.length === 4) return n;
    // Two-digit years: WhatsApp did not exist before 2009, so 70-99 are 1970s
    // only in theory; keep the conventional pivot for predictability.
    return n >= 70 ? 1900 + n : 2000 + n;
  }

  // One header line -> raw parts, or null. Fields a/b/c are the three numeric
  // date parts in file order; their meaning is decided later by the order.
  function parseHeaderLine(line) {
    const s = normalizeLine(line);
    let m = s.match(HEADER_IOS);
    let style = 'ios';
    if (!m) { m = s.match(HEADER_ANDROID); style = 'android'; }
    if (!m) return null;
    const [, a, b, c, hh, mm, ss, ampm, sender, body] = m;
    let hour = Number(hh);
    if (ampm) {
      const pm = /^p/i.test(ampm);
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
    }
    if (hour > 23 || Number(mm) > 59) return null;
    return {
      style,
      a, b, c,
      hour,
      minute: Number(mm),
      second: ss == null ? null : Number(ss),
      hour12: !!ampm,
      sender: sender.trim(),
      body: body,
    };
  }

  // Split the export into messages. Lines that are not headers attach to the
  // previous message's body; lines before the first header are counted as
  // `skippedLeadingLines` so the caller can say so.
  function parseWhatsAppText(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const messages = [];
    let cur = null;
    let skippedLeadingLines = 0;
    for (const ln of lines) {
      const h = parseHeaderLine(ln);
      if (h) {
        if (cur) messages.push(cur);
        cur = h;
      } else if (cur) {
        cur.body += '\n' + normalizeLine(ln);
      } else if (ln.trim()) {
        skippedLeadingLines++;
      }
    }
    if (cur) messages.push(cur);
    return { messages, skippedLeadingLines };
  }

  // Which of the numeric date fields is the day. Returns
  //   { order: 'MDY' | 'DMY' | 'YMD', certain: boolean, evidence: {...} }
  // `shareDateOf(body)` may return { monthIdx, day } for a body that carries
  // a MapTap share date; it is the strongest evidence there is.
  function detectDateOrder(messages, shareDateOf) {
    const ev = { yearFirst: 0, dayFirst: 0, monthFirst: 0, bodyDayFirst: 0, bodyMonthFirst: 0, conflicts: 0 };
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m) continue;
      if (String(m.a).length === 4) { ev.yearFirst++; continue; }
      const a = Number(m.a), b = Number(m.b);
      if (a > 12 && b <= 12) ev.dayFirst++;
      else if (b > 12 && a <= 12) ev.monthFirst++;
      else if (a > 12 && b > 12) ev.conflicts++;
      if (typeof shareDateOf === 'function') {
        let sd = null;
        try { sd = shareDateOf(m.body); } catch (_) { sd = null; }
        if (sd && Number.isFinite(sd.monthIdx)) {
          const month = sd.monthIdx + 1;
          if (a === month && b !== month) ev.bodyMonthFirst++;
          else if (b === month && a !== month) ev.bodyDayFirst++;
        }
      }
    }
    if (ev.yearFirst && !ev.dayFirst && !ev.monthFirst) return { order: 'YMD', certain: true, evidence: ev };
    const dayScore = ev.dayFirst * 2 + ev.bodyDayFirst;
    const monthScore = ev.monthFirst * 2 + ev.bodyMonthFirst;
    if (dayScore && !monthScore) return { order: 'DMY', certain: true, evidence: ev };
    if (monthScore && !dayScore) return { order: 'MDY', certain: true, evidence: ev };
    if (dayScore && monthScore) {
      // Contradictory file: go with the majority but say it is a guess.
      return { order: dayScore > monthScore ? 'DMY' : 'MDY', certain: false, evidence: ev };
    }
    return { order: 'MDY', certain: false, evidence: ev };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // 'YYYY-MM-DD' for real calendar parts, or null for a day that does not
  // exist (Feb 30, the 31st of a 30-day month, Feb 29 in a common year).
  function isoFromYMD(year, monthIdx, day) {
    if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || !Number.isFinite(day)) return null;
    if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
    const ms = Date.UTC(year, monthIdx, day);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== monthIdx || back.getUTCDate() !== day) return null;
    return `${year}-${pad2(monthIdx + 1)}-${pad2(day)}`;
  }

  // Resolve the raw a/b/c fields into year / monthIdx / day using `order`.
  // Messages whose header date does not exist under that order get
  // `invalidDate: true` and no `dateISO`, and are otherwise kept (their
  // bodies may still carry a share date of their own).
  function applyDateOrder(messages, order) {
    return (Array.isArray(messages) ? messages : []).map(m => {
      if (!m) return m;
      let year, month, day;
      if (order === 'YMD') { year = Number(m.a); month = Number(m.b); day = Number(m.c); }
      else if (order === 'DMY') { day = Number(m.a); month = Number(m.b); year = toYear(String(m.c)); }
      else { month = Number(m.a); day = Number(m.b); year = toYear(String(m.c)); }
      const iso = isoFromYMD(year, month - 1, day);
      return Object.assign({}, m, {
        year, monthIdx: month - 1, day,
        dateISO: iso,
        invalidDate: !iso,
      });
    });
  }

  // The calendar day a share belongs to. The body's own "Aug 10" wins over
  // the header (a 1am share still belongs to yesterday's puzzle); the year
  // comes from the header, stepped back when a December share arrives in
  // January and forward when a January share is sent on New Year's Eve. A
  // body day that does not exist in that year (Feb 29 in a common year)
  // yields null, never a rolled-over Mar 1; the caller reports it.
  function dayBucketDate(msg, parsed) {
    if (!msg) return null;
    const parts = parsed && parsed.dateParts;
    if (parts && Number.isFinite(parts.monthIdx) && Number.isFinite(parts.day) && Number.isFinite(msg.year)) {
      let year = msg.year;
      if (parts.monthIdx === 11 && msg.monthIdx === 0) year -= 1;
      else if (parts.monthIdx === 0 && msg.monthIdx === 11) year += 1;
      return isoFromYMD(year, parts.monthIdx, parts.day);
    }
    return msg.dateISO || null;
  }

  // A body is a MapTap share only when it says so: "maptap" or "final score"
  // must appear, so a message that happens to hold five small numbers never
  // becomes a game.
  function parseMapTapShareStrict(body, parseScore) {
    if (!body || typeof parseScore !== 'function') return null;
    if (!/maptap|final\s*score/i.test(body)) return null;
    return parseScore(body);
  }

  const api = {
    normalizeLine, parseHeaderLine, parseWhatsAppText,
    detectDateOrder, applyDateOrder, isoFromYMD, dayBucketDate,
    parseMapTapShareStrict,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.MapTapWhatsApp = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
