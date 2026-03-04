#!/bin/bash
exec node "$(dirname "$0")/../../dist/src/session-end-hook.js" "$@"
