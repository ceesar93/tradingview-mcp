/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

// 🔑 A LATE BAR IS NOT A STALL (2026-10-10). With two practice replays running at
// once (OiOrjep9 + ylcHm2Dx), a stepped bar sometimes landed a second or two AFTER
// the single reveal check. Both sessions were told "run out of revealed bars" on the
// 04-15 replay, ~an hour into the day, and stopped -- yet re-reading the chart moments
// later showed the bar had arrived, and the next step worked. So before declaring a
// stall, keep re-reading the count for up to this long. A genuine end-of-history
// still reports false, only this much later.
const LATE_REVEAL_MS = 6000;
const LATE_REVEAL_POLL_MS = 250;

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    lateRevealMs: Number.isFinite(deps?.lateRevealMs) ? deps.lateRevealMs : LATE_REVEAL_MS,
  };
}

const MAIN_SERIES_BARS =
  'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()';

// Read the newest bar — bars.lastIndex() — as [time, o, h, l, c, volume].
const LAST_BAR = `
  (function() {
    var bars = ${MAIN_SERIES_BARS};
    if (!bars || typeof bars.lastIndex !== 'function') return null;
    var v = bars.valueAt(bars.lastIndex());
    return v ? {time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0} : null;
  })()
`;

// How many bars the chart currently holds. In replay mode this is the count
// REVEALED so far (future bars are masked), so a successful step increments it
// by one — which is what makes it a reliable "did a bar actually appear" probe.
// It is the same value data_get_ohlcv reports as `total_available`.
const BAR_COUNT = `
  (function() {
    var bars = ${MAIN_SERIES_BARS};
    if (!bars || typeof bars.size !== 'function') return null;
    return bars.size();
  })()
`;

/** Numeric bar count, or null when the bars path is unavailable. */
async function readBarCount(evaluate) {
  try {
    const n = await evaluate(BAR_COUNT);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;   // can't tell — callers must treat this as unknown, not "no bar"
  }
}

/**
 * Is this bar still being written by the replay engine?
 *
 * TradingView animates each newly-revealed replay bar through 4 intra-bar phases.
 * Phase 1 publishes open===high===low===close with volume = total/4; the real OHLC
 * lands ~1-2s later. Two independent tells (both confirmed by live probing 2026-07-26,
 * where forming volume was exactly total/4 across every sample):
 *   - flat bar   — open === high === low === close
 *   - fractional volume — share volume is always a whole number, but total/4 usually isn't
 *
 * A false positive (a genuine doji whose volume happens to divide by 4) costs only the
 * settle timeout and still returns correct data, so this errs safe by construction.
 */
function isBarForming(bar) {
  if (!bar) return false; // can't tell — don't block
  if (bar.volume % 1 !== 0) return true;
  return bar.open === bar.high && bar.high === bar.low && bar.low === bar.close;
}

/**
 * Poll until the newest bar has finished animating.
 *
 * Necessary because currentDate() flips at phase 1, so a step that returns on the date
 * change alone hands back a half-written bar. Returns whether the bar settled; a null
 * read (bars path unavailable) resolves immediately rather than stalling the step.
 */
async function waitForBarSettled(evaluate, { timeoutMs = 4000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let bar = null;
  try { bar = await evaluate(LAST_BAR); } catch { return { settled: null, bar: null }; }
  if (!bar) return { settled: null, bar: null };

  while (isBarForming(bar) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try { bar = await evaluate(LAST_BAR); } catch { break; }
    if (!bar) break;
  }
  return { settled: !isBarForming(bar), bar };
}

/**
 * TradingView's "Continue your last replay?" prompt.
 *
 * Appears whenever replay mode is entered on a chart that still holds saved replay
 * state. It does NOT block the replay API — start/step keep working underneath — but
 * it sits on top of the chart, so anything screenshot- or UI-click-based breaks until
 * it is cleared (confirmed live 2026-07-26 on the practice tab).
 *
 * Dismissed by a DOM .click() rather than ui_mouse_click coordinates, deliberately:
 * screenshots on this Retina setup are 2x the CDP mouse-coordinate space, so a
 * coordinate read off an image has to be halved before it lands. A DOM click needs no
 * coordinates at all, so that whole class of error cannot occur. Same technique already
 * used for the Pine "Save Script" dialog (pine.js).
 */
const REPLAY_PROMPT_NEEDLE = 'continue your last replay';

export const DISMISS_REPLAY_PROMPT = `
  (function() {
    var NEEDLE = ${JSON.stringify(REPLAY_PROMPT_NEEDLE)};
    var nodes = document.querySelectorAll(
      '[role="dialog"], [data-dialog-name], [class*="dialog"], [class*="modal"], [class*="popup"]'
    );
    // Outer wrappers contain the text too, so take the TIGHTEST match — the smallest
    // text payload is the actual prompt, not the page shell it is mounted in.
    var dlg = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // 🔴 NOT offsetParent (fixed 2026-10-10). The prompt is a position:fixed
      // dialog, and offsetParent is ALWAYS null for a fixed element, so the old
      // test skipped the one node it was looking for and replay_start returned
      // replay_prompt_dismissed:false with the prompt still on screen.
      if (!el.getClientRects().length) continue; // not rendered
      var txt = (el.textContent || '').toLowerCase();
      if (txt.indexOf(NEEDLE) === -1) continue;
      if (!dlg || (el.textContent || '').length < (dlg.textContent || '').length) dlg = el;
    }
    if (!dlg) return { found: false, clicked: false };

    function visible(b) { return !!b && b.getClientRects().length > 0; }
    var btn = null, via = null;

    // Prefer the close (X) control: it dismisses without ANSWERING the question, so it
    // cannot resume the old replay position out from under the date we just selected.
    var closes = dlg.querySelectorAll('[data-name="close"], button[aria-label*="lose"], [class*="close"]');
    for (var j = 0; j < closes.length && !btn; j++) if (visible(closes[j])) { btn = closes[j]; via = 'close'; }

    var btns = dlg.querySelectorAll('button');
    // Then an affirmative button — it keeps replay mode ON. A "Cancel"/"No" could exit
    // replay entirely, which is strictly worse than resuming at a date we then override.
    for (var k = 0; k < btns.length && !btn; k++) {
      if (visible(btns[k]) && /continue|resume|\\byes\\b|\\bok\\b/i.test(btns[k].textContent || '')) {
        btn = btns[k]; via = 'affirmative';
      }
    }
    for (var m = 0; m < btns.length && !btn; m++) if (visible(btns[m])) { btn = btns[m]; via = 'first'; }

    if (!btn) return { found: true, clicked: false };
    btn.click();
    return { found: true, clicked: true, via: via, label: (btn.textContent || '').trim().slice(0, 40) };
  })()
`;

/**
 * Clear the replay prompt if it is up, once.
 *
 * Single-shot by design — the caller retries from inside the initialization poll it
 * already runs, so covering the prompt's render delay costs no extra wall-clock.
 *
 * Never throws: this is convenience cleanup, and a failure here must not take down an
 * otherwise-working replay_start. Returns null when it could not tell.
 */
async function dismissReplayPrompt(evaluate) {
  try {
    return await evaluate(DISMISS_REPLAY_PROMPT);
  } catch {
    return null;
  }
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);

  // Cheap single look — the prompt sometimes precedes selectDate(). Retried from inside
  // the initialization poll below, since enableReplayMode() is the likelier trigger.
  let prompt = await dismissReplayPrompt(evaluate);

  // Where was replay sitting before we move it? Two reasons this matters:
  //  1. If a replay is ALREADY running, currentDate() keeps returning that old
  //     position for a moment after selectDate() — so breaking the poll below on
  //     "non-null" hands back the PREVIOUS position while the chart has already
  //     moved. That makes an accidental relocation almost impossible to diagnose,
  //     because the tool reports where you were, not where you now are.
  //  2. A non-null value here means we are about to displace someone else's
  //     in-progress replay (e.g. a live practice session on the practice tab).
  //     Surfaced in the return so the caller can notice instead of silently
  //     clobbering it. (Incident 2026-07-26: a diagnostic replay_start relocated
  //     an active practice session and reported the old position back, which sent
  //     the investigation looking for a TradingView bug that did not exist.)
  let priorDate = null;
  try {
    const wasStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
    if (wasStarted) priorDate = await evaluate(wv(`${rp}.currentDate()`));
  } catch { priorDate = null; }

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    const ts = new Date(date).getTime();
    if (isNaN(ts)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  //
  // When a replay was already running (priorDate set), also wait for the value to
  // actually CHANGE — otherwise we return the old position. Bounded separately,
  // because re-selecting the date replay is already on legitimately never changes
  // it, and that must not hang.
  const CHANGE_WAIT_POLLS = 8; // ~2s
  const PROMPT_RETRY_POLLS = 6; // ~1.5s — covers the prompt's render delay
  let started = false;
  let currentDate = null;
  let confirmed = false;
  for (let i = 0; i < 30; i++) {
    // Retry the prompt here rather than in its own polled loop: this loop is already
    // sleeping, so the render delay is covered for free. Ordering also matters — the
    // click lands before this loop confirms the date, so a click that DID disturb the
    // position surfaces as current_date_confirmed:false instead of passing silently.
    if (!prompt?.clicked && i < PROMPT_RETRY_POLLS) prompt = await dismissReplayPrompt(evaluate);

    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) {
      if (priorDate === null || currentDate !== priorDate) { confirmed = true; break; }
      if (i >= CHANGE_WAIT_POLLS) break; // still stale — return it, but flag it
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // The loop above breaks on its first iteration whenever init is already complete, which
  // can easily beat the prompt to the screen. Bounded tail sweep so a late render still
  // gets cleared; capped tight because this is dead time whenever no prompt ever appears.
  for (let i = 0; i < 3 && !prompt?.clicked; i++) {
    await new Promise(r => setTimeout(r, 200));
    prompt = await dismissReplayPrompt(evaluate);
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  return {
    success: true,
    replay_started: true,
    date: date || '(first available)',
    current_date: currentDate,
    // false = current_date may still be the pre-call position, do not trust it
    current_date_confirmed: confirmed,
    // non-null = an in-progress replay was displaced by this call
    replaced_existing_replay: priorDate !== null,
    previous_date: priorDate,
    // true = TradingView's "Continue your last replay?" prompt was up and got cleared
    replay_prompt_dismissed: !!prompt?.clicked,
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi, lateRevealMs } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  const countBefore = await readBarCount(evaluate);
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }

  // currentDate flips at intra-bar phase 1, while the bar keeps animating for ~1-2s
  // more. Without this second wait, an immediate data_get_ohlcv reads a flat bar with
  // total/4 volume — and no `count` protects against it, since every pull ends at
  // bars.lastIndex(). Waiting here fixes it once for every caller.
  const { settled } = await waitForBarSettled(evaluate);

  // Did a bar actually appear?
  //
  // currentDate advancing is NOT evidence that it did. The replay cursor is just a
  // date pointer, and doStep() moves it whether or not there is data at the new
  // position — so once the cursor walks past the end of the chart's revealed bars,
  // every subsequent step still returns a fresh, larger currentDate while the newest
  // bar never changes. That is a silent stall: the caller sees success, an advancing
  // date and a settled bar, and only notices something is wrong if it independently
  // watches data_get_ohlcv's total_available sit still.
  //
  // Cost of not reporting it, observed live 2026-08-04: an autonomous practice session
  // replaying 2025-11-05 walked off the edge at the 08:54 PT bar and kept "stepping"
  // for three more calls. It was caught only because the agent noticed the bar count
  // pinned at 366 by eye. Reported here, the stall is unmissable on the first step.
  //
  // null (not false) when either read failed — "cannot tell" must never be rendered as
  // "no bar", or a missing bars path would fake a stall on a perfectly healthy replay.
  let countAfter = countBefore === null ? null : await readBarCount(evaluate);
  let lateReveal = false;
  if (countBefore !== null && countAfter !== null && countAfter <= countBefore) {
    const deadline = Date.now() + lateRevealMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, LATE_REVEAL_POLL_MS));
      const n = await readBarCount(evaluate);
      if (n === null) { countAfter = null; break; }
      countAfter = n;
      if (countAfter > countBefore) { lateReveal = true; break; }
    }
  }
  const barRevealed =
    countBefore === null || countAfter === null ? null : countAfter > countBefore;

  const result = {
    success: true, action: 'step', current_date: currentDate,
    bar_settled: settled, bar_revealed: barRevealed,
  };
  if (lateReveal) result.late_reveal = true;   // arrived after the first check
  if (barRevealed === false) {
    result.warning =
      'Replay cursor advanced but NO new bar appeared — the chart has run out of ' +
      `revealed bars (still ${countAfter}). Stepping further will not produce data. ` +
      'Treat this as end-of-replay-data and stop the session.';
  }
  return result;
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
