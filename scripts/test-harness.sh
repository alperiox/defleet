#!/usr/bin/env bash
# The custom harness the install test registers: a shell script that hands the turn to test-harness.ts.
exec bun "$(cd "$(dirname "$0")" && pwd)/test-harness.ts" "$@"
