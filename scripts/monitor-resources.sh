#!/bin/bash
#
# scripts/monitor-resources.sh
#
# Lightweight CPU and RAM resource monitor for k6 load test runner.
# Supports both macOS and Linux.
#
# Can be used in two ways:
# 1. Sourced in bash scripts (e.g., script.sh):
#      source "${SCRIPT_DIR}/monitor-resources.sh"
#      k6 run ... &
#      K6_PID=$!
#      start_resource_monitor "$K6_PID" "$REPORT_DIR"
#      wait "$K6_PID"
#      RESOURCE_SUMMARY=$(stop_resource_monitor "$REPORT_DIR")
#
# 2. Standalone wrapper:
#      ./scripts/monitor-resources.sh -d <report_dir> k6 run ...
#

MONITOR_PID=""
MONITOR_CSV=""
MONITOR_REPORT_DIR=""
MONITOR_TARGET_PID=""

# Detect OS
get_os_type() {
  uname -s
}

# Total Host RAM formatted string (e.g. 32.00 GB)
get_host_total_ram() {
  local os_type
  os_type=$(get_os_type)
  if [ "$os_type" = "Darwin" ]; then
    local total_bytes
    total_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    awk -v b="$total_bytes" 'BEGIN { printf "%.2f GB", b / (1024*1024*1024) }'
  else
    local total_kb
    total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    awk -v kb="$total_kb" 'BEGIN { printf "%.2f GB", kb / (1024*1024) }'
  fi
}

# Background sampler loop
_resource_sampler_loop() {
  local target_pid="$1"
  local csv_file="$2"
  local interval="${3:-1}"
  local os_type
  os_type=$(get_os_type)

  # Write CSV header
  echo "timestamp,k6_cpu_pct,k6_ram_mb,host_cpu_pct,host_load_1m" > "$csv_file"

  # Trap TERM/INT to exit cleanly
  trap 'exit 0' SIGTERM SIGINT

  while kill -0 "$target_pid" 2>/dev/null; do
    local now
    now=$(date +"%Y-%m-%d %H:%M:%S")

    # Target process stats (k6)
    local ps_out
    ps_out=$(ps -p "$target_pid" -o %cpu=,rss= 2>/dev/null || true)
    if [ -z "$ps_out" ]; then
      break
    fi

    local k6_cpu
    local k6_rss_kb
    k6_cpu=$(echo "$ps_out" | awk '{print $1}')
    k6_rss_kb=$(echo "$ps_out" | awk '{print $2}')
    local k6_ram_mb
    k6_ram_mb=$(awk -v kb="$k6_rss_kb" 'BEGIN { printf "%.2f", kb / 1024 }')

    # Host stats
    local host_cpu="0.0"
    local host_load="0.00"

    if [ "$os_type" = "Darwin" ]; then
      # macOS via iostat (wait 1s naturally for CPU sample)
      local io_line
      io_line=$(iostat -c 2 -w 1 2>/dev/null | tail -n 1)
      if [ -n "$io_line" ]; then
        host_cpu=$(echo "$io_line" | awk '{printf "%.1f", $4 + $5}')
        host_load=$(echo "$io_line" | awk '{print $7}')
      fi
    else
      # Linux host load
      if [ -f /proc/loadavg ]; then
        host_load=$(awk '{print $1}' /proc/loadavg)
      fi

      # Linux CPU via /proc/stat
      if [ -f /proc/stat ]; then
        read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
        local total1=$((user + nice + system + idle + iowait + irq + softirq + steal))
        local work1=$((user + nice + system + irq + softirq + steal))
        sleep "$interval"
        read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
        local total2=$((user + nice + system + idle + iowait + irq + softirq + steal))
        local work2=$((user + nice + system + irq + softirq + steal))
        local dtotal=$((total2 - total1))
        local dwork=$((work2 - work1))
        if [ "$dtotal" -gt 0 ]; then
          host_cpu=$(awk -v w="$dwork" -v t="$dtotal" 'BEGIN { printf "%.1f", (w / t) * 100 }')
        fi
      else
        sleep "$interval"
      fi
    fi

    echo "${now},${k6_cpu},${k6_ram_mb},${host_cpu},${host_load}" >> "$csv_file"
  done
}

# Start monitoring a background PID
start_resource_monitor() {
  local target_pid="$1"
  local report_dir="$2"
  local interval="${3:-1}"

  if [ -z "$target_pid" ] || ! kill -0 "$target_pid" 2>/dev/null; then
    echo "[MONITOR] Warning: Invalid target PID '$target_pid' to monitor."
    return 1
  fi

  MONITOR_TARGET_PID="$target_pid"
  MONITOR_REPORT_DIR="${report_dir:-.}"
  mkdir -p "$MONITOR_REPORT_DIR"
  MONITOR_CSV="${MONITOR_REPORT_DIR}/resources-metrics.csv"

  _resource_sampler_loop "$target_pid" "$MONITOR_CSV" "$interval" &
  MONITOR_PID=$!
  echo "[MONITOR] Resource monitoring started for PID $target_pid (Sampler PID: $MONITOR_PID)"
}

# Stop monitoring and generate report summary
stop_resource_monitor() {
  local report_dir="${1:-$MONITOR_REPORT_DIR}"
  local csv_file="${report_dir}/resources-metrics.csv"

  if [ -n "$MONITOR_PID" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
    MONITOR_PID=""
  fi

  format_resource_summary "$report_dir"
}

# Format summary from collected CSV
format_resource_summary() {
  local report_dir="${1:-$MONITOR_REPORT_DIR}"
  local csv_file="${report_dir}/resources-metrics.csv"
  local total_ram
  total_ram=$(get_host_total_ram)

  if [ ! -f "$csv_file" ]; then
    cat <<EOF
System Resource Usage (Client / Load Generator):
Host Total RAM  : ${total_ram}
Status          : No resource metrics collected
EOF
    return 0
  fi

  awk -F',' -v total_ram="$total_ram" '
  NR > 1 {
    cpu = $2 + 0;
    ram = $3 + 0;
    host_cpu = $4 + 0;
    host_load = $5 + 0;

    if (cpu > max_cpu) max_cpu = cpu;
    sum_cpu += cpu;

    if (ram > max_ram) max_ram = ram;
    sum_ram += ram;

    if (host_cpu > max_host_cpu) max_host_cpu = host_cpu;
    sum_host_cpu += host_cpu;

    if (host_load > max_host_load) max_host_load = host_load;

    count++;
  }
  END {
    print "--------------------------------------------------"
    print "System Resource Usage (Client / Load Generator):"
    printf "Host Total RAM  : %s\n", total_ram
    if (count > 0) {
      printf "Host Peak Load  : %.2f (1m load avg)\n", max_host_load
      printf "Host Peak CPU   : %.1f%%\n", max_host_cpu
      printf "k6 Process CPU  : Max %.1f%% | Avg %.1f%%\n", max_cpu, sum_cpu / count
      printf "k6 Process RAM  : Max %.1f MB | Avg %.1f MB\n", max_ram, sum_ram / count

      # Bottleneck check
      if (max_cpu >= 90.0 || max_host_cpu >= 90.0) {
        print "Status          : WARNING (High CPU load >= 90%, load generator may be bottlenecked)"
      } else {
        print "Status          : NORMAL (No client bottleneck detected)"
      }
    } else {
      print "Samples         : 0 (Test ended before first 1s sample)"
      print "Status          : NORMAL"
    }
    print "=================================================="
    print "Detailed CSV    : resources-metrics.csv"
  }' "$csv_file"
}

# Standalone execution
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  STANDALONE_REPORT_DIR="."
  while getopts "d:" opt; do
    case "$opt" in
      d) STANDALONE_REPORT_DIR="$OPTARG" ;;
      *) echo "Usage: $0 [-d <report_dir>] <command> [args...]"; exit 1 ;;
    esac
  done
  shift $((OPTIND - 1))

  if [ "$#" -eq 0 ]; then
    echo "Usage: $0 [-d <report_dir>] <command> [args...]"
    exit 1
  fi

  "$@" &
  CMD_PID=$!
  start_resource_monitor "$CMD_PID" "$STANDALONE_REPORT_DIR"
  wait "$CMD_PID"
  CMD_EXIT=$?
  SUMMARY=$(stop_resource_monitor "$STANDALONE_REPORT_DIR")
  echo ""
  echo "$SUMMARY"
  exit $CMD_EXIT
fi

