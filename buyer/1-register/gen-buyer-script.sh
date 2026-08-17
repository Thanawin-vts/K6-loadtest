#!/bin/bash
#
# usage:
#   ./gen-buyer-script.sh <count> [start]
#
# example:
#   ./gen-buyer-script.sh 10
#   → 10 users: loadtestuser01 .. loadtestuser10
#   ./gen-buyer-script.sh 10 21
#   → 10 users: loadtestuser21 .. loadtestuser30
#

set -e

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <count> [start]"
  echo "example: $0 10"
  echo "example: $0 10 21"
  exit 1
fi

COUNT="$1"
START="${2:-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-register.js"

if [ ! -f "$K6_SCRIPT" ]; then
  echo "file not found: $K6_SCRIPT"
  exit 1
fi

if ! [[ "$COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "count must be a positive integer, got: $COUNT"
  exit 1
fi

if ! [[ "$START" =~ ^[1-9][0-9]*$ ]]; then
  echo "start must be a positive integer, got: $START"
  exit 1
fi

echo "count  : $COUNT loops"
echo "start  : $START"
echo "script : $K6_SCRIPT"
echo ""

k6 run "$K6_SCRIPT" \
  -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
  -e COUNT="$COUNT" \
  -e START="$START"
