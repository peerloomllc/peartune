#!/usr/bin/env bash
# Evaluate JS inside the PearTune WebView on a given adb device.
#   ./cdp.sh <serial> <local-port> '<js expression>'
set -euo pipefail
SER="$1"; PORT="$2"; JS="$3"

APPPID=$(adb -s "$SER" shell pidof com.peartune.debug | tr -d '\r' | awk '{print $1}')
PID=$(adb -s "$SER" shell 'cat /proc/net/unix' | grep -o "webview_devtools_remote_${APPPID}\b" | sort -u | head -1)
[ -n "$PID" ] || { echo "no webview devtools socket on $SER" >&2; exit 1; }
adb -s "$SER" forward "tcp:$PORT" "localabstract:$PID" >/dev/null

WS=$(curl -s "http://127.0.0.1:$PORT/json" | python3 -c "
import sys,json
ts=json.load(sys.stdin)
for t in ts:
    if t.get('type')=='page' and t.get('webSocketDebuggerUrl'):
        print(t['webSocketDebuggerUrl']); break
")
[ -n "$WS" ] || { echo "no page target on $SER" >&2; exit 1; }

python3 - "$WS" "$JS" <<'PY'
import json,subprocess,sys
ws,js=sys.argv[1],sys.argv[2]
msg=json.dumps({"id":1,"method":"Runtime.evaluate",
                "params":{"expression":js,"returnByValue":True,"awaitPromise":True}})
out=subprocess.run(["websocat","-n1","-B","2000000",ws],input=msg,capture_output=True,text=True,timeout=30)
for line in out.stdout.splitlines():
    try: d=json.loads(line)
    except Exception: continue
    if d.get("id")==1:
        r=d.get("result",{})
        if "exceptionDetails" in r:
            print("EXC:", json.dumps(r["exceptionDetails"])[:400]); sys.exit(1)
        print(json.dumps(r.get("result",{}).get("value")))
        sys.exit(0)
print("no reply:", out.stdout[:300], out.stderr[:300]); sys.exit(1)
PY
