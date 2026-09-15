import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { generateEnterpriseHtmlReport } from '../lib/enterprise-html-report.js';

// Custom Trend and Counter metrics (demonstrating both HTTP & WebSocket tracking)
const wsAckDuration = new Trend('ws_ack_duration_ms', true);
const wsBiddingSent = new Counter('ws_bidding_sent');
const wsAckOk = new Counter('ws_ack_ok');
const wsAckTimeout = new Counter('ws_ack_timeout');

export const options = {
  scenarios: {
    // Scenario 1: Buyer Flow (Ramping VUs)
    buyer_flow: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5s', target: 10 },
        { duration: '10s', target: 10 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '2s',
      tags: { scenario: 'buyer_flow' },
    },
    // Scenario 2: Admin Flow (Constant VUs)
    admin_flow: {
      executor: 'constant-vus',
      vus: 2,
      duration: '15s',
      gracefulStop: '2s',
      tags: { scenario: 'admin_flow' },
    },
  },
  thresholds: {
    // Global SLAs
    http_req_failed: ['rate<0.05'], // Error rate under 5%
    http_req_duration: ['p(95)<2000'], // p95 response time under 2000ms
    'http_req_duration{name:POST /auth/login}': ['p(95)<1500'],
    'http_req_duration{name:POST /bidding/bid}': ['p(95)<1000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://test.k6.io';

export default function () {
  const scenarioName = __ENV.SCENARIO || (__VU % 2 === 0 ? 'admin_flow' : 'buyer_flow');

  if (scenarioName === 'buyer_flow') {
    runBuyerFlow();
  } else {
    runAdminFlow();
  }

  sleep(0.5);
}

function runBuyerFlow() {
  const tags = { scenario: 'buyer_flow' };

  // Step 1: Login
  const loginRes = http.post(
    `${BASE_URL}/login.php`,
    { login: 'buyer_user', password: 'secret_password' },
    {
      tags: Object.assign({}, tags, { name: 'POST /auth/login' }),
    }
  );

  check(loginRes, {
    'login status is 200': (r) => r.status === 200,
  });

  sleep(0.3);

  // Step 2: Query Available Lots
  const lotsRes = http.get(`${BASE_URL}/contacts.php`, {
    tags: Object.assign({}, tags, { name: 'GET /lots/active' }),
  });

  check(lotsRes, {
    'lots status is 200': (r) => r.status === 200,
  });

  sleep(0.2);

  // Step 3: Place Bid
  const bidRes = http.post(
    `${BASE_URL}/news.php`,
    { lotId: 975, amount: 25000 },
    {
      tags: Object.assign({}, tags, { name: 'POST /bidding/bid' }),
    }
  );

  check(bidRes, {
    'bid status is 200': (r) => r.status === 200,
  });

  // Step 4: Simulated WebSocket ACK operation
  wsBiddingSent.add(1);
  const simulatedLatency = 45 + Math.random() * 80;
  wsAckDuration.add(simulatedLatency);

  if (Math.random() < 0.03) {
    wsAckTimeout.add(1); // 3% simulated timeout
  } else {
    wsAckOk.add(1);
  }
}

function runAdminFlow() {
  const tags = { scenario: 'admin_flow' };

  // Admin Dashboard View
  const dashRes = http.get(`${BASE_URL}/`, {
    tags: Object.assign({}, tags, { name: 'GET /admin/dashboard' }),
  });

  check(dashRes, {
    'admin dash status is 200': (r) => r.status === 200,
  });

  sleep(0.5);

  // Admin Monitor Lots
  const monitorRes = http.get(`${BASE_URL}/contacts.php`, {
    tags: Object.assign({}, tags, { name: 'GET /admin/lots/monitor' }),
  });

  check(monitorRes, {
    'admin monitor status is 200': (r) => r.status === 200,
  });
}

/**
 * Custom handleSummary function compiling Single-File HTML Enterprise Dashboard
 */
export function handleSummary(data) {
  const reportDir = __ENV.REPORT_DIR || 'k6-reports';
  const reportBasename = __ENV.REPORT_BASENAME || 'enterprise-performance-dashboard';
  const htmlPath = `${reportDir}/${reportBasename}.html`;
  const jsonPath = `${reportDir}/${reportBasename}.json`;

  const reportTitle = __ENV.REPORT_TITLE || 'AUCT Performance Test — Enterprise Dashboard';
  const slaThresholdMs = Number(__ENV.SLA_THRESHOLD_MS || 2000);

  // Generate modern Single-File HTML Report
  const htmlContent = generateEnterpriseHtmlReport(data, {
    title: reportTitle,
    slaThresholdMs: slaThresholdMs,
  });

  console.log(`[REPORT] Single-File HTML Dashboard generated: ${htmlPath}`);

  return {
    stdout: `\n✓ Test run complete. Open report: ${htmlPath}\n`,
    [htmlPath]: htmlContent,
    [jsonPath]: JSON.stringify(data, null, 2),
  };
}

