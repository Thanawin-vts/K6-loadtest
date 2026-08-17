/**
 * k6 — admin เติมเงินหลักประกันให้ buyer
 *
 * 1. POST /auth/login  → accessToken (Bearer)
 * 2. POST /content-service/buyer/search  → userId
 * 3. POST /auction-core-service/payment/collateral-payment/manual-deposit-notification
 *    form-data: data (JSON text) + file (slip)
 *
 *   k6 run admin/deposit/k6-admin-deposit.js \
 *     -e ADMIN_USER=admin \
 *     -e ADMIN_PASSWORD=P@ssw0rd \
 *     -e KEYWORD=BIDDER001 \
 *     -e AUCTION_ID=1 \
 *     -e BUYER_BANK_ID=1 \
 *     -e BUYER_BANK_NAME='ธนาคารกรุงเทพ' \
 *     -e PAYMENT_METHOD_ID=1 \
 *     -e COUNT=1
 *
 * KEYWORD = bidderId / identificationNumber / customerNo / ชื่อ-นามสกุล
 */

import http from 'k6/http';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { check, group, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from '../../lib/k6-report.js';

const loginDuration = new Trend('login_duration_ms');
const searchDuration = new Trend('buyer_search_duration_ms');
const depositDuration = new Trend('admin_deposit_duration_ms');
const depositOk = new Counter('admin_deposit_ok');
const depositFail = new Counter('admin_deposit_fail');

const BASE_URL = (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, '');
const COUNT = Math.max(1, Number(__ENV.COUNT || 1));
const VUS = Math.max(1, Number(__ENV.VUS || 1));
const LOGIN_TYPE = __ENV.LOGIN_TYPE || 'admin';
const ADMIN_USER = __ENV.ADMIN_USER || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const TOKEN_ENV = __ENV.TOKEN || '';
const KEYWORD = String(__ENV.KEYWORD || '').trim();

const AUCTION_ID = Number(__ENV.AUCTION_ID || 0);
const EVENT_ID = __ENV.EVENT_ID ? Number(__ENV.EVENT_ID) : null;
const BUYER_BANK_ID = Number(__ENV.BUYER_BANK_ID || 0);
const BUYER_BANK_NAME = __ENV.BUYER_BANK_NAME || '';
const PAYMENT_METHOD_ID = Number(__ENV.PAYMENT_METHOD_ID || 0);
const ASSET_TYPE_ID = Number(__ENV.ASSET_TYPE_ID || 1);
const ASSET_GROUP_ID = __ENV.ASSET_GROUP_ID ? Number(__ENV.ASSET_GROUP_ID) : null;
const TOTAL_AMOUNT = Number(__ENV.TOTAL_AMOUNT || 10000);
const TOTAL_TOP_UP_CREDIT = Number(__ENV.TOTAL_TOP_UP_CREDIT || TOTAL_AMOUNT);
const TOTAL_TOP_UP_LIMIT = Number(__ENV.TOTAL_TOP_UP_LIMIT || TOTAL_AMOUNT);
const AUCTION_DATE = __ENV.AUCTION_DATE || new Date().toISOString();
const PAYMENT_DATE = __ENV.PAYMENT_DATE || new Date().toISOString();

const SEARCH_PATH = '/content-service/buyer/search';
const DEPOSIT_PATH = '/auction-core-service/payment/collateral-payment/manual-deposit-notification';

const SLIP_PNG = encoding.b64decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
);
const SLIP_BIN = __ENV.SLIP_PATH ? open(__ENV.SLIP_PATH, 'b') : SLIP_PNG;
const SLIP_NAME = __ENV.SLIP_NAME || 'slip.png';
const SLIP_TYPE = __ENV.SLIP_TYPE || 'image/png';

export const options = {
  scenarios: {
    admin_deposit: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: COUNT,
      maxDuration: '10m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.1'],
    checks: ['rate>0.9'],
    http_req_duration: ['p(95)<5000', 'p(99)<5000'],
    login_duration_ms: ['p(95)<5000', 'p(99)<5000'],
    buyer_search_duration_ms: ['p(95)<5000', 'p(99)<5000'],
    admin_deposit_duration_ms: ['p(95)<8000', 'p(99)<8000'],
  },
};

export const handleSummary = createHandleSummary(() => ({
  titleBase: 'admin deposit',
  reportDir: __ENV.REPORT_DIR || 'k6-reports',
  reportBasename: __ENV.REPORT_BASENAME || 'admin-deposit',
  meta: {
    baseUrl: BASE_URL,
    count: COUNT,
    vus: VUS,
    keyword: KEYWORD,
    auctionId: AUCTION_ID,
  },
}));

function parseBody(res) {
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return {};
  }
}

function unwrapData(body) {
  if (!body) return {};
  if (body.Data != null) return body.Data;
  if (body.data != null) return body.data;
  return body;
}

function authHeaders(token, serviceName) {
  return {
    Authorization: 'Bearer ' + token,
    'X-Service-Name': serviceName,
    'X-User-Type': LOGIN_TYPE,
  };
}

function requireEnv() {
  if (!TOKEN_ENV && (!ADMIN_USER || !ADMIN_PASSWORD)) {
    fail('need TOKEN or ADMIN_USER + ADMIN_PASSWORD');
  }
  if (!KEYWORD) fail('need KEYWORD (bidderId / identificationNumber / customerNo / name)');
  if (!AUCTION_ID) fail('need AUCTION_ID');
  if (!BUYER_BANK_ID) fail('need BUYER_BANK_ID');
  if (!BUYER_BANK_NAME) fail('need BUYER_BANK_NAME');
  if (!PAYMENT_METHOD_ID) fail('need PAYMENT_METHOD_ID');
}

function login() {
  const res = http.post(
    BASE_URL + '/auth/login',
    JSON.stringify({
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      loginType: LOGIN_TYPE,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-Type': LOGIN_TYPE,
      },
      tags: { name: 'POST /auth/login' },
    }
  );
  loginDuration.add(res.timings.duration);

  const body = parseBody(res);
  const data = unwrapData(body);
  const ok = check(res, {
    '1. login status 200': (r) => r.status === 200,
    '1. login has accessToken': () => !!data.accessToken,
  });
  if (!ok) {
    console.error(
      `[FAIL] login status=${res.status} code=${body.code} message=${body.message} body=${res.body}`
    );
    return '';
  }
  return data.accessToken;
}

function searchBuyer(token) {
  const res = http.post(
    BASE_URL + SEARCH_PATH,
    JSON.stringify({ keyword: KEYWORD }),
    {
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(token, 'content-service')),
      tags: { name: 'POST /content-service/buyer/search' },
    }
  );
  searchDuration.add(res.timings.duration);

  const body = parseBody(res);
  const data = unwrapData(body);
  const userId = data.userId != null ? Number(data.userId) : 0;
  const ok = check(res, {
    '2. search status 200': (r) => r.status === 200,
    '2. search has userId': () => userId > 0,
  });
  if (!ok) {
    console.error(
      `[FAIL] search keyword=${KEYWORD} status=${res.status} code=${body.code} message=${body.message} body=${res.body}`
    );
    return 0;
  }
  console.log(`[INFO] search.ok keyword=${KEYWORD} userId=${userId} bidderId=${data.bidderId || '-'}`);
  return userId;
}

function buildDataJson(userId, n) {
  return JSON.stringify({
    userId: userId,
    auctionDate: AUCTION_DATE,
    auctionId: AUCTION_ID,
    eventId: EVENT_ID,
    auctionAssetList: [
      {
        assetTypeId: ASSET_TYPE_ID,
        assetGroupId: ASSET_GROUP_ID,
        itemAmount: 1,
        creditUse: TOTAL_TOP_UP_CREDIT,
        creditUsePercent: 0,
        creditUseBahtAmount: TOTAL_TOP_UP_CREDIT,
        noCreditUse: false,
        minCreditRequired: 0,
        minCreditRequiredPercent: 0,
        minCreditRequiredBahtAmount: 0,
        noMinCreditRequired: true,
        topUpCredit: TOTAL_TOP_UP_CREDIT,
      },
    ],
    totalTopUpCredit: TOTAL_TOP_UP_CREDIT,
    totalTopUpAuctionSpendingLimit: TOTAL_TOP_UP_LIMIT,
    totalAmount: TOTAL_AMOUNT,
    buyerBankId: BUYER_BANK_ID,
    buyerBankName: BUYER_BANK_NAME,
    auctionPaymentMethodId: PAYMENT_METHOD_ID,
    paymentDate: PAYMENT_DATE,
    slipRef: 'K6-' + Date.now() + '-' + n,
  });
}

function createDeposit(token, userId, n) {
  const form = {
    data: buildDataJson(userId, n),
    file: http.file(SLIP_BIN, SLIP_NAME, SLIP_TYPE),
  };
  const res = http.post(BASE_URL + DEPOSIT_PATH, form, {
    headers: authHeaders(token, 'auction-core-service'),
    tags: { name: 'POST /payment/collateral-payment/manual-deposit-notification' },
  });
  depositDuration.add(res.timings.duration);

  const parsed = parseBody(res);
  const ok = check(res, {
    '3. deposit status 200': (r) => r.status === 200,
  });
  if (ok) {
    depositOk.add(1);
    console.log(
      `[OK] iter=${n} userId=${userId} auctionId=${AUCTION_ID} status=${res.status} ms=${res.timings.duration.toFixed(0)}`
    );
  } else {
    depositFail.add(1);
    console.error(
      `[FAIL] deposit iter=${n} userId=${userId} status=${res.status} code=${parsed.code} message=${parsed.message} body=${res.body}`
    );
  }
}

export default function () {
  requireEnv();
  const n = exec.scenario.iterationInTest + 1;
  let token = TOKEN_ENV;
  let userId = 0;

  group('1. login', function () {
    if (!token) token = login();
  });
  if (!token) {
    depositFail.add(1);
    return;
  }

  group('2. POST /content-service/buyer/search', function () {
    userId = searchBuyer(token);
  });
  if (!userId) {
    depositFail.add(1);
    return;
  }

  group('3. POST manual-deposit-notification (form-data)', function () {
    createDeposit(token, userId, n);
  });
}
