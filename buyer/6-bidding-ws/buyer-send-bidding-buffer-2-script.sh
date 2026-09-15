#!/usr/bin/env bash
#
# Buyer Bidding Load Test Runner
#
# usage:
#   ./buyer-send-bidding-buffer-2-script.sh \
#     [lotId] \
#     [lotLineId] \
#     [auctionNo] \
#     [wsHold] \
#     [startLoopIndex] \
#     [endLoopIndex] \
#     [usernamePrefix] \
#     [vus] \
#     [biddingDelayMs] \
#     [biddingTurnMs] \
#     [disconnected]
#
# examples:
#   ./buyer-send-bidding-buffer-2-script.sh 975 12345
#   ./buyer-send-bidding-buffer-2-script.sh 975 12345 1 5m 1 10
#   ./buyer-send-bidding-buffer-2-script.sh 975 12345 1 10m 1 50 loadtestuser 20 500 100 true
#
# Setup (sequential per user):
#   login
#     → lot-bidder-number
#     → WS visitLot
#     → connected
#     → settle
#     → close
#
# VU (parallel):
#   login
#     → WS rejoin
#     → visitLot
#     → connected
#     → bidding
#
# Optional ENV:
#
#   BASE_URL
#   WS_URL
#
#   BIDDING_EVENT
#   BIDDING_ACTION
#   BIDDING
#   BIDDING_DURATION
#   POST_BID_HOLD
#   BIDDING_ORDER       (sequence [default] | parallel)
#   BIDDING_TURN_MS     (ms per slot in sequence mode, default 2000)
#   DISCONNECTED        (true|false — หลังทุก VU จบ teardown() ทำ leaveLot→disconnected ทีละ buyer, default true)
#   DISCONNECT_GAP_MS   (ms ระหว่าง buyer ใน teardown, default 100)
#   TEARDOWN_TIMEOUT    (override งบ teardown; default คิดจากจำนวน buyer)
#
#   ACK
#   ACK_TIMEOUT_MS
#   ACK_RETRY_MS
#   ACK_COOLDOWN_MS
#
#   STAGGER_MS
#   BIDDING_INTERVAL_MS
#   BIDDING_DELAY_MS
#   BIDDING_TURN_MS
#
#   LOT_BIDDER_GAP_MS
#   WS_JOIN_GAP_MS
#   JOIN_SETTLE_MS      (ms in lot before closing socket in setup, default 1000)
#
#   WS_REJOIN_STAGGER_MS
#   WS_RECONNECT
#   WS_RECONNECT_DELAY_MS
#   WS_RECONNECT_MAX
#
#   LOT_BIDDER_RETRIES
#   LOT_BIDDER_RETRY_MS
#
#   HTTP_TIMEOUT_MS
#   SETUP_TIMEOUT
#
#   USER_PICK
#   EXECUTOR
#   LOG_WS_MSG
#
# Depends on:
#   ./k6-buyer-send-bidding-buffer-2.js
#   ../../buyer-mock-user.js
#   ../../lib/k6-report.js
#

set -Eeuo pipefail

###############################################################################
# Constants
###############################################################################

readonly DEFAULT_LOT_ID="975"
readonly DEFAULT_AUCTION_NO="1"
readonly DEFAULT_WS_HOLD="30m"
readonly DEFAULT_START_LOOP_INDEX="1"
readonly DEFAULT_END_LOOP_INDEX="100"
readonly DEFAULT_USERNAME_PREFIX="loadtestuser"

readonly DEFAULT_BASE_URL="https://auctlive-sit.auct.co.th/api/v1"
readonly DEFAULT_WS_URL="wss://auctlive-sit.auct.co.th/api/v1/websocket"

readonly REPORT_BASENAME="buyer-send-bidding-buffer-2"
readonly REPORT_TITLE="buyer bidding phase (buffer-2)"

###############################################################################
# Runtime state
###############################################################################

K6_PID=""
MONITOR_PID=""
K6_EXIT_CODE=0
RESOURCE_SUMMARY=""

###############################################################################
# Helpers
###############################################################################

log_info() {
  printf '[INFO] %s\n' "$*"
}

log_warn() {
  printf '[WARN] %s\n' "$*" >&2
}

log_error() {
  printf '[ERROR] %s\n' "$*" >&2
}

die() {
  log_error "$*"
  exit 1
}

is_positive_integer() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

is_non_negative_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

print_usage() {
  cat <<EOF
usage:
  $0 [lotId] [lotLineId] [auctionNo] [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [vus] [biddingDelayMs] [biddingTurnMs] [disconnected]

examples:
  LOT_LINE_ID=12345 $0

  $0 975 12345
  $0 975 12345 1 5m
  $0 975 12345 1 5m 1 10
  $0 975 12345 1 10m 21 30 k6buyer
  $0 975 12345 1 10m 1 50 loadtestuser 20
  $0 975 12345 1 10m 1 50 loadtestuser 20 500
  $0 975 12345 1 10m 1 50 loadtestuser 20 500 100 true
EOF
}

cleanup_background_processes() {
  if [[ -n "${K6_PID:-}" ]] && kill -0 "$K6_PID" 2>/dev/null; then
    log_warn "stopping k6 process: $K6_PID"
    kill "$K6_PID" 2>/dev/null || true

    # give normal terminate a chance
    sleep 1

    if kill -0 "$K6_PID" 2>/dev/null; then
      kill -9 "$K6_PID" 2>/dev/null || true
    fi
  fi

  if [[ -n "${MONITOR_PID:-}" ]] && kill -0 "$MONITOR_PID" 2>/dev/null; then
    log_warn "stopping resource monitor: $MONITOR_PID"
    kill "$MONITOR_PID" 2>/dev/null || true
  fi
}

handle_signal() {
  local signal="$1"

  log_warn "received signal: $signal"

  cleanup_background_processes

  case "$signal" in
    INT)
      exit 130
      ;;
    TERM)
      exit 143
      ;;
    *)
      exit 1
      ;;
  esac
}

print_file_if_exists() {
  local label="$1"
  local path="$2"

  if [[ -f "$path" ]]; then
    printf '%-21s: %s\n' "$label" "$path"
  fi
}

###############################################################################
# Signal handling
###############################################################################

trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

###############################################################################
# Arguments
###############################################################################

if [[ "$#" -gt 11 ]]; then
  print_usage
  exit 1
fi

LOT_ID="${1:-$DEFAULT_LOT_ID}"
LOT_LINE_ID="${2:-${LOT_LINE_ID:-}}"
AUCTION_NO="${3:-${AUCTION_NO:-$DEFAULT_AUCTION_NO}}"
WS_HOLD="${4:-$DEFAULT_WS_HOLD}"
START_LOOP_INDEX="${5:-$DEFAULT_START_LOOP_INDEX}"
END_LOOP_INDEX="${6:-$DEFAULT_END_LOOP_INDEX}"
USERNAME_PREFIX="${7:-$DEFAULT_USERNAME_PREFIX}"
VUS="${8:-${VUS:-}}"
BIDDING_DELAY_MS="${9:-${BIDDING_DELAY_MS:-0}}"
BIDDING_TURN_MS="${10:-${BIDDING_TURN_MS:-100}}"
DISCONNECTED="${11:-${DISCONNECTED:-true}}"

###############################################################################
# Path resolution
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-send-bidding-buffer-2.js"
BUYER_MOCK_USER="${REPO_ROOT}/buyer-mock-user.js"
K6_REPORT_LIB="${REPO_ROOT}/lib/k6-report.js"
RESOURCE_MONITOR="${REPO_ROOT}/scripts/monitor-resources.sh"

###############################################################################
# Dependency validation
###############################################################################

command -v k6 >/dev/null 2>&1 ||
  die "k6 command not found. Please install k6 and make sure it is in PATH."

[[ -f "$K6_SCRIPT" ]] ||
  die "file not found: $K6_SCRIPT"

[[ -f "$BUYER_MOCK_USER" ]] ||
  die "file not found: $BUYER_MOCK_USER"

[[ -f "$K6_REPORT_LIB" ]] ||
  die "file not found: $K6_REPORT_LIB"

###############################################################################
# Input validation
###############################################################################

[[ -n "$LOT_LINE_ID" ]] ||
  die "LOT_LINE_ID is required (arg2 or env LOT_LINE_ID=...)"

is_positive_integer "$LOT_ID" ||
  die "lotId must be a positive integer, got: $LOT_ID"

is_positive_integer "$LOT_LINE_ID" ||
  die "lotLineId must be a positive integer, got: $LOT_LINE_ID"

is_positive_integer "$AUCTION_NO" ||
  die "auctionNo must be a positive integer, got: $AUCTION_NO"

is_positive_integer "$START_LOOP_INDEX" ||
  die "startLoopIndex must be a positive integer, got: $START_LOOP_INDEX"

is_positive_integer "$END_LOOP_INDEX" ||
  die "endLoopIndex must be a positive integer, got: $END_LOOP_INDEX"

if (( END_LOOP_INDEX < START_LOOP_INDEX )); then
  die "endLoopIndex ($END_LOOP_INDEX) must be >= startLoopIndex ($START_LOOP_INDEX)"
fi

if [[ -n "$VUS" ]] && ! is_positive_integer "$VUS"; then
  die "vus must be a positive integer, got: $VUS"
fi

is_non_negative_integer "$BIDDING_DELAY_MS" ||
  die "biddingDelayMs must be a non-negative integer (ms), got: $BIDDING_DELAY_MS"

is_non_negative_integer "$BIDDING_TURN_MS" ||
  die "biddingTurnMs must be a non-negative integer (ms), got: $BIDDING_TURN_MS"

case "$(printf '%s' "$DISCONNECTED" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes)
    DISCONNECTED="true"
    ;;
  false|0|no)
    DISCONNECTED="false"
    ;;
  *)
    die "disconnected must be true or false, got: $DISCONNECTED"
    ;;
esac

[[ -n "$USERNAME_PREFIX" ]] ||
  die "usernamePrefix must not be empty"

[[ -n "$WS_HOLD" ]] ||
  die "wsHold must not be empty"

###############################################################################
# Test configuration
###############################################################################

BUYER_COUNT=$((END_LOOP_INDEX - START_LOOP_INDEX + 1))

if [[ -n "$VUS" ]] && (( VUS > BUYER_COUNT )); then
  log_warn "VUS ($VUS) > buyerCount ($BUYER_COUNT). Ensure JS user allocation supports this."
fi

###############################################################################
# Report directory
###############################################################################

TIMESTAMP="$(TZ=Asia/Bangkok date +"%Y%m%d/%H%M%S")"
FILE_STAMP="${TIMESTAMP//\//-}"

REPORT_DIR="${REPO_ROOT}/k6-reports/${TIMESTAMP}"

TIMESTAMP_FILE="${REPORT_DIR}/${FILE_STAMP}.txt"

FILE_NAME_LABEL="${TIMESTAMP}/${FILE_STAMP}.txt"

DASHBOARD_FILE="${REPORT_DIR}/${REPORT_BASENAME}-dashboard.html"

mkdir -p "$REPORT_DIR"

###############################################################################
# Time
###############################################################################

START_TIME="$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")"
START_EPOCH="$(date +%s)"

###############################################################################
# Print configuration
###############################################################################

echo ""
echo "============================================================"
echo " k6 Buyer Bidding Load Test"
echo "============================================================"
printf "%-20s: %s\n" "script" "$K6_SCRIPT"
printf "%-20s: %s\n" "lotId" "$LOT_ID"
printf "%-20s: %s\n" "lotLineId" "$LOT_LINE_ID"
printf "%-20s: %s\n" "auctionNo" "$AUCTION_NO"
printf "%-20s: %s\n" "wsHold" "$WS_HOLD"
if [[ -n "${BIDDING_DURATION:-}" ]]; then
  printf "%-20s: %s\n" "biddingDuration" "$BIDDING_DURATION"
fi
if [[ -n "${POST_BID_HOLD:-}" ]]; then
  printf "%-20s: %s\n" "postBidHold" "$POST_BID_HOLD"
fi
printf "%-20s: %s\n" "startLoopIndex" "$START_LOOP_INDEX"
printf "%-20s: %s\n" "endLoopIndex" "$END_LOOP_INDEX"
printf "%-20s: %s\n" "usernamePrefix" "$USERNAME_PREFIX"
printf "%-20s: %s\n" "buyerCount" "$BUYER_COUNT"

if [[ -n "$VUS" ]]; then
  printf "%-20s: %s\n" "vus" "$VUS"
else
  printf "%-20s: %s\n" "vus" "default ($BUYER_COUNT)"
fi

printf "%-20s: %s\n" "bidding" "${BIDDING:-true}"
printf "%-20s: %s\n" "biddingOrder" "${BIDDING_ORDER:-sequence}"
if [[ "${BIDDING_ORDER:-sequence}" == "sequence" ]]; then
  printf "%-20s: %s ms\n" "biddingTurnMs" "${BIDDING_TURN_MS:-2000}"
fi
printf "%-20s: %s\n" "ack" "${ACK:-true}"
printf "%-20s: %s ms\n" "biddingDelay" "$BIDDING_DELAY_MS"

printf "%-20s: %s\n" \
  "setupMode" \
  "sequential login → lot-bidder → visitLot → connected"

printf "%-20s: %s\n" \
  "vuMode" \
  "staggered rejoin → bidding → reconnect"

printf "%-20s: %s ms\n" \
  "rejoinStagger" \
  "${WS_REJOIN_STAGGER_MS:-200}"

printf "%-20s: %s\n" \
  "reconnect" \
  "${WS_RECONNECT:-true}"

printf "%-20s: %s ms\n" \
  "reconnectDelay" \
  "${WS_RECONNECT_DELAY_MS:-1000}"

printf "%-20s: %s\n" \
  "reconnectMax" \
  "${WS_RECONNECT_MAX:-0}"

printf "%-20s: %s\n" "disconnected" "$DISCONNECTED"

printf "%-20s: %s\n" "reportDir" "$REPORT_DIR"
printf "%-20s: %s\n" "startDateTime" "$START_TIME"

echo "============================================================"
echo ""

###############################################################################
# Base k6 ENV
###############################################################################

K6_ARGS=(
  -e "BASE_URL=${BASE_URL:-$DEFAULT_BASE_URL}"
  -e "WS_URL=${WS_URL:-$DEFAULT_WS_URL}"

  -e "LOGIN_TYPE=buyer"

  -e "LOT_ID=${LOT_ID}"
  -e "LOT_LINE_ID=${LOT_LINE_ID}"
  -e "AUCTION_NO=${AUCTION_NO}"

  -e "START_LOOP_INDEX=${START_LOOP_INDEX}"
  -e "END_LOOP_INDEX=${END_LOOP_INDEX}"
  -e "USERNAME_PREFIX=${USERNAME_PREFIX}"

  -e "WS_HOLD=${WS_HOLD}"

  -e "BIDDING_EVENT=${BIDDING_EVENT:-online}"
  -e "BIDDING_ACTION=${BIDDING_ACTION:-bid}"
  -e "BIDDING=${BIDDING:-true}"
  -e "BIDDING_DELAY_MS=${BIDDING_DELAY_MS}"
  -e "BIDDING_TURN_MS=${BIDDING_TURN_MS}"
  -e "DISCONNECTED=${DISCONNECTED}"
  -e "DISCONNECT_GAP_MS=${DISCONNECT_GAP_MS:-100}"

  -e "ACK=${ACK:-true}"

  -e "WS_REJOIN_STAGGER_MS=${WS_REJOIN_STAGGER_MS:-200}"

  -e "WS_RECONNECT=${WS_RECONNECT:-true}"
  -e "WS_RECONNECT_DELAY_MS=${WS_RECONNECT_DELAY_MS:-1000}"
  -e "WS_RECONNECT_MAX=${WS_RECONNECT_MAX:-0}"

  -e "SETUP_TIMEOUT=${SETUP_TIMEOUT:-0}"
  -e "TEARDOWN_TIMEOUT=${TEARDOWN_TIMEOUT:-}"

  -e "REPORT_DIR=${REPORT_DIR}"
  -e "REPORT_BASENAME=${REPORT_BASENAME}"
  -e "REPORT_TITLE=${REPORT_TITLE}"
)

###############################################################################
# VUS
###############################################################################

if [[ -n "$VUS" ]]; then
  K6_ARGS+=(
    -e "VUS=${VUS}"
  )
fi

###############################################################################
# Optional environment variables
###############################################################################

OPTIONAL_ENV_VARS=(
  BIDDING_DURATION
  POST_BID_HOLD

  BIDDING_ORDER
  BIDDING_TURN_MS

  USER_PICK
  EXECUTOR
  LOG_WS_MSG

  STAGGER_MS

  ACK_TIMEOUT_MS
  ACK_RETRY_MS
  ACK_COOLDOWN_MS

  BIDDING_INTERVAL_MS

  LOT_BIDDER_GAP_MS
  WS_JOIN_GAP_MS
  JOIN_SETTLE_MS

  LOT_BIDDER_RETRIES
  LOT_BIDDER_RETRY_MS

  HTTP_TIMEOUT_MS
)

for env_name in "${OPTIONAL_ENV_VARS[@]}"; do
  env_value="${!env_name:-}"

  if [[ -n "$env_value" ]]; then
    K6_ARGS+=(
      -e "${env_name}=${env_value}"
    )
  fi
done

###############################################################################
# Resource monitor
###############################################################################

if [[ -f "$RESOURCE_MONITOR" ]]; then
  # shellcheck source=/dev/null
  source "$RESOURCE_MONITOR"
else
  log_warn "resource monitor not found: $RESOURCE_MONITOR"
fi

###############################################################################
# Execute k6
###############################################################################

log_info "starting k6..."
log_info ${K6_ARGS[@]}

K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_EXPORT="$DASHBOARD_FILE" \
k6 run \
  "${K6_ARGS[@]}" \
  "$K6_SCRIPT" &

K6_PID=$!

log_info "k6 pid: $K6_PID"

###############################################################################
# Start resource monitor
###############################################################################

if declare -F start_resource_monitor >/dev/null 2>&1; then
  if ! start_resource_monitor "$K6_PID" "$REPORT_DIR"; then
    log_warn "resource monitor failed to start"
  fi
fi

###############################################################################
# Wait k6
#
# IMPORTANT:
# Do NOT call `wait "$K6_PID"` directly with `set -e`.
# A failed k6 test returns non-zero and would terminate this script before
# report generation.
###############################################################################

if wait "$K6_PID"; then
  K6_EXIT_CODE=0
else
  K6_EXIT_CODE=$?
fi

K6_PID=""

###############################################################################
# Stop resource monitor
###############################################################################

if declare -F stop_resource_monitor >/dev/null 2>&1; then

  if RESOURCE_SUMMARY="$(stop_resource_monitor "$REPORT_DIR" 2>&1)"; then
    :
  else
    MONITOR_EXIT_CODE=$?

    log_warn "resource monitor stop failed (exit=$MONITOR_EXIT_CODE)"

    RESOURCE_SUMMARY="$RESOURCE_SUMMARY
Resource Monitor : FAILED
Exit Code        : $MONITOR_EXIT_CODE"
  fi
fi

MONITOR_PID=""

###############################################################################
# Finish time
###############################################################################

END_TIME="$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")"
END_EPOCH="$(date +%s)"

DURATION=$((END_EPOCH - START_EPOCH))

HOURS=$((DURATION / 3600))
MINUTES=$(((DURATION % 3600) / 60))
SECONDS=$((DURATION % 60))

DURATION_FORMAT="$(printf "%02d:%02d:%02d" \
  "$HOURS" \
  "$MINUTES" \
  "$SECONDS")"

###############################################################################
# Result
###############################################################################

if (( K6_EXIT_CODE == 0 )); then
  TEST_RESULT="PASSED"
else
  TEST_RESULT="FAILED"
fi

###############################################################################
# Execution report
###############################################################################

cat > "$TIMESTAMP_FILE" <<EOF
Test Execution
================================================================

Test Result      : $TEST_RESULT
k6 Exit Code     : $K6_EXIT_CODE

Scenario         : buffer-2
Flow             : setup(login→lot-bidder→visitLot→connected)
                   → VU(rejoin→bidding→reconnect)

Lot ID           : $LOT_ID
Lot Line ID      : $LOT_LINE_ID
Auction No       : $AUCTION_NO

WS Hold          : $WS_HOLD

Start Index      : $START_LOOP_INDEX
End Index        : $END_LOOP_INDEX
Username Prefix  : $USERNAME_PREFIX

Buyer Count      : $BUYER_COUNT
VUS              : ${VUS:-$BUYER_COUNT}

Bidding          : ${BIDDING:-true}
Bidding Delay    : ${BIDDING_DELAY_MS} ms
Bidding Turn     : ${BIDDING_TURN_MS} ms

ACK              : ${ACK:-true}

WS Rejoin Stagger: ${WS_REJOIN_STAGGER_MS:-200} ms
WS Reconnect     : ${WS_RECONNECT:-true}
Reconnect Delay  : ${WS_RECONNECT_DELAY_MS:-1000} ms
Reconnect Max    : ${WS_RECONNECT_MAX:-0}

Disconnected     : $DISCONNECTED (teardown sequential leaveLot→disconnected)
Disconnect Gap   : ${DISCONNECT_GAP_MS:-100} ms

Start Date Time  : $START_TIME
End Date Time    : $END_TIME
Duration         : $DURATION_FORMAT

Report Directory : $REPORT_DIR
Execution File   : $FILE_NAME_LABEL

================================================================
Resource Usage
================================================================

${RESOURCE_SUMMARY:-Resource monitor unavailable}

================================================================
EOF

###############################################################################
# Console result
###############################################################################

echo ""
echo "================================================================"
echo " Test Result: $TEST_RESULT"
echo "================================================================"
cat "$TIMESTAMP_FILE"

echo ""
echo "================================================================"
echo " Reports"
echo "================================================================"

print_file_if_exists \
  "Execution Summary" \
  "$TIMESTAMP_FILE"

print_file_if_exists \
  "k6 Dashboard" \
  "$DASHBOARD_FILE"

print_file_if_exists \
  "HTML Report" \
  "${REPORT_DIR}/${REPORT_BASENAME}.html"

print_file_if_exists \
  "JSON Report" \
  "${REPORT_DIR}/${REPORT_BASENAME}.json"

print_file_if_exists \
  "VU Complete" \
  "${REPORT_DIR}/${REPORT_BASENAME}-vu-complete.json"

echo ""
printf "%-21s: %s\n" "Report Directory" "$REPORT_DIR"
printf "%-21s: %s\n" "k6 Exit Code" "$K6_EXIT_CODE"

echo "================================================================"

###############################################################################
# Exit with original k6 result
###############################################################################

exit "$K6_EXIT_CODE"