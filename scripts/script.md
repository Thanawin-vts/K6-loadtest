# script.sh

Bash wrapper for running [`k6-login-visit-connected.js`](../k6-login-visit-connected.js) with a timestamped report folder and a timing summary file.

Related docs:

- [`../README.md`](../README.md) — k6-test overview
- [`../k6-login-visit-connected.md`](../k6-login-visit-connected.md) — scenario detail

## Purpose

1. Verify the k6 JS file exists before starting
2. Create a Bangkok-timezone report directory under `k6-reports`
3. Run the login → visitLot → connected scenario against SIT defaults
4. Write a `Test Execution` timing text file after k6 finishes

## Prerequisites

- `k6` installed and on `PATH`
- File present: `k6-test/k6-login-visit-connected.js`
- Network access to the target environment
- Valid buyers in `BUYER_USER` inside the JS script
- Valid `LOT_ID` (default in this wrapper: `975`)

## How to run

Run from `k6-test/scripts/` so relative `REPORT_DIR=../k6-reports/...` resolves correctly:

```bash
cd k6-test/scripts
sh script.sh
```

Or:

```bash
bash script.sh
```

## Flow

```text
start
  │
  ├─ resolve SCRIPT_DIR / K6_SCRIPT
  ├─ if JS missing → log "file not found: …" → exit 1
  │
  ├─ TIMESTAMP = Asia/Bangkok yyyyMMdd/HHmmss
  ├─ FILE_STAMP = yyyyMMdd-HHmmss
  ├─ mkdir ../k6-reports/${TIMESTAMP}
  │
  ├─ record START_TIME / START_EPOCH
  ├─ k6 run … -e REPORT_DIR=… -e LOT_ID=…
  │
  ├─ record END_TIME / END_EPOCH
  ├─ compute Duration HH:MM:SS
  └─ write ${FILE_STAMP}.txt → print to stdout
```

## Variables set by the script

| Variable | Example | Meaning |
| --- | --- | --- |
| `SCRIPT_DIR` | absolute path of `scripts/` | Base for resolving the JS file |
| `K6_SCRIPT` | `…/k6-test/k6-login-visit-connected.js` | Scenario path (independent of cwd for the check / `k6 run`) |
| `TIMESTAMP` | `20260813/070303` | Report subfolder under `k6-reports` |
| `FILE_STAMP` | `20260813-070303` | Timing txt basename (`/` → `-`) |
| `REPORT_DIR` | `../k6-reports/20260813/070303` | Passed to k6 as `-e REPORT_DIR` |
| `TIMESTAMP_FILE` | `…/20260813-070303.txt` | Timing summary path |
| `FILE_NAME_LABEL` | `20260813/070303/20260813-070303.txt` | Value under `File Name` in the txt |

Timezone for folder / display stamps: `Asia/Bangkok`.

## Env passed to k6

Hardcoded in `script.sh` today:

| `-e` | Value |
| --- | --- |
| `BASE_URL` | `https://auctlive-sit.auct.co.th/api/v1` |
| `WS_URL` | `wss://auctlive-sit.auct.co.th/api/v1/websocket` |
| `LOGIN_TYPE` | `buyer` |
| `REPORT_DIR` | `$REPORT_DIR` (timestamp folder above) |
| `LOT_ID` | `975` |

Other scenario options (`WS_HOLD`, `VUS`, `LOG_WS_MSG`, …) use JS defaults unless you add more `-e` lines in `script.sh`.

See [`../k6-login-visit-connected.md`](../k6-login-visit-connected.md) for the full env list.

## Outputs

### Directory layout

When run from `k6-test/scripts/`:

```text
k6-test/k6-reports/
└── yyyyMMdd/
    └── HHmmss/
        ├── yyyyMMdd-HHmmss.txt          # from script.sh
        ├── yyyyMMdd-HHmmss.txt          # from script.sh (timing + CPU/RAM summary)
        ├── resources-metrics.csv        # detailed 1s CPU/RAM time-series
        ├── login-visit-connected.json   # from k6 handleSummary
        └── login-visit-connected.html   # from k6 handleSummary
```

JSON/HTML are produced by [`../lib/k6-report.js`](../lib/k6-report.js) into `REPORT_DIR`.
`resources-metrics.csv` and CPU/RAM summary are produced by [`./monitor-resources.sh`](./monitor-resources.sh).

### Timing file (`yyyyMMdd-HHmmss.txt`)
### Timing & Resource summary file (`yyyyMMdd-HHmmss.txt`)

```text
Test Execution
==================================================
File Name       : 20260813/070303/20260813-070303.txt
Start Date Time : 13/08/2026 07:03:03
End Date Time   : 13/08/2026 07:03:11
Duration        : 00:00:08
File Name       : 20260905/001500/20260905-001500.txt
Start Date Time : 05/09/2026 00:15:00
End Date Time   : 05/09/2026 00:15:30
Duration        : 00:00:30
--------------------------------------------------
System Resource Usage (Client / Load Generator):
Host Total RAM  : 32.00 GB
Host Peak Load  : 1.93 (1m load avg)
Host Peak CPU   : 16.0%
k6 Process CPU  : Max 45.2% | Avg 22.1%
k6 Process RAM  : Max 180.5 MB | Avg 152.0 MB
Status          : NORMAL (No client bottleneck detected)
==================================================
Detailed CSV    : resources-metrics.csv
```

| Field | Meaning |
| --- | --- |
| `File Name` | Path after `k6-reports/` through the txt filename |
| `Start Date Time` | Before `k6 run` (`dd/mm/yyyy HH:MM:SS`, Bangkok) |
| `End Date Time` | After `k6 run` finishes |
| `Duration` | Wall clock `HH:MM:SS` (`END_EPOCH - START_EPOCH`) |
| `Host Total RAM` | Total physical RAM of the runner machine |
| `Host Peak Load` | Max 1-minute load average observed during test |
| `Host Peak CPU` | Max CPU utilization % across the host machine |
| `k6 Process CPU` | Max and Average CPU % used by k6 process |
| `k6 Process RAM` | Max and Average RSS Memory (MB) used by k6 process |
| `Status` | `NORMAL` or `WARNING` if host/k6 CPU >= 90% (bottleneck alert) |

## Pre-check behavior

If the JS file is missing:

```text
file not found: /absolute/path/to/k6-login-visit-connected.js
```

Exit code: `1`  
No report directory is created in that case (check runs before `mkdir`).

## Customize

Edit `script.sh` to change:

- Target URLs (`BASE_URL`, `WS_URL`)
- `LOT_ID`
- Extra k6 flags, e.g. `-e WS_HOLD=10m`, `-e LOG_WS_MSG=true`
- Report root if you do not want `../k6-reports`

Example addition:

```bash
k6 run "$K6_SCRIPT" \
  -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
  -e WS_URL=wss://auctlive-sit.auct.co.th/api/v1/websocket \
  -e LOGIN_TYPE=buyer \
  -e REPORT_DIR="$REPORT_DIR" \
  -e LOT_ID=975 \
  -e WS_HOLD=10m
```

## Notes

- `K6_SCRIPT` is absolute (via `SCRIPT_DIR`), so the JS existence check works even if you invoke the shell from another directory — but `REPORT_DIR` is relative (`../k6-reports/...`), so prefer running from `k6-test/scripts/`.
- Duration includes full k6 runtime (including `WS_HOLD` connection hold).
- Buyers / passwords are configured in the JS `BUYER_USER` array, not in this shell script.
