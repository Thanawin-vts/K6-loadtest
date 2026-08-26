#!/bin/bash
#
# usage:
#   ./gen-buyer-script.sh <count> [start] [prefixUser] [prefixEmail] [prefixPhone] [firstName] [lastName]
#
# example:
#   ./gen-buyer-script.sh 10
#   → 10 users start at 01: loadtestuser01 .. loadtestuser10
#     email loadtest01@gmail.com  phone 0999900001
#
#   ./gen-buyer-script.sh 10 21
#   → 10 users start at 21: loadtestuser21 .. loadtestuser30
#
#   ./gen-buyer-script.sh 5 1 k6buyer k6mail 08888 K6First K6Last
#   → 5 users: k6buyer01 .. k6buyer05
#     email k6mail01@gmail.com  phone 0888800001
#     firstName=K6First  lastName=K6Last
#

set -e

if [ "$#" -lt 1 ] || [ "$#" -gt 7 ]; then
  echo "usage: $0 <count> [start] [prefixUser] [prefixEmail] [prefixPhone] [firstName] [lastName]"
  echo "example: $0 10"
  echo "example: $0 10 21"
  echo "example: $0 5 1 k6buyer k6mail 08888 K6First K6Last"
  exit 1
fi

COUNT="$1"
START="${2:-1}"
PREFIXUSER="${3:-loadtestuser}"
PREFIXEMAIL="${4:-loadtest}"
PREFIXPHONE="${5:-09999}"
FIRSTNAME="${6:-โหลดเทส}"
LASTNAME="${7:-บายเยอร์}"
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
echo "prefix user : $PREFIXUSER"
echo "prefix email : $PREFIXEMAIL"
echo "prefix phone : $PREFIXPHONE"
echo "first name : $FIRSTNAME"
echo "last name : $LASTNAME"
echo "script : $K6_SCRIPT"
echo ""

k6 run "$K6_SCRIPT" \
  -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
  -e COUNT="$COUNT" \
  -e START="$START" \
  -e PREFIXUSER="$PREFIXUSER" \
  -e PREFIXEMAIL="$PREFIXEMAIL" \
  -e PREFIXPHONE="$PREFIXPHONE" \
  -e FIRSTNAME="$FIRSTNAME" \
  -e LASTNAME="$LASTNAME"