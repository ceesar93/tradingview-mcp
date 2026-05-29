import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab', {}, async () => {
    try { return jsonResult(await core.newTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {}, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('target_switch',
    'Reconnect the MCP server to a different TradingView tab by title. All subsequent tool calls will evaluate against that tab. Use tab_list to see available tab titles.',
    {
      title: z.string().describe('Partial tab title to match (case-insensitive). Example: "btc shadow practice". Use tab_list to see available titles.'),
    },
    async ({ title }) => {
      try { return jsonResult(await core.switchTarget({ title })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
