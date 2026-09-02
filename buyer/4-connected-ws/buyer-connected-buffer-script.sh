#!/bin/bash
#
# usage:
#   ./buyer-connected-buffer-script.sh [lotId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]
#
# example:
#   ./buyer-connected-buffer-script.sh 975 5m 1 10 loadtestuser
#   → LOT_ID=975, WS_HOLD=5m, lot-bidder-number prepared sequentially in setup()
#
# Optional env (passed through to k6):
#   LOT_BIDDER_GAP_MS, LOT_BIDDER_RETRIES, LOT_BIDDER_RETRY_MS, HTTP_TIMEOUT_MS, SETUP_TIMEOUT (default 0 = 24h),
#   BASE_URL, WS_URL, USER_PICK, EXECUTOR, LOG_WS_MSG
#
# Depends on:
#   ./k6-buyer-connected-buffer.js  # setup: lot-bidder ทีละ user → parallel WS connected
#   ../../buyer-mock-user.js
#   ../../lib/k6-report.js
#

set -e

if [ "$#" -gt 6 ]; then
  echo "usage: $0 [lotId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]"
  echo "example: $0 975 5m 1 10 loadtestuser"
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
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-connected-buffer.js"

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
echo "lotBidderMode   : setup-sequential"
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
  -e "REPORT_BASENAME=buyer-connected-buffer"
  -e "REPORT_TITLE=buyer visitLot → connected (buffer)"
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

if [ -n "${LOT_BIDDER_GAP_MS:-}" ]; then
  K6_ARGS+=(-e "LOT_BIDDER_GAP_MS=${LOT_BIDDER_GAP_MS}")
fi

if [ -n "${LOT_BIDDER_RETRIES:-}" ]; then
  K6_ARGS+=(-e "LOT_BIDDER_RETRIES=${LOT_BIDDER_RETRIES}")
fi

if [ -n "${LOT_BIDDER_RETRY_MS:-}" ]; then
  K6_ARGS+=(-e "LOT_BIDDER_RETRY_MS=${LOT_BIDDER_RETRY_MS}")
fi

if [ -n "${HTTP_TIMEOUT_MS:-}" ]; then
  K6_ARGS+=(-e "HTTP_TIMEOUT_MS=${HTTP_TIMEOUT_MS}")
fi

if [ -n "${SETUP_TIMEOUT:-}" ]; then
  K6_ARGS+=(-e "SETUP_TIMEOUT=${SETUP_TIMEOUT}")
fi

K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=${REPORT_DIR}/buyer-connected-buffer-dashboard.html k6 run "$K6_SCRIPT" "${K6_ARGS[@]}"

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
Scenario        : buyer visitLot → connected (buffer — lot-bidder setup sequential)
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
echo "Reports: ${REPORT_DIR}/buyer-connected-buffer.{json,html}"
