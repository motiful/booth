#!/bin/bash
exec node "$(dirname "$0")/../../dist/src/stop-hook.js" "$@"
