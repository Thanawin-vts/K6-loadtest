#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/../k6-login.js"

if [ ! -f "$K6_SCRIPT" ]; then
  echo "file not found: $K6_SCRIPT"
  exit 1
fi

TIMESTAMP=$(TZ=Asia/Bangkok date +"%Y%m%d/%H%M%S")
FILE_STAMP=$(echo "$TIMESTAMP" | tr '/' '-')
REPORT_DIR="../k6-reports/${TIMESTAMP}"
TIMESTAMP_FILE="${REPORT_DIR}/${FILE_STAMP}.txt"
FILE_NAME_LABEL="${TIMESTAMP}/${FILE_STAMP}.txt"

mkdir -p "$REPORT_DIR"

START_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
START_EPOCH=$(date +%s) 

echo "Report directory : $REPORT_DIR"
echo "Start Date Time  : $START_TIME"

k6 run "$K6_SCRIPT" \
  -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
  -e WS_URL=wss://auctlive-sit.auct.co.th/api/v1/websocket \
  -e LOGIN_TYPE=buyer \
  -e REPORT_DIR="$REPORT_DIR" \
  -e LOT_ID=975

END_TIME=$(TZ=Asia/Bangkok date +"%d/%m/%Y %H:%M:%S")
END_EPOCH=$(date +%s)

# Calculate duration
DURATION=$((END_EPOCH - START_EPOCH))

HOURS=$((DURATION / 3600))
MINUTES=$(((DURATION % 3600) / 60))
SECONDS=$((DURATION % 60))

DURATION_FORMAT=$(printf "%02d:%02d:%02d" \
  "$HOURS" \
  "$MINUTES" \
  "$SECONDS")

# Create timestamp report
cat > "$TIMESTAMP_FILE" <<EOF
Test Execution
==================================================
File Name       : $FILE_NAME_LABEL
Start Date Time : $START_TIME
End Date Time   : $END_TIME
Duration        : $DURATION_FORMAT
==================================================
EOF

echo ""
cat "$TIMESTAMP_FILE"
echo ""
echo "Timestamp saved to: $TIMESTAMP_FILE"