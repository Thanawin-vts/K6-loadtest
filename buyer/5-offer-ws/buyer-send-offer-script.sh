#!/bin/bash
#
# usage:
#   ./buyer-send-offer-script.sh [lotId] [lotLineId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]
#
# example:
#   ./buyer-send-offer-script.sh
#   → LOT_ID=975, LOT_LINE_ID required via env, WS_HOLD=30m, buyers loadtestuser01 .. 100
#
#   LOT_LINE_ID=10360 ./buyer-send-offer-script.sh 975 10360 5m
#   → LOT_ID=975, LOT_LINE_ID=10360, WS_HOLD=5m
#
#   ./buyer-send-offer-script.sh 975 10360 5m 1 10
#   → buyers loadtestuser01 .. loadtestuser10
#
#   ./buyer-send-offer-script.sh 975 10360 10m 21 30 k6buyer
#   → buyers k6buyer21 .. k6buyer30
#
#   ./buyer-send-offer-script.sh 975 10360 10m 1 50 loadtestuser 20
#   → buyers loadtestuser01 .. 50, VUS=20
#
# Optional env (passed through to k6):
#   AUCTION_NO, OFFER_EVENT, OFFER, ACK, BID_AFTER_OFFER, STAGGER_MS,
#   ACK_TIMEOUT_MS, ACK_RETRY_MS, ACK_COOLDOWN_MS, OFFER_INTERVAL_MS,
#   BASE_URL, WS_URL, USER_PICK, EXECUTOR, LOG_WS_MSG
#
# Depends on:
#   ./k6-buyer-send-offer.js  # login → profile → lot-bidder → WS visitLot → connected → offer
#   ../../buyer-mock-user.js
#   ../../lib/k6-report.js
#

set -e

if [ "$#" -gt 7 ]; then
  echo "usage: $0 [lotId] [lotLineId] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus]"
  echo "example: LOT_LINE_ID=<id> $0"
  echo "example: $0 975 <lotLineId> 5m"
  echo "example: $0 975 <lotLineId> 5m 1 10"
  echo "example: $0 975 <lotLineId> 10m 21 30 k6buyer"
  echo "example: $0 975 <lotLineId> 10m 1 50 loadtestuser 20"
  exit 1
fi

LOT_ID="${1:-975}"
LOT_LINE_ID="${2:-${LOT_LINE_ID:-}}"
WS_HOLD="${3:-30m}"
START_LOOP_INDEX="${4:-1}"
END_LOOP_INDEX="${5:-100}"
USERNAME_PREFIX="${6:-loadtestuser}"
VUS="${7:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-send-offer.js"

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
echo "bidAfterOffer   : ${BID_AFTER_OFFER:-false}"
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
  -e "WS_HOLD=${WS_HOLD}"
  -e "START_LOOP_INDEX=${START_LOOP_INDEX}"
  -e "END_LOOP_INDEX=${END_LOOP_INDEX}"
  -e "USERNAME_PREFIX=${USERNAME_PREFIX}"
  -e "REPORT_DIR=${REPORT_DIR}"
  -e "REPORT_BASENAME=buyer-send-offer"
  -e "REPORT_TITLE=buyer visitLot → connected → offer"
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

if [ -n "${OFFER:-}" ]; then
  K6_ARGS+=(-e "OFFER=${OFFER}")
fi

if [ -n "${ACK:-}" ]; then
  K6_ARGS+=(-e "ACK=${ACK}")
fi

if [ -n "${BID_AFTER_OFFER:-}" ]; then
  K6_ARGS+=(-e "BID_AFTER_OFFER=${BID_AFTER_OFFER}")
fi

if [ -n "${STAGGER_MS:-}" ]; then
  K6_ARGS+=(-e "STAGGER_MS=${STAGGER_MS}")
fi

if [ -n "${OFFER_INTERVAL_MS:-}" ]; then
  K6_ARGS+=(-e "OFFER_INTERVAL_MS=${OFFER_INTERVAL_MS}")
fi

if [ -n "${OFFER_EVENT:-}" ]; then
  K6_ARGS+=(-e "OFFER_EVENT=${OFFER_EVENT}")
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

if [ -n "${HTTP_STAGGER_MS:-}" ]; then
  K6_ARGS+=(-e "HTTP_STAGGER_MS=${HTTP_STAGGER_MS}")
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

K6_WEB_DASHBOARD=true k6 run "$K6_SCRIPT" "${K6_ARGS[@]}"

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
Scenario        : buyer visitLot → connected → offer
Lot ID          : $LOT_ID
Lot Line ID     : $LOT_LINE_ID
Auction No      : ${AUCTION_NO:-1}
WS Hold         : $WS_HOLD
Start Index     : $START_LOOP_INDEX
End Index       : $END_LOOP_INDEX
Username Prefix : $USERNAME_PREFIX
Buyer Count     : $BUYER_COUNT
ACK             : ${ACK:-true}
Bid After Offer : ${BID_AFTER_OFFER:-false}
Start Date Time : $START_TIME
End Date Time   : $END_TIME
Duration        : $DURATION_FORMAT
==================================================
EOF

echo ""
cat "$TIMESTAMP_FILE"
echo ""
echo "Timestamp saved to: $TIMESTAMP_FILE"
echo "Reports: ${REPORT_DIR}/buyer-send-offer.{json,html}"
