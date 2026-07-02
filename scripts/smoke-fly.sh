#!/usr/bin/env bash
# Post-deploy smoke test — run over the tailnet AFTER `fly deploy`. NOT in
# `npm test`: it spends a few tokens (one real chat turn).
#   ./scripts/smoke-fly.sh                 # uses MagicDNS name helm-chat:3107
#   ./scripts/smoke-fly.sh 100.x.y.z       # or a tailnet IP / host
# Passes if /chat serves 200, /api/chat returns a non-error reply, and the
# chat-only perimeter holds (/api/queue → 404, keyless /api/chat → 401).
set -uo pipefail

HOST="${1:-helm-chat}"
BASE="http://${HOST}:3107"
fail=0

# X-HELM-KEY — same resolution as the app: env first, then ~/.claude/.env
if [ -z "${HELM_API_KEY:-}" ] && [ -f "$HOME/.claude/.env" ]; then
  HELM_API_KEY=$(sed -n 's/^HELM_API_KEY=//p' "$HOME/.claude/.env" | tail -1)
fi
if [ -z "${HELM_API_KEY:-}" ]; then
  echo "HELM_API_KEY not set (env or ~/.claude/.env) — cannot smoke /api/chat"; exit 1
fi

echo "→ GET ${BASE}/chat"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/chat")
if [ "$code" = "200" ]; then echo "  PASS  /chat → 200"; else echo "  FAIL  /chat → ${code}"; fail=1; fi

# the chat-only perimeter: write surface 404s, keyless chat 401s
echo "→ POST ${BASE}/api/queue (must be 404 — chat-only image)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "${BASE}/api/queue" \
  -H 'Content-Type: application/json' -d '{"skill":"morning-report"}')
if [ "$code" = "404" ]; then echo "  PASS  /api/queue → 404"; else echo "  FAIL  /api/queue → ${code}"; fail=1; fi

echo "→ POST ${BASE}/api/chat without X-HELM-KEY (must be 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "${BASE}/api/chat" \
  -H 'Content-Type: application/json' -d '{"message":"pong"}')
if [ "$code" = "401" ]; then echo "  PASS  keyless /api/chat → 401"; else echo "  FAIL  keyless /api/chat → ${code}"; fail=1; fi

echo "→ POST ${BASE}/api/chat (one real turn, ~a few tokens)"
resp=$(curl -s --max-time 300 -X POST "${BASE}/api/chat" \
  -H 'Content-Type: application/json' \
  -H "X-HELM-KEY: ${HELM_API_KEY}" \
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
