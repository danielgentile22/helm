#!/bin/sh
# Proves the guard blocks what it should and passes what it should, in a throwaway repo
# with a fake deny list. Runs in CI, where no real deny list exists. Exit 1 on any miss.
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fails=0
expect() { # want(pass|block) label command...
	want=$1; label=$2; shift 2
	if "$@" >"$tmp/out" 2>&1; then got=pass; else got=block; fi
	if [ "$got" = "$want" ]; then echo "ok    $label"; else echo "MISS  $label (wanted $want, got $got)"; sed 's/^/        /' "$tmp/out"; fails=1; fi
}
printf 'Zanzibar Quuxley\nFrobnitz\nre:host-[0-9]+\\.example-tailnet\n' > "$tmp/deny.txt"
export HELM_GUARD_DENY="$tmp/deny.txt"
git init -q -b main "$tmp/repo" && cd "$tmp/repo"
git config user.email t@example.com; git config user.name t; git config core.hooksPath .githooks
mkdir -p .githooks docs chat && cp "$here"/guard.py "$here"/paths "$here"/pre-commit "$here"/commit-msg "$here"/pre-push .githooks/
git add .githooks && git commit -qm "Add guard" || { echo "MISS  bootstrap commit"; exit 1; }
git init -q --bare "$tmp/remote.git" && git remote add origin "$tmp/remote.git" && git push -q origin main 2>/dev/null

try() { # file content [message]
	mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add -A
	git commit -qm "${3:-Add a file}"; rc=$?; [ $rc -ne 0 ] && git reset -q --hard HEAD; return $rc
}
expect pass  "clean doc in an allowed folder"       try docs/a.md "An ordinary sentence."
expect block "denied name"                          try docs/b.md "Ask frobnitz about it."
expect block "denied two-word name, other case"     try docs/c.md "zanzibar quuxley was here"
expect pass  "denied word only as a substring"      try docs/d.md "Frobnitzer is a different word."
expect block "denied regex term"                    try docs/e.md "open https://host-12.example-tailnet/"
expect block "denied term in a file name"           try docs/frobnitz.md "hi"
expect block "path outside the allow list"          try notes/x.md "hi"
expect block "denied path inside an allowed folder" try chat/.env "X=1"
expect block "env file with a suffix"               try chat/.env.local "X=1"
expect pass  "env example file"                     try chat/.env.example "X="
expect block "run record"                           try docs/runs/2026.json "{}"
expect block "Anthropic key"                        try docs/f.md "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" # guard:allow
expect pass  "code that mentions a token"           try docs/g0.md "{ token: \"requestAnimationFrame(\", owner: null }"
expect block "private key"                          try docs/g.md "-----BEGIN OPENSSH PRIVATE KEY-----" # guard:allow
expect block "real email"                           try docs/h.md "mail someone@gmail.com" # guard:allow
expect pass  "example email"                        try docs/i.md "mail someone@example.com"
expect block "phone number"                         try docs/j.md "call (571) 555-0134" # guard:allow
expect pass  "generic pattern with guard:allow"     try docs/k.md "call (571) 555-0134 guard:allow"
expect block "guard:allow does not cover deny list" try docs/l.md "Frobnitz guard:allow"
expect block "em dash in message"                   try docs/m.md "fine" "Add a thing $(printf '\342\200\224') badly"
expect block "session link in message"              try docs/n.md "fine" "Add a thing

Claude-Session: https://claude.ai/code/session_x"
expect block "denied term in message"               try docs/o.md "fine" "Tell Frobnitz"

# pre-push catches what --no-verify let through
printf 'Frobnitz\n' > docs/p.md; git add -A; git commit -q --no-verify -m "Sneak it in"
expect block "push of a --no-verify commit" git push -q origin main
git reset -q --hard HEAD~1
expect pass  "push of clean commits" git push -q origin main

# fail closed
HELM_GUARD_DENY="$tmp/missing.txt" expect block "missing deny list" try docs/q.md "fine"
: > "$tmp/empty.txt"
HELM_GUARD_DENY="$tmp/empty.txt" expect block "empty deny list" try docs/r.md "fine"
exit $fails
