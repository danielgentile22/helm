#!/usr/bin/env bash
# Post-deploy smoke test — run over the tailnet AFTER `fly deploy`. NOT in
# `npm test`: it spends a few tokens (one real chat turn).
#   ./scripts/smoke-fly.sh                 # uses MagicDNS name helm-chat:3107
#   ./scripts/smoke-fly.sh 100.x.y.z       # or a tailnet IP / host
# Passes if /chat serves 200 and /api/chat returns a non-error reply.
set -uo pipefail

HOST="${1:-helm-chat}"
BASE="http://${HOST}:3107"
fail=0

echo "→ GET ${BASE}/chat"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/chat")
if [ "$code" = "200" ]; then echo "  PASS  /chat → 200"; else echo "  FAIL  /chat → ${code}"; fail=1; fi

echo "→ POST ${BASE}/api/chat (one real turn, ~a few tokens)"
resp=$(curl -s --max-time 300 -X POST "${BASE}/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"reply with the single word: pong"}')
echo "  response: ${resp}"
# non-error = has a "reply" field and no top-level "error"
if echo "$resp" | grep -q '"reply"' && ! echo "$resp" | grep -q '"error"'; then
  echo "  PASS  /api/chat returned a reply"
else
  echo "  FAIL  /api/chat did not return a clean reply"; fail=1
fi

echo
[ "$fail" = 0 ] && echo "smoke OK — phone is good to go" || echo "smoke FAILED"
exit "$fail"
