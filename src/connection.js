import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Reset state on CDP disconnect or error so getClient() reconnects on next call
      client.on('disconnect', () => { client = null; targetInfo = null; });
      client.on('error', () => { client = null; targetInfo = null; });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Query the active chart symbol on a specific CDP target.
 * Opens a temporary connection, evals the symbol, then closes.
 */
async function getTabSymbol(targetId) {
  let tabClient;
  try {
    tabClient = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await tabClient.Runtime.enable();
    const result = await tabClient.Runtime.evaluate({
      expression: `(function(){ try { return window.TradingViewApi._activeChartWidgetWV.value().symbol(); } catch(e) { return null; } })()`,
      returnByValue: true,
    });
    return result.result?.value || null;
  } catch {
    return null;
  } finally {
    if (tabClient) try { await tabClient.close(); } catch {}
  }
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const tvTargets = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  if (tvTargets.length === 0) return null;
  if (tvTargets.length === 1) return tvTargets[0];

  // Prefer known SPY day-trading layout by chart ID, then fall back to first SPY tab
  const preferred = tvTargets.find(t => t.url.includes('41gFmdJV'));
  if (preferred) return preferred;

  for (const t of tvTargets) {
    const symbol = await getTabSymbol(t.id);
    if (symbol && symbol.toUpperCase().includes('SPY')) return t;
  }
  return tvTargets[0];
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

function attachClientHandlers(c) {
  c.on('disconnect', () => { client = null; targetInfo = null; });
  c.on('error', () => { client = null; targetInfo = null; });
}

/**
 * Reconnect CDP WebSocket to a different tab by symbol fragment match.
 * Evals the live symbol on each chart tab and picks the first match.
 * All subsequent evaluate() calls will run against the new target.
 * Example: switchTarget("btc") → matches BTCUSDT tab, switchTarget("spy") → matches SPY tab.
 */
export async function switchTarget(symbolFragment) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const tvTargets = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

  // Prefer known chart IDs before falling back to symbol eval
  const CHART_IDS = {
    spy: '41gFmdJV',
    btc: '7SqnggXP',
  };
  const knownId = CHART_IDS[symbolFragment.toLowerCase()];
  if (knownId) {
    const preferred = tvTargets.find(t => t.url.includes(knownId));
    if (preferred) {
      if (client) { try { await client.close(); } catch {} client = null; targetInfo = null; }
      targetInfo = preferred;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: preferred.id });
      attachClientHandlers(client);
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      return { success: true, target_id: preferred.id, symbol: symbolFragment.toUpperCase(), url: preferred.url };
    }
  }

  let match = null;
  const symbolMap = [];

  for (const t of tvTargets) {
    const symbol = await getTabSymbol(t.id);
    symbolMap.push({ target: t, symbol });
    if (symbol && symbol.toLowerCase().includes(symbolFragment.toLowerCase())) {
      match = t;
      break;
    }
  }

  if (!match) {
    const available = symbolMap.map(s => `"${s.symbol || 'unknown'}"`).join(', ');
    throw new Error(`No TradingView tab matching "${symbolFragment}". Available symbols: ${available}`);
  }

  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }

  targetInfo = match;
  client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: match.id });
  attachClientHandlers(client);

  await client.Runtime.enable();
  await client.Page.enable();
  await client.DOM.enable();

  const matchedSymbol = symbolMap.find(s => s.target === match)?.symbol;
  return {
    success: true,
    target_id: match.id,
    symbol: matchedSymbol,
    url: match.url,
  };
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
