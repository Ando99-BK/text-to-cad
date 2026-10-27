#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/test/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$REPO_ROOT"

# text-to-cad Studio (apps/studio): its server's tests, with a fake Claude and a fake cadgen.
section "Studio"
npm --prefix apps/studio test
