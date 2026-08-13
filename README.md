# k6-test

Load / smoke scripts for AUCT buyer auction join flow (login → profile → bidder number → WebSocket `visitLot` → `connected`).

For full scenario detail (API steps, metrics, logging), see [`k6-login-visit-connected.md`](./k6-login-visit-connected.md).

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed (`k6 version`)
- Network access to the target environment (default: SIT)
- Buyer accounts listed in `BUYER_USER` inside the JS script (edit before run)
- Valid `LOT_ID` that returns `bidderNumber` for those buyers

## Layout

```text
k6-test/
├── README.md                         # this file
├── k6-login-visit-connected.js       # main k6 scenario
├── k6-login-visit-connected.md       # detailed scenario docs
├── lib/
│   └── k6-report.js                  # shared JSON/HTML report helper
├── scripts/
│   └── script.sh                     # wrapper: check JS → run k6 → write timing txt
└── k6-reports/                       # generated reports (gitignored except .gitkeep)
    └── yyyyMMdd/HHmmss/
        ├── login-visit-connected.json
        ├── login-visit-connected.html
        └── yyyyMMdd-HHmmss.txt       # from script.sh only
```

## Manual usage

### Option A — run via `script.sh` (recommended)

From `k6-test/scripts/`:

```bash
cd k6-test/scripts
sh script.sh
```

What it does:

1. Resolves `../k6-login-visit-connected.js` from the script location
2. Stops with `file not found: <path>` if the JS file is missing
3. Creates `../k6-reports/yyyyMMdd/HHmmss/` (Asia/Bangkok)
4. Runs k6 with SIT defaults + `LOT_ID=975` + `REPORT_DIR` pointed at that folder
5. Writes `yyyyMMdd-HHmmss.txt` with start/end/duration and `File Name` label

Edit URLs / `LOT_ID` / env flags inside `scripts/script.sh` before running if needed.

### Option B — run k6 directly

From `k6-test/`:

```bash
cd k6-test

k6 run k6-login-visit-connected.js \
  -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
  -e WS_URL=wss://auctlive-sit.auct.co.th/api/v1/websocket \
  -e LOT_ID=975 \
  -e WS_HOLD=5m
```

Hold connection shorter / longer:

```bash
-e WS_HOLD=60s
-e WS_HOLD=10m
```

Parallel buyers (default): `VUS = BUYER_USER.length`, `USER_PICK=vu`, `EXECUTOR=per-vu`.

```bash
# override VU count / iterations
-e VUS=4 -e ITERATIONS=1

# soak mode
-e EXECUTOR=constant -e DURATION=10m -e VUS=8 -e WS_HOLD=9m

# log inbound WS messages
-e LOG_WS_MSG=true
```

Custom report folder / names:

```bash
-e REPORT_DIR=k6-reports/manual-run \
-e REPORT_BASENAME=login-visit-connected \
-e REPORT_TITLE='SIT hold WS buyers'
```

Or full path override:

```bash
-e REPORT_JSON=./out/result.json \
-e REPORT_HTML=./out/result.html
```

## Script details

### `k6-login-visit-connected.js`

Buyer flow under test (no collateral, no `offer` / `bidding`):

| Step | Action |
| --- | --- |
| 1 | `POST /auth/login` |
| 2 | `GET /users/user-profile` |
| 3 | `POST /users/lot-bidder-number` → `data.bidderNumber` |
| 4 | WS `type=visitLot` |
| 5 | WS `type=connected` |
| 6 | Hold WebSocket (`WS_HOLD`, default `5m`) and reply `ping`/`pong` |

Credentials come from in-file `BUYER_USER` array (not env `USERNAME`/`PASSWORD`).

| Env | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LOT_ID` | yes | — | Lot for bidder-number + WS `lots` |
| `BASE_URL` | no | SIT API | HTTP gateway |
| `WS_URL` | no | SIT WS | WebSocket endpoint |
| `VUS` | no | `BUYER_USER.length` | Parallel VUs |
| `ITERATIONS` | no | `1` | Iterations per VU (`per-vu`) |
| `EXECUTOR` | no | `per-vu` | `per-vu` or `constant` |
| `DURATION` | no | `30s` | Used when `EXECUTOR=constant` |
| `USER_PICK` | no | `vu` | `vu` (sticky) or `round` |
| `WS_TIMEOUT_MS` | no | `15000` | Join timeout before connected |
| `JOIN_SETTLE_MS` | no | `1000` | Settle wait after `connected` |
| `WS_HOLD` / `WS_HOLD_MS` | no | `5m` | Keep WS open after join |
| `LOG_WS_MSG` | no | `false` | Log inbound WS (except ping) |
| `REPORT_DIR` | no | `k6-reports` | Report root |
| `REPORT_BASENAME` | no | `login-visit-connected` | JSON/HTML basename |
| `REPORT_TITLE` | no | scenario title | HTML/JSON title base |
| `REPORT_JSON` / `REPORT_HTML` | no | auto | Full path override |

### `lib/k6-report.js`

Shared `handleSummary` helper used by the scenario:

```js
import { createHandleSummary } from './lib/k6-report.js';

export const handleSummary = createHandleSummary(() => ({
  titleBase: '…',
  reportDir: __ENV.REPORT_DIR || 'k6-reports',
  reportBasename: 'login-visit-connected',
  meta: { /* scenario fields */ },
}));
```

Writes:

- `{REPORT_DIR}/{REPORT_BASENAME}.json` — meta + full k6 summary
- `{REPORT_DIR}/{REPORT_BASENAME}.html` — HTML report
- stdout text summary

When used with `script.sh`, `REPORT_DIR` is already `../k6-reports/yyyyMMdd/HHmmss`, so JSON/HTML land in that timestamp folder.

### `scripts/script.sh`

Bash wrapper around the scenario.

| Behavior | Detail |
| --- | --- |
| Pre-check | Exit `1` + `file not found: …` if JS missing |
| Timezone | `Asia/Bangkok` for folder / stamps |
| Report dir | `../k6-reports/yyyyMMdd/HHmmss` (relative to cwd when you run from `scripts/`) |
| Timing file | `yyyyMMdd-HHmmss.txt` in the same folder |
| File Name label | `yyyyMMdd/HHmmss/yyyyMMdd-HHmmss.txt` (path under `k6-reports`) |

Example timing file:

```text
Test Execution
==================================================
File Name       : 20260813/070303/20260813-070303.txt
Start Date Time : 13/08/2026 07:03:03
End Date Time   : 13/08/2026 07:03:11
Duration        : 00:00:08
==================================================
```

Default env passed to k6 (edit in the shell script to change):

- `BASE_URL` / `WS_URL` → SIT
- `LOGIN_TYPE=buyer`
- `LOT_ID=975`
- `REPORT_DIR` → timestamp folder above

## Reports

Typical output after `script.sh`:

```text
k6-reports/
└── 20260813/
    └── 070303/
        ├── 20260813-070303.txt
        ├── login-visit-connected.json
        └── login-visit-connected.html
```

Generated files under `k6-reports/` are ignored by git (see `k6-reports/.gitignore`).

## Notes

- This scenario does **not** call collateral or send bid (`offer` / `bidding`).
- Prefer `per-vu` + `ITERATIONS=1` + long `WS_HOLD` when the goal is “all buyers stay connected”.
- Login `E2001` usually means wrong credentials / `loginType` for that environment — fix `BUYER_USER`.
- Run `script.sh` from `k6-test/scripts/` so `REPORT_DIR=../k6-reports/...` resolves correctly.
