#!/bin/bash
# 薄封装：p5-wake-apply.sh <plan> [--apply]
exec python3 "$(dirname "$0")/p5-wake-apply.py" "$@"
