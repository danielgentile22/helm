#!/bin/bash
# Service: doorbook-sync.
#
# The Doorbook phone app's door into the listing watcher: it sends the houses marked for sale
# and reads back what the doorbook-listings routine found. Loopback only; `tailscale serve`
# fronts it on the tailnet. The code belongs to the doorbook project (scripts/listings/serve.py).

PROJECT="${DOORBOOK_ROOT:-$HOME/Projects/doorbook}"
exec python3 "$PROJECT/scripts/listings/serve.py"
