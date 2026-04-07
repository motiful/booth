#!/bin/bash
exec node "$(dirname "$0")/../../dist/src/pre-compact-hook.js" "$@"
