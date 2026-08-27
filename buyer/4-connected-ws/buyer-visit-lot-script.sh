#!/bin/bash
#
# usage:
#   ./buyer-visit-lot-script.sh [lotId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]
#
# example:
#   ./buyer-visit-lot-script.sh
#   → LOT_ID=975, WS_HOLD=30m, buyers loadtestuser01 .. loadtestuser100
#
#   ./buyer-visit-lot-script.sh 975 5m
#   → LOT_ID=975, WS_HOLD=5m, buyers loadtestuser01 .. loadtestuser100
#
#   ./buyer-visit-lot-script.sh 975 5m 1 10
#   → buyers loadtestuser01 .. loadtestuser10
#
#   ./buyer-visit-lot-script.sh 975 10m 21 30 k6buyer
#   → buyers k6buyer21 .. k6buyer30
#
#   ./buyer-visit-lot-script.sh 975 10m 1 50 loadtestuser 20
#   → buyers loadtestuser01 .. loadtestuser50, VUS=20
#
# Depends on:
#   ./k6-buyer-visit-lot.js   # login → lot-bidder-number → WS visitLot → connected
#   ../../buyer-mock-user.js  # getMockBuyer(start, end, prefix)
#   ../../lib/k6-report.js
#

set -e

if [ "$#" -gt 6 ]; then
  echo "usage: $0 [lotId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]"
  echo "example: $0"
  echo "example: $0 975 5m"
  echo "example: $0 975 5m 1 10"
  echo "example: $0 975 10m 21 30 k6buyer"
  echo "example: $0 975 10m 1 50 loadtestuser 20"
  exit 1
fi

LOT_ID="${1:-975}"
WS_HOLD="${2:-30m}"
START_LOOP_INDEX="${3:-1}"
END_LOOP_INDEX="${4:-100}"
USERNAME_PREFIX="${5:-loadtestuser}"
VUS="${6:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-visit-lot.js"

if [ ! -f "$K6_SCRIPT" ]; then
  echo "file not found: $K6_SCRIPT"
  exit 1
fi

if ! [[ "$START_LOOP_INDEX" =~ ^[1-9][0-9]*$ ]]; then
  echo "startLoopIndex must be a positive integer, got: $START_LOOP_INDEX"
  exit 1
fi

if ! [[ "$END_LOOP_INDEX" =~ ^[1-9][0-9]*$ ]]; then
  echo "endLoopIndex must be a positive integer, got: $END_LOOP_INDEX"
  exit 1
fi

if [ "$END_LOOP_INDEX" -lt "$START_LOOP_INDEX" ]; then
  echo "endLoopIndex ($END_LOOP_INDEX) must be >= startLoopIndex ($START_LOOP_INDEX)"
  exit 1
fi

if [ -n "$VUS" ] && ! [[ "$VUS" =~ ^[1-9][0-9]*$ ]]; then
  echo "vus must be a positive integer, got: $VUS"
  exit 1
fi

TIMESTAMP=$(TZ=Asia/Bangkok date +"%Y%m%d/%H%M%S")
FILE_STAMP=$(echo "$TIMESTAMP" | tr '/' '-')
REPORT_DIR="${REPO_ROOT}/k6-reports/${TIMESTAMP}"
TIMESTAMP_FILE="${REPORT_DIR}/${FILE_STAMP}.txt"
FILE_NAME_LABEL="${TIMESTAMP}/${FILE_STAMP}.txt"

mkdir -p "$REPORT_DIR"

START_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
START_EPOCH=$(date +%s)

BUYER_COUNT=$((END_LOOP_INDEX - START_LOOP_INDEX + 1))

echo "script          : $K6_SCRIPT"
echo "lotId           : $LOT_ID"
echo "wsHold          : $WS_HOLD"
echo "startLoopIndex  : $START_LOOP_INDEX"
echo "endLoopIndex    : $END_LOOP_INDEX"
echo "usernamePrefix  : $USERNAME_PREFIX"
echo "buyerCount      : $BUYER_COUNT"
if [ -n "$VUS" ]; then
  echo "vus             : $VUS"
else
  echo "vus             : (default = BUYER_USER.length = $BUYER_COUNT)"
fi
echo "report dir      : $REPORT_DIR"
echo "Start Date Time : $START_TIME"
echo ""

K6_ARGS=(
  -e "BASE_URL=${BASE_URL:-https://auctlive-sit.auct.co.th/api/v1}"
  -e "WS_URL=${WS_URL:-wss://auctlive-sit.auct.co.th/api/v1/websocket}"
  -e "LOGIN_TYPE=buyer"
  -e "LOT_ID=${LOT_ID}"
  -e "WS_HOLD=${WS_HOLD}"
  -e "START_LOOP_INDEX=${START_LOOP_INDEX}"
  -e "END_LOOP_INDEX=${END_LOOP_INDEX}"
  -e "USERNAME_PREFIX=${USERNAME_PREFIX}"
  -e "REPORT_DIR=${REPORT_DIR}"
  -e "REPORT_BASENAME=buyer-lot-connected"
  -e "REPORT_TITLE=buyer visitLot → connected"
)

if [ -n "$VUS" ]; then
  K6_ARGS+=(-e "VUS=${VUS}")
fi

if [ -n "${USER_PICK:-}" ]; then
  K6_ARGS+=(-e "USER_PICK=${USER_PICK}")
fi

if [ -n "${EXECUTOR:-}" ]; then
  K6_ARGS+=(-e "EXECUTOR=${EXECUTOR}")
fi

if [ -n "${LOG_WS_MSG:-}" ]; then
  K6_ARGS+=(-e "LOG_WS_MSG=${LOG_WS_MSG}")
fi

k6 run "$K6_SCRIPT" "${K6_ARGS[@]}"

END_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
END_EPOCH=$(date +%s)

DURATION=$((END_EPOCH - START_EPOCH))
HOURS=$((DURATION / 3600))
MINUTES=$(((DURATION % 3600) / 60))
SECONDS=$((DURATION % 60))

DURATION_FORMAT=$(printf "%02d:%02d:%02d" \
  "$HOURS" \
  "$MINUTES" \
  "$SECONDS")

cat > "$TIMESTAMP_FILE" <<EOF
Test Execution
==================================================
File Name       : $FILE_NAME_LABEL
Scenario        : buyer visitLot → connected
Lot ID          : $LOT_ID
WS Hold         : $WS_HOLD
Start Index     : $START_LOOP_INDEX
End Index       : $END_LOOP_INDEX
Username Prefix : $USERNAME_PREFIX
Buyer Count     : $BUYER_COUNT
Start Date Time : $START_TIME
End Date Time   : $END_TIME
Duration        : $DURATION_FORMAT
==================================================
EOF

echo ""
cat "$TIMESTAMP_FILE"
echo ""
echo "Timestamp saved to: $TIMESTAMP_FILE"
echo "Reports: ${REPORT_DIR}/buyer-lot-connected.{json,html}"
