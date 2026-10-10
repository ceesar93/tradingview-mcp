/**
 * Tests for all replay functions in src/core/replay.js.
 * Covers: start, step, autoplay, stop, trade, status + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { start, step, autoplay, stop, trade, status, VALID_AUTOPLAY_DELAYS, DISMISS_REPLAY_PROMPT } from '../src/core/replay.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockGetReplayApi() {
  return async () => 'window.__rp';
}

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi() }, evaluate };
}

// ── start() ──────────────────────────────────────────────────────────────

/**
 * Mock a replay that is NOT already running — the normal replay_start case.
 * isReplayStarted is false for the pre-call probe (so priorDate is null) and true
 * afterwards, which lets start() confirm the position on its first poll.
 */
function freshReplayMock(finalDate, extra = {}) {
  let selected = false;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    for (const [key, val] of Object.entries(extra)) {
      if (expr.includes(key)) return typeof val === 'function' ? val() : val;
    }
    if (expr.includes('isReplayAvailable')) return true;
    if (expr.includes('showReplayToolbar')) return undefined;
    if (expr.includes('selectDate') || expr.includes('selectFirstAvailableDate')) { selected = true; return 'ok'; }
    if (expr.includes('isReplayStarted')) return selected; // not running until selected
    if (expr.includes('currentDate')) return selected ? finalDate : null;
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

describe('start() — date selection and polling', () => {
  it('awaits selectDate with timestamp in ms for date param', async () => {
    const evaluate = freshReplayMock(1773532799);
    const _deps = { evaluate, getReplayApi: mockGetReplayApi() };
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.success, true);
    assert.equal(result.replay_started, true);
    assert.equal(result.current_date, 1773532799);
    assert.equal(result.date, '2026-03-15');
    // Verify selectDate was called with timestamp and .then()
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called');
    assert.ok(selectCall.includes('.then('), 'promise is awaited via .then()');
    assert.ok(selectCall.includes('1773532800000') || selectCall.includes('177'), 'passes ms timestamp');
  });

  it('calls selectFirstAvailableDate when no date given', async () => {
    const evaluate = freshReplayMock(946684800);
    const _deps = { evaluate, getReplayApi: mockGetReplayApi() };
    const result = await start({ _deps });
    assert.equal(result.date, '(first available)');
    const firstAvail = evaluate.calls.find(c => c.includes('selectFirstAvailableDate'));
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
  });

  it('throws on invalid date string', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: 'not-a-date', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid date'));
        assert.ok(err.message.includes('not-a-date'));
        return true;
      },
    );
  });

  it('throws when replay not available', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': false });
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps }),
      (err) => err.message.includes('not available'),
    );
  });

  it('polls until isReplayStarted AND currentDate are set', async () => {
    let pollCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) {
        pollCount++;
        return pollCount >= 3; // becomes true on 3rd poll
      }
      if (expr.includes('currentDate')) {
        return pollCount >= 4 ? 1700000000 : null; // non-null on 4th poll
      }
      return undefined;
    };
    evaluate.calls = [];
    const result = await start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 1700000000);
    assert.ok(pollCount >= 4, 'polled multiple times');
  });

  it('throws and stops replay when polling times out (never started)', async () => {
    let stopCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) return false; // never starts
      if (expr.includes('currentDate')) return null;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } }),
      (err) => {
        assert.ok(err.message.includes('Replay failed to start'));
        return true;
      },
    );
    assert.ok(stopCalled, 'stopReplay called for cleanup');
  });
});

// ── step() ───────────────────────────────────────────────────────────────

describe('step() — doStep and polling', () => {
  it('calls doStep and polls until currentDate changes', async () => {
    let stepDone = false;
    let dateReadCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) {
        dateReadCount++;
        // First read (before) returns 1000, then after doStep: 1000 twice, then 2000
        if (!stepDone) return 1000;
        return dateReadCount >= 4 ? 2000 : 1000;
      }
      if (expr.includes('doStep')) { stepDone = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000);
    assert.equal(result.action, 'step');
  });

  it('returns stale date if poll times out (date never changes)', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 5000; // never changes
      if (expr.includes('doStep')) return undefined;
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.current_date, 5000);
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => step({ _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── step() — did a bar actually appear? ──────────────────────────────────
//
// The replay cursor is a date pointer: doStep() moves it whether or not data
// exists at the new position. Once it walks past the end of the revealed bars,
// every step still reports a fresh currentDate and a settled bar while nothing
// new arrives. Live case 2026-08-04: a practice session replaying 2025-11-05
// stalled at the 08:54 PT bar and kept "stepping" for three more calls, caught
// only because a human noticed the bar count pinned at 366.
//
// A settled, non-forming bar is used throughout so waitForBarSettled resolves
// immediately and these tests isolate the count comparison.
const SETTLED_BAR = { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 };

/**
 * @param {number[]} counts — bars.size() readings, consumed in call order.
 *                            step() reads it once before doStep and once after.
 */
function steppingMock(counts) {
  let stepped = false;
  let idx = 0;
  const evaluate = async (expr) => {
    if (expr.includes('isReplayStarted')) return true;
    if (expr.includes('doStep')) { stepped = true; return undefined; }
    if (expr.includes('currentDate')) return stepped ? 2000 : 1000;
    if (expr.includes('bars.size')) return counts[Math.min(idx++, counts.length - 1)];
    if (expr.includes('valueAt')) return SETTLED_BAR;
    return undefined;
  };
  evaluate.calls = [];
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi(), lateRevealMs: 0 } };
}

describe('step() — bar_revealed', () => {
  it('waits for a LATE bar instead of calling it a stall (2026-10-10)', async () => {
    // Seen live with two replays at once: the count was still 320 at the first check
    // and 321 a moment later. Reporting false there stopped two sessions an hour in.
    const m = steppingMock([320, 320, 320, 321]);
    m._deps.lateRevealMs = 3000;
    const result = await step(m);
    assert.equal(result.bar_revealed, true);
    assert.equal(result.late_reveal, true);
    assert.equal(result.warning, undefined);
  });

  it('still reports a genuine stall after the late-reveal wait', async () => {
    const m = steppingMock([366, 366]);
    m._deps.lateRevealMs = 600;
    const result = await step(m);
    assert.equal(result.bar_revealed, false);
    assert.match(result.warning, /run out of/i);
  });

  it('reports bar_revealed true when the bar count grows', async () => {
    const result = await step(steppingMock([366, 367]));
    assert.equal(result.bar_revealed, true);
    assert.equal(result.warning, undefined, 'a healthy step must not warn');
  });

  it('reports bar_revealed FALSE when the date advances but no bar appears', async () => {
    const result = await step(steppingMock([366, 366]));
    // The exact failure seen live: success, a fresh date, a settled bar, no data.
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000, 'cursor still advanced — that is the trap');
    assert.equal(result.bar_settled, true);
    assert.equal(result.bar_revealed, false);
    assert.match(result.warning, /run out of/i);
    assert.match(result.warning, /366/, 'warning should name the pinned count');
  });

  it('reports null — not false — when the bar count cannot be read', async () => {
    // Rendering "cannot tell" as "no bar" would fake a stall on a healthy replay.
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('doStep')) return undefined;
      if (expr.includes('currentDate')) return 2000;
      return undefined;   // bars path unavailable → size() read yields undefined
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.bar_revealed, null);
    assert.equal(result.warning, undefined);
  });

  it('reports null when the bars path throws outright', async () => {
    let stepped = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('doStep')) { stepped = true; return undefined; }
      if (expr.includes('currentDate')) return stepped ? 2000 : 1000;
      if (expr.includes('bars.size')) throw new Error('bars path unavailable');
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.bar_revealed, null, 'a throwing probe must not be read as a stall');
    assert.equal(result.success, true, 'the step itself still succeeded');
  });

  it('does not probe the count a second time once the first read failed', async () => {
    // Guards a wasted round-trip: if the path was unavailable before doStep it will
    // still be unavailable after, and the answer is null either way.
    let sizeReads = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('doStep')) return undefined;
      if (expr.includes('currentDate')) return 2000;
      if (expr.includes('bars.size')) { sizeReads++; return null; }
      return undefined;
    };
    evaluate.calls = [];
    await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(sizeReads, 1);
  });
});

// ── start() — stale position / displacing a running replay ───────────────
//
// Regression for the 2026-07-26 incident: replay_start() on an ALREADY-RUNNING
// replay returned the pre-call position, because the poll broke on "currentDate
// is non-null" and a running replay reports its old position for a moment after
// selectDate(). The chart had moved; the tool said it hadn't.

describe('start() — does not report the pre-call position', () => {
  /** Replay already running at `oldDate`; moves to `newDate` after `lagPolls`. */
  function runningReplayMock(oldDate, newDate, lagPolls) {
    let selected = false;
    let polls = 0;
    return async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar')) return undefined;
      if (expr.includes('selectDate')) { selected = true; return 'ok'; }
      if (expr.includes('isReplayStarted')) return true; // running the whole time
      if (expr.includes('currentDate')) {
        if (!selected) return oldDate;       // pre-call probe
        return ++polls > lagPolls ? newDate : oldDate; // lags, then updates
      }
      return undefined;
    };
  }

  it('waits out the lag and returns the NEW position', async () => {
    const evaluate = runningReplayMock(1784914379, 1781098379, 2);
    const result = await start({ date: '2026-06-10', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.current_date, 1781098379, 'must not return the pre-call position');
    assert.equal(result.current_date_confirmed, true);
  });

  it('reports that it displaced an in-progress replay', async () => {
    const evaluate = runningReplayMock(1784914379, 1781098379, 1);
    const result = await start({ date: '2026-06-10', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.replaced_existing_replay, true);
    assert.equal(result.previous_date, 1784914379, 'surfaces what was clobbered');
  });

  it('flags an unconfirmed position instead of hanging when the date never changes', async () => {
    // Re-selecting the date replay is already on: currentDate legitimately never moves.
    const evaluate = runningReplayMock(1784914379, 1784914379, 0);
    const result = await start({ date: '2026-07-24', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date_confirmed, false, 'caller must know not to trust it');
  });

  it('confirms immediately when no replay was running', async () => {
    const evaluate = freshReplayMock(1773532799);
    const result = await start({ date: '2026-03-15', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.replaced_existing_replay, false);
    assert.equal(result.previous_date, null);
    assert.equal(result.current_date_confirmed, true);
  });
});

// ── step() — mid-write bar settling ──────────────────────────────────────
//
// TradingView animates each revealed replay bar through 4 intra-bar phases. Phase 1
// publishes o=h=l=c=open with volume = total/4, and currentDate() has already flipped
// by then — so step() must wait for the bar itself, not just the date.
// Confirmed live 2026-07-26: forming volume was exactly total/4 in every sample
// (18604.5→74418, 17256.75→69027, 12686.5→50746).

describe('step() — waits out the forming bar', () => {
  /** evaluate mock that serves a forming bar for the first N last-bar reads. */
  function barMock(formingReads, settledBar) {
    let reads = 0;
    let stepped = false;
    let count = 100;
    const fn = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('doStep')) { stepped = true; return undefined; }
      if (expr.includes('currentDate')) return stepped ? 2000 : 1000;
      // bars.size() must be matched BEFORE the generic mainSeries branch — the
      // bar_revealed probe reads the same object path, and lumping the two together
      // would make readCount() count count-probes as last-bar reads.
      if (expr.includes('bars.size')) return stepped ? ++count : count;
      if (expr.includes('mainSeries')) {
        reads++;
        // Phase 1: flat OHLC + quarter volume.
        if (reads <= formingReads) {
          return { time: 100, open: 733.55, high: 733.55, low: 733.55, close: 733.55,
                   volume: settledBar.volume / 4 };
        }
        return settledBar;
      }
      return undefined;
    };
    fn.readCount = () => reads;
    return fn;
  }

  const SETTLED = { time: 100, open: 733.55, high: 736.26, low: 733.5, close: 736.19, volume: 69027 };

  it('polls past a forming bar and reports bar_settled', async () => {
    const evaluate = barMock(3, SETTLED);
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.bar_settled, true);
    assert.ok(evaluate.readCount() > 3, 'should have re-read until the bar settled');
  });

  it('returns immediately when the bar is already settled', async () => {
    const evaluate = barMock(0, SETTLED);
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.bar_settled, true);
    assert.equal(evaluate.readCount(), 1, 'no extra polling needed');
  });

  it('detects a flat bar whose quarter-volume happens to be an integer', async () => {
    // total divisible by 4 → fractional-volume tell fails, flat-OHLC tell must catch it
    const divisible = { ...SETTLED, volume: 69028 };
    const evaluate = barMock(2, divisible);
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.bar_settled, true);
    assert.ok(evaluate.readCount() > 2);
  });

  it('does not stall when the bars path is unavailable', async () => {
    // Unknown expressions return undefined — the pre-existing mocks all behave this way,
    // so a null bar read must resolve rather than block until timeout.
    const evaluate = mockEvaluate({ 'isReplayStarted': true, 'currentDate': 2000 });
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.bar_settled, null);
  });
});

// ── start() — "Continue your last replay?" prompt ────────────────────────
//
// The prompt appears whenever replay mode is entered on a chart holding saved replay
// state. It does not block the replay API, but it covers the chart, so screenshots and
// UI clicks break until it is cleared (confirmed live 2026-07-26 on the practice tab).

describe('start() — dismisses the "Continue your last replay?" prompt', () => {
  const PROMPT_TEXT = 'Continue your last replay?';

  function makeButton(label, kind) {
    const b = { textContent: label, offsetParent: {}, getClientRects: () => [{}], kind, clicked: 0 };
    b.click = () => { b.clicked++; };
    return b;
  }

  /** A visible dialog whose buttons answer both selector queries the expression makes. */
  function makeDialog(text, buttons) {
    return {
      textContent: text,
      offsetParent: {},
      rendered: true,
      getClientRects() { return this.rendered ? [{}] : []; },
      querySelectorAll(sel) {
        // Close X's are <button> too, so they appear in both lists — as in the real DOM.
        return sel === 'button' ? buttons : buttons.filter(b => b.kind === 'close');
      },
    };
  }

  /** Run the injected page expression against a hand-rolled DOM (no jsdom dependency). */
  function runDismiss(dialogs) {
    const document = { querySelectorAll: () => dialogs };
    // Parenthesized deliberately: the expression starts with a newline, and
    // `return` + line break would trigger ASI and hand back undefined.
    return new Function('document', `return (${DISMISS_REPLAY_PROMPT});`)(document);
  }

  it('prefers the close X over answering the question', async () => {
    // Answering could resume the OLD replay position, overriding the selectDate() the
    // caller just made. Closing dismisses without choosing, so it cannot move anything.
    const close = makeButton('', 'close');
    const cont = makeButton('Continue', 'button');
    const r = runDismiss([makeDialog(PROMPT_TEXT, [close, cont])]);
    assert.equal(r.clicked, true);
    assert.equal(r.via, 'close');
    assert.equal(close.clicked, 1);
    assert.equal(cont.clicked, 0, 'must not answer the prompt when a close exists');
  });

  it('falls back to an affirmative button, never a cancel', async () => {
    // "Cancel"/"No" can exit replay mode entirely — strictly worse than resuming at a
    // date the caller is about to override anyway.
    const cancel = makeButton('Cancel', 'button');
    const cont = makeButton('Continue', 'button');
    const r = runDismiss([makeDialog(PROMPT_TEXT, [cancel, cont])]);
    assert.equal(r.via, 'affirmative');
    assert.equal(cont.clicked, 1);
    assert.equal(cancel.clicked, 0);
  });

  it('picks the tightest matching container, not the page shell wrapping it', async () => {
    const inner = makeButton('Continue', 'button');
    const outer = makeButton('Chart settings', 'button');
    const shell = makeDialog(`app shell ... ${PROMPT_TEXT} ... lots more chrome`, [outer]);
    const r = runDismiss([shell, makeDialog(PROMPT_TEXT, [inner])]);
    assert.equal(inner.clicked, 1);
    assert.equal(outer.clicked, 0, 'clicking the shell would hit an unrelated control');
  });

  it('finds a position:fixed prompt, whose offsetParent is always null', async () => {
    // Regression, 2026-10-10: the real prompt is a fixed dialog. offsetParent is null
    // for EVERY fixed element, so the old visibility test skipped it, and replay_start
    // reported replay_prompt_dismissed:false with the prompt still covering the chart.
    const close = makeButton('', 'close');
    const fixed = makeDialog(PROMPT_TEXT, [close, makeButton('Continue', 'button')]);
    fixed.offsetParent = null;
    close.offsetParent = null;
    const r = runDismiss([fixed]);
    assert.equal(r.found, true);
    assert.equal(r.via, 'close');
    assert.equal(close.clicked, 1);
  });

  it('ignores an invisible prompt and a dialog that is something else', async () => {
    const hidden = makeDialog(PROMPT_TEXT, [makeButton('Continue', 'button')]);
    hidden.rendered = false;
    const unrelated = makeDialog('Are you sure you want to delete this alert?', [
      makeButton('Delete', 'button'),
    ]);
    assert.equal(runDismiss([hidden, unrelated]).found, false);
  });

  it('reports the dismissal on the start() result', async () => {
    const evaluate = freshReplayMock(1773532799, {
      'continue your last replay': { found: true, clicked: true, via: 'close' },
    });
    const result = await start({ date: '2026-03-15', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.replay_prompt_dismissed, true);
  });

  it('reports false when no prompt was up', async () => {
    const evaluate = freshReplayMock(1773532799, {
      'continue your last replay': { found: false, clicked: false },
    });
    const result = await start({ date: '2026-03-15', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.replay_prompt_dismissed, false);
    assert.equal(result.current_date, 1773532799, 'normal path still works');
  });

  it('stops clicking once dismissed', async () => {
    let dismissCalls = 0;
    const evaluate = freshReplayMock(1773532799, {
      'continue your last replay': () => { dismissCalls++; return { found: true, clicked: true }; },
    });
    await start({ date: '2026-03-15', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(dismissCalls, 1, 'a second click could dismiss an unrelated later dialog');
  });

  it('still starts replay when the dismiss probe throws', async () => {
    // Cleanup convenience must never take down an otherwise-working replay_start.
    const evaluate = freshReplayMock(1773532799, {
      'continue your last replay': () => { throw new Error('CDP detached'); },
    });
    const result = await start({ date: '2026-03-15', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.replay_prompt_dismissed, false);
  });
});

// ── autoplay() ───────────────────────────────────────────────────────────

describe('autoplay() — delay validation', () => {
  for (const delay of VALID_AUTOPLAY_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        'changeAutoplayDelay': undefined,
        'toggleAutoplay': undefined,
        'isAutoplayStarted': true,
        'autoplayDelay': delay,
      });
      const result = await autoplay({ speed: delay, _deps });
      assert.equal(result.success, true);
      assert.equal(result.delay_ms, delay);
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms before any CDP call`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => autoplay({ speed: delay, _deps }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          return true;
        },
      );
      // No CDP calls should have been made
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid speed');
    });
  }

  it('toggles without changing speed when speed is 0', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': true,
      'autoplayDelay': 100,
    });
    const result = await autoplay({ speed: 0, _deps });
    assert.equal(result.success, true);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called for speed=0');
  });

  it('toggles without changing speed when speed omitted', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': false,
      'autoplayDelay': 300,
    });
    const result = await autoplay({ _deps });
    assert.equal(result.autoplay_active, false);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called when speed omitted');
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => autoplay({ speed: 1000, _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('calls stopReplay when started', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'stopReplay': undefined,
    });
    const result = await stop({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.ok(stopCall, 'stopReplay was called');
  });

  it('returns already_stopped when not started', async () => {
    const { _deps, evaluate } = mockDeps({ 'isReplayStarted': false });
    const result = await stop({ _deps });
    assert.equal(result.action, 'already_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.equal(stopCall, undefined, 'stopReplay not called');
  });

  it('does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'), 'hideReplayToolbar must not appear anywhere');
  });
});

// ── trade() ──────────────────────────────────────────────────────────────

describe('trade()', () => {
  for (const action of ['buy', 'sell', 'close']) {
    it(`executes ${action} action`, async () => {
      const { _deps, evaluate } = mockDeps({
        'isReplayStarted': true,
        [action === 'close' ? 'closePosition' : action]: undefined,
        'position': 1,
        'realizedPL': 50.5,
      });
      const result = await trade({ action, _deps });
      assert.equal(result.success, true);
      assert.equal(result.action, action);
      assert.equal(result.position, 1);
      assert.equal(result.realized_pnl, 50.5);
    });
  }

  it('throws on invalid action', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': true });
    await assert.rejects(
      () => trade({ action: 'hold', _deps }),
      (err) => err.message.includes('Invalid action'),
    );
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => trade({ action: 'buy', _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('returns full status object', async () => {
    let callIdx = 0;
    const evaluate = async (expr) => {
      callIdx++;
      // Call 1: big inline IIFE for status fields
      if (callIdx === 1) {
        return {
          is_replay_available: true,
          is_replay_started: true,
          is_autoplay_started: false,
          replay_mode: 'ActiveChart',
          current_date: 1700000000,
          autoplay_delay: 1000,
        };
      }
      // Call 2: position
      if (callIdx === 2) return 2;
      // Call 3: realizedPL
      if (callIdx === 3) return 123.45;
      return undefined;
    };
    evaluate.calls = [];
    const result = await status({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.is_replay_started, true);
    assert.equal(result.current_date, 1700000000);
    assert.equal(result.position, 2);
    assert.equal(result.realized_pnl, 123.45);
  });
});
