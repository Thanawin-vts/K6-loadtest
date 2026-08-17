/**
 * k6 — loop POST /register/buyer/create
 *
 *   ./gen-buyer-script.sh 10
 *   ./gen-buyer-script.sh 10 21
 *   k6 run k6-buyer-register.js -e COUNT=10 -e START=21
 *
 * COUNT = number of create loops
 * START = first user number (default 1)
 *   COUNT=10 START=21 → loadtestuser21 .. loadtestuser30
 *   username : loadtestuser<2 digit>
 *   email    : loadtest<2 digit>@gmail.com
 *   phone    : 09999<5 digit>
 *   idNo     : thaiIdGen()
 * Retry E1010 (Duplicate identification number) with a new idNo until 200.
 */

import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from '../../lib/k6-report.js';
import { buyerData } from './buyer-register-data.js';
import { thaiIdGen } from '../../lib/thai-id-gen.js';

const createDuration = new Trend('buyer_create_duration_ms');
const createOk = new Counter('buyer_create_ok');
const createFail = new Counter('buyer_create_fail');

const BASE_URL = (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, '');
const COUNT = Math.max(1, Number(__ENV.COUNT || 1));
const START = Math.max(1, Number(__ENV.START || 1));
const VUS = Math.max(1, Number(__ENV.VUS || 1));

export const options = {
  scenarios: {
    buyer_register: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: COUNT,
      maxDuration: '30m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.3'],
    checks: ['rate>0.7'],
  },
};

export const handleSummary = createHandleSummary(() => ({
  titleBase: 'buyer register loop',
  reportDir: __ENV.REPORT_DIR || 'k6-reports',
  reportBasename: __ENV.REPORT_BASENAME || 'buyer-register',
  meta: { baseUrl: BASE_URL, count: COUNT, start: START, vus: VUS },
}));

function pad(n, width) {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function parseBody(res) {
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return {};
  }
}

function isDuplicateId(res, parsed) {
  return res.status === 409 && parsed.code === 'E1010';
}

export default function () {
  const count = START + exec.scenario.iterationInTest;
  const username = `loadtestuser${pad(count, 2)}`;
  const email = `loadtest${pad(count, 2)}@gmail.com`;
  const phone = `09999${pad(count, 5)}`;
  const url = `${BASE_URL}/register/buyer/create`;
  const reqParams = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'POST /register/buyer/create', username },
    responseCallback: http.expectedStatuses(200, 409),
  };

  let attempt = 0;
  let res;
  let parsed = {};
  let body;

  while (true) {
    attempt += 1;
    body = buyerData(username, email, phone, thaiIdGen());
    res = http.post(url, JSON.stringify(body), reqParams);
    createDuration.add(res.timings.duration);
    parsed = parseBody(res);

    if (res.status === 200) {
      break;
    }

    if (isDuplicateId(res, parsed)) {
      console.log(
        `[RETRY] vu=${__VU} iter=${count} attempt=${attempt} user=${username} id=${body.identificationNumber} code=E1010`
      );
      continue;
    }

    break;
  }

  const ok = check(res, {
    'create status 200': (r) => r.status === 200,
  });

  if (ok) {
    createOk.add(1);
    console.log(
      `[OK] vu=${__VU} iter=${count} attempt=${attempt} user=${body.username} email=${body.email} phone=${body.phoneNumber} id=${body.identificationNumber} status=${res.status} ms=${res.timings.duration.toFixed(0)} data=${JSON.stringify(parsed.data)}`
    );
  } else {
    createFail.add(1);
    console.error(
      `[FAIL] vu=${__VU} iter=${count} attempt=${attempt} user=${body.username} email=${body.email} phone=${body.phoneNumber} id=${body.identificationNumber} status=${res.status} code=${parsed.code} message=${parsed.message} body=${res.body}`
    );
  }
}
