#!/bin/bash
# Launch TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_mac.sh [port]

PORT="${1:-9222}"

# Auto-detect TradingView install location
APP=""
LOCATIONS=(
  "/Applications/TradingView.app/Contents/MacOS/TradingView"
  "$HOME/Applications/TradingView.app/Contents/MacOS/TradingView"
)

for loc in "${LOCATIONS[@]}"; do
  if [ -f "$loc" ]; then
    APP="$loc"
    break
  fi
done

# Fallback: search with mdfind (Spotlight)
if [ -z "$APP" ]; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.niceincontact.TradingView'" 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

# Fallback: find any TradingView.app
if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  APP=$(find /Applications "$HOME/Applications" -name "TradingView.app" -maxdepth 2 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "Error: TradingView not found."
  echo "Checked: /Applications/TradingView.app, ~/Applications/TradingView.app"
  echo ""
  echo "If installed elsewhere, run manually:"
  echo "  /path/to/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=$PORT"
  exit 1
fi

# Kill any existing TradingView — verify it actually exited before relaunching.
# A frozen/hung TradingView process can outlive a plain SIGTERM; a blind `sleep 1`
# then proceeding to relaunch just hits Electron's single-instance lock, spawning
# throwaway helper processes while the frozen main process survives untouched
# (confirmed live 2026-07-16 — `ps aux` showed the original PID still running,
# same uptime, after the script reported success).
pkill -f "TradingView" 2>/dev/null
for i in $(seq 1 5); do
  if ! pgrep -f "TradingView.app/Contents/MacOS/TradingView" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
if pgrep -f "TradingView.app/Contents/MacOS/TradingView" > /dev/null 2>&1; then
  echo "TradingView still running after SIGTERM after 5s — escalating to kill -9"
  pkill -9 -f "TradingView.app/Contents/MacOS/TradingView" 2>/dev/null
  sleep 1
fi

echo "Found TradingView at: $APP"
echo "Launching with --remote-debugging-port=$PORT ..."
"$APP" --remote-debugging-port=$PORT &
TV_PID=$!
echo "PID: $TV_PID"

# Wait for CDP to be ready
echo "Waiting for CDP..."
cdp_ready=0
for i in $(seq 1 15); do
  if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "CDP ready at http://localhost:$PORT"
    cdp_ready=1
    break
  fi
  sleep 1
done

if [ "$cdp_ready" -eq 0 ]; then
  echo "Warning: CDP not responding after 15s. TradingView may still be loading."
  echo "Check manually: curl http://localhost:$PORT/json/version"
  exit 1
fi

# CDP responding is not the same as having a usable chart tab — TradingView
# Desktop does NOT auto-restore chart tabs after a hard kill (pkill), it opens
# to a blank "New tab" until a human reopens a chart. Confirm an actual chart
# target exists before declaring success, or MCP tool calls will hang/fail
# against a page with no chart API (this caused a 28hr stuck tool call on
# 2026-07-03 — see cron_scripts/README.md session_dead_check.py notes).
echo "Checking for a loaded chart tab..."
for i in $(seq 1 10); do
  if curl -s "http://localhost:$PORT/json" 2>/dev/null | grep -q "tradingview.com/chart"; then
    echo "Chart tab found."
    curl -s "http://localhost:$PORT/json/version" | python3 -m json.tool 2>/dev/null || curl -s "http://localhost:$PORT/json/version"
    exit 0
  fi
  sleep 1
done

echo "ERROR: CDP is up but no chart tab was found after 10s."
echo "TradingView does not auto-restore chart tabs on relaunch — open a chart"
echo "manually (or via tab_new/chart_set_symbol) before running MCP tools,"
echo "otherwise indicator/data calls will fail or hang against a blank tab."
exit 1
