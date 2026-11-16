#!/bin/sh
# Copied to the root of every version folder as `lh`: runs this version's
# launcher with this version's bundled Node 26 (TypeScript, type stripping).
d=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$d/node/bin/node" --disable-warning=ExperimentalWarning "$d/selfhost/lh.ts" "$@"
