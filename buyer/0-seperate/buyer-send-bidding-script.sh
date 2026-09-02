#!/bin/bash
#
# Modular buyer bidding load test — uses buyer/0-seperate/ modules
#
# usage:
#   ./buyer-send-bidding-script.sh [lotId] [lotLineId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus] [biddingDelayMs]
#
# example:
#   LOT_LINE_ID=<id> ./buyer-send-bidding-script.sh 975 <lotLineId> 5m 1 10
#   ./buyer-send-bidding-script.sh 975 <lotLineId> 10m 1 50 loadtestuser 20 500
#
# Depends on:
#   ./k6-buyer-send-bidding.js
#   ./lib/api-functions.js
#   ./lib/websocket-functions.js
#   ../../buyer-mock-user.js
#   ../../lib/k6-report.js
#

set -e

if [ "$#" -gt 8 ]; then
  echo "usage: $0 [lotId] [lotLineId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus] [biddingDelayMs]"
  exit 1
fi

LOT_ID="${1:-975}"
LOT_LINE_ID="${2:-${LOT_LINE_ID:-}}"
WS_HOLD="${3:-30m}"
START_LOOP_INDEX="${4:-1}"
END_LOOP_INDEX="${5:-100}"
USERNAME_PREFIX="${6:-loadtestuser}"
VUS="${7:-}"
BIDDING_DELAY_MS="${8:-${BIDDING_DELAY_MS:-}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-send-bidding.js"

if [ ! -f "$K6_SCRIPT" ]; then
  echo "file not found: $K6_SCRIPT"
  exit 1
fi

if [ -z "$LOT_LINE_ID" ]; then
  echo "LOT_LINE_ID is required (arg2 or env LOT_LINE_ID=...)"
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

if [ -n "$BIDDING_DELAY_MS" ] && ! [[ "$BIDDING_DELAY_MS" =~ ^[0-9]+$ ]]; then
  echo "biddingDelayMs must be a non-negative integer (ms), got: $BIDDING_DELAY_MS"
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

echo "script          : $K6_SCRIPT (modular)"
echo "lotId           : $LOT_ID"
echo "lotLineId       : $LOT_LINE_ID"
echo "auctionNo       : ${AUCTION_NO:-1}"
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
echo "ack             : ${ACK:-true}"
if [ -n "$BIDDING_DELAY_MS" ]; then
  echo "biddingDelayMs  : $BIDDING_DELAY_MS"
else
  echo "biddingDelayMs  : (default = 0)"
fi
echo "report dir      : $REPORT_DIR"
echo "Start Date Time : $START_TIME"
echo ""

K6_ARGS=(
  -e "BASE_URL=${BASE_URL:-https://auctlive-sit.auct.co.th/api/v1}"
  -e "WS_URL=${WS_URL:-wss://auctlive-sit.auct.co.th/api/v1/websocket}"
  -e "LOGIN_TYPE=buyer"
  -e "LOT_ID=${LOT_ID}"
  -e "LOT_LINE_ID=${LOT_LINE_ID}"
  -e "AUCTION_NO=${AUCTION_NO:-1}"
  -e "BIDDING_EVENT=${BIDDING_EVENT:-online}"
  -e "BIDDING_ACTION=${BIDDING_ACTION:-bid}"
  -e "BIDDING=${BIDDING:-true}"
  -e "ACK=${ACK:-true}"
  -e "WS_HOLD=${WS_HOLD}"
  -e "START_LOOP_INDEX=${START_LOOP_INDEX}"
  -e "END_LOOP_INDEX=${END_LOOP_INDEX}"
  -e "USERNAME_PREFIX=${USERNAME_PREFIX}"
  -e "REPORT_DIR=${REPORT_DIR}"
  -e "REPORT_BASENAME=buyer-send-bidding-separate"
  -e "REPORT_TITLE=buyer visitLot → bidding (modular)"
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

if [ -n "${STAGGER_MS:-}" ]; then
  K6_ARGS+=(-e "STAGGER_MS=${STAGGER_MS}")
fi

if [ -n "${ACK_TIMEOUT_MS:-}" ]; then
  K6_ARGS+=(-e "ACK_TIMEOUT_MS=${ACK_TIMEOUT_MS}")
fi

if [ -n "${ACK_RETRY_MS:-}" ]; then
  K6_ARGS+=(-e "ACK_RETRY_MS=${ACK_RETRY_MS}")
fi

if [ -n "${ACK_COOLDOWN_MS:-}" ]; then
  K6_ARGS+=(-e "ACK_COOLDOWN_MS=${ACK_COOLDOWN_MS}")
fi

if [ -n "${BIDDING_INTERVAL_MS:-}" ]; then
  K6_ARGS+=(-e "BIDDING_INTERVAL_MS=${BIDDING_INTERVAL_MS}")
fi

if [ -n "${BIDDING_DELAY_MS:-}" ]; then
  K6_ARGS+=(-e "BIDDING_DELAY_MS=${BIDDING_DELAY_MS}")
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
Test Execution (modular)
==================================================
File Name       : $FILE_NAME_LABEL
Scenario        : buyer visitLot → bidding (modular)
Lot ID          : $LOT_ID
Lot Line ID     : $LOT_LINE_ID
Auction No      : ${AUCTION_NO:-1}
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
echo "Reports: ${REPORT_DIR}/buyer-send-bidding-separate.{json,html}"
