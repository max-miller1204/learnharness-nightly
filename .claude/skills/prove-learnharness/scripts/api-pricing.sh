#!/usr/bin/env bash
# Run the pricing contracts through the API and plugin inference entry points.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
RECEIPT=${1:?usage: api-pricing.sh <receipt-directory>}
SANDBOX=$(mktemp -d)
trap 'rm -rf -- "$SANDBOX"' EXIT
cd "$REPO"

check() {
	local name=$1 pattern=$2 file=$3 log
	log=$RECEIPT/$name.tap
	if env -i PATH="$PATH" HOME="$SANDBOX" TMPDIR="$SANDBOX" \
		LH_DATA_DIR="$SANDBOX/data" LH_AUTH_FILE="$SANDBOX/auth.json" NODE_ENV=test \
		node --import tsx --test --test-reporter=tap --test-name-pattern="$pattern" "$file" >"$log" 2>&1 &&
		grep -Eq "^[[:space:]]*ok [0-9]+ - $pattern$" "$log"; then
		printf '[ok] %s (%s)\n' "$name" "$log"
	else
		printf '[FAIL] %s (%s)\n' "$name" "$log" >&2
		return 1
	fi
}

status=0
check dispatch-pricing "freezes the dispatched model's cost when a catalog refresh lands while a call is in flight" tests/usage-price-per-call.test.ts || status=1
check plugin-usage-cost 'plugin inference usage ledger omits cost for unpriced providers and [$]0 placeholders while keeping it for priced and known free models' tests/plugin-inference.test.ts || status=1
check plugin-priced-cost "complete preserves native tool calls/signatures and appends per-model plugin-local usage only" tests/plugin-inference.test.ts || status=1
exit "$status"
