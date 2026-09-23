#!/bin/bash
#
# Login → websocket ping/pong hold → teardown logout
#
# usage:
#   ./buyer-login-ping-script.sh [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [delay]
#
# VUS = endLoopIndex - startLoopIndex + 1
# delay หน่วงก่อนเริ่ม k6: วินาที, 30s, 5m, 1h (ค่าว่างหรือ 0 = เริ่มทันที)
#
# example:
#   ./buyer-login-ping-script.sh
#   ./buyer-login-ping-script.sh 5m 1 10
#   ./buyer-login-ping-script.sh 10m 1 50 loadtestuser
#   ./buyer-login-ping-script.sh 10m 1 50 loadtestuser 5m
#   ./buyer-login-ping-script.sh 10m 1 100 bltuser 30s
#
# Depends on:
#   ./k6-buyer-login-ping.js
#   ../../buyer-mock-user.js
#   ../../lib/k6-report.js

set -e

if [ "$#" -gt 5 ]; then
  echo "usage: $0 [wsHold] [startLoopIndex] [endLoopIndex] [usernamePrefix] [delay]"
  echo "example: $0 5m 1 10"
  echo "example: $0 10m 1 50 loadtestuser"
  echo "example: $0 10m 1 50 loadtestuser 5m"
  exit 1
fi

WS_HOLD="${1:-5m}"
START_LOOP_INDEX="${2:-1}"
END_LOOP_INDEX="${3:-100}"
USERNAME_PREFIX="${4:-loadtestuser}"
DELAY="${5:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/k6-buyer-login-ping.js"

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

if [[ "$DELAY" =~ ^[0-9]+$ ]]; then
  DELAY_SECONDS="$DELAY"
elif [[ "$DELAY" =~ ^([0-9]+)s$ ]]; then
  DELAY_SECONDS="${BASH_REMATCH[1]}"
elif [[ "$DELAY" =~ ^([0-9]+)m$ ]]; then
  DELAY_SECONDS=$((${BASH_REMATCH[1]} * 60))
elif [[ "$DELAY" =~ ^([0-9]+)h$ ]]; then
  DELAY_SECONDS=$((${BASH_REMATCH[1]} * 3600))
else
  echo "delay must be seconds or a duration like 30s, 5m, 1h, got: $DELAY"
  exit 1
fi

TIMESTAMP=$(TZ=Asia/Bangkok date +"%Y%m%d/%H%M%S")
FILE_STAMP=$(echo "$TIMESTAMP" | tr '/' '-')
REPORT_DIR="${REPO_ROOT}/k6-reports/${TIMESTAMP}"
TIMESTAMP_FILE="${REPORT_DIR}/${FILE_STAMP}.txt"
FILE_NAME_LABEL="${TIMESTAMP}/${FILE_STAMP}.txt"

mkdir -p "$REPORT_DIR"

BUYER_COUNT=$((END_LOOP_INDEX - START_LOOP_INDEX + 1))

echo "script          : $K6_SCRIPT"
echo "wsHold          : $WS_HOLD"
echo "startLoopIndex  : $START_LOOP_INDEX"
echo "endLoopIndex    : $END_LOOP_INDEX"
echo "usernamePrefix  : $USERNAME_PREFIX"
echo "buyerCount      : $BUYER_COUNT"
echo "vus             : $BUYER_COUNT"
echo "report dir      : $REPORT_DIR"
echo "delay           : ${DELAY} (${DELAY_SECONDS}s)"
echo ""

K6_ARGS=(
  -e "BASE_URL=${BASE_URL:-https://auctlive-sit.auct.co.th/api/v1}"
  -e "WS_URL=${WS_URL:-wss://auctlive-sit.auct.co.th/api/v1/websocket}"
  -e "WS_HOLD=${WS_HOLD}"
  -e "START_LOOP_INDEX=${START_LOOP_INDEX}"
  -e "END_LOOP_INDEX=${END_LOOP_INDEX}"
  -e "USERNAME_PREFIX=${USERNAME_PREFIX}"
  -e "REPORT_DIR=${REPORT_DIR}"
  -e "REPORT_BASENAME=buyer-login-ping"
  -e "REPORT_TITLE=buyer login + ping/pong"
)

if [ -n "${USER_PICK:-}" ]; then
  K6_ARGS+=(-e "USER_PICK=${USER_PICK}")
fi

if [ -n "${EXECUTOR:-}" ]; then
  K6_ARGS+=(-e "EXECUTOR=${EXECUTOR}")
fi

if [ -n "${LOGOUT:-}" ]; then
  K6_ARGS+=(-e "LOGOUT=${LOGOUT}")
fi

if [ -n "${LOG_WS_MSG:-}" ]; then
  K6_ARGS+=(-e "LOG_WS_MSG=${LOG_WS_MSG}")
fi

if [ -n "${RETRY_DELAY_MS:-}" ]; then
  K6_ARGS+=(-e "RETRY_DELAY_MS=${RETRY_DELAY_MS}")
fi

if [ "$DELAY_SECONDS" -gt 0 ]; then
  K6_START_AT=$(TZ=Asia/Bangkok date -v+"${DELAY_SECONDS}"S +"%d/%m/%Y %H:%M:%S")
  echo "waiting ${DELAY_SECONDS}s before k6 (starts at ${K6_START_AT})"
  sleep "$DELAY_SECONDS"
fi

START_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
START_EPOCH=$(date +%s)

set +e
K6_WEB_DASHBOARD=true \
  K6_WEB_DASHBOARD_EXPORT="${REPORT_DIR}/buyer-login-ping-dashboard.html" \
  k6 run "$K6_SCRIPT" "${K6_ARGS[@]}"
K6_EXIT=$?
set -e

END_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))
HOURS=$((DURATION / 3600))
MINUTES=$(((DURATION % 3600) / 60))
SECONDS=$((DURATION % 60))
DURATION_FORMAT=$(printf "%02d:%02d:%02d" "$HOURS" "$MINUTES" "$SECONDS")

cat > "$TIMESTAMP_FILE" <<EOF
Test Execution
==================================================
File Name       : $FILE_NAME_LABEL
Scenario        : buyer login + ping/pong
WS Hold         : $WS_HOLD
Delay           : ${DELAY} (${DELAY_SECONDS}s)
Start Index     : $START_LOOP_INDEX
End Index       : $END_LOOP_INDEX
Username Prefix : $USERNAME_PREFIX
Buyer Count     : $BUYER_COUNT
Start Date Time : $START_TIME
End Date Time   : $END_TIME
Duration        : $DURATION_FORMAT
k6 exit         : $K6_EXIT
==================================================
EOF

echo ""
cat "$TIMESTAMP_FILE"
echo ""
echo "Timestamp saved to: $TIMESTAMP_FILE"
echo "Reports: ${REPORT_DIR}/buyer-login-ping.{json,html}"

exit "$K6_EXIT"
