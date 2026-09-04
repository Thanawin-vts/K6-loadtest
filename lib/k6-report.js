/**
 * Shared k6 JSON + HTML report helpers
 *
 * Env:
 *   REPORT_DIR=k6-reports
 *   REPORT_BASENAME=<name>
 *   REPORT_TITLE=<title base>
 *   REPORT_JSON / REPORT_HTML  — optional full path override
 *
 * Output default:
 *   {REPORT_DIR}/yyyyMMdd/HH-mm-ss/{REPORT_BASENAME}.json|html
 * Title:
 *   {REPORT_TITLE} — yyyy/MM/dd HH:mm:ss
 */

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/3.0.4/dist/bundle.js';

export function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** yyyy/MM/dd HH:mm:ss */
export function formatReportTitleStamp(now) {
  const d = now || new Date();
  return (
    d.getFullYear() +
    '/' +
    pad2(d.getMonth() + 1) +
    '/' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds())
  );
}

/**
 * โครงสร้างโฟลเดอร์รายงาน: yyyyMMdd/HH-mm-ss
 * @param {Date} [now]
 * @param {{ reportDir?: string, reportBasename?: string }} [options]
 */
export function buildReportPaths(now, options) {
  const opts = options || {};
  const reportDir = opts.reportDir || __ENV.REPORT_DIR || 'k6-reports';
  const reportBasename = opts.reportBasename || __ENV.REPORT_BASENAME || 'k6-summary';
  const d = now || new Date();
  const yyyyMMdd = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  const HHmmss = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());

  return {
    dir: reportDir,
    date: yyyyMMdd,
    time: HHmmss,
    json: __ENV.REPORT_JSON || reportDir + '/' + reportBasename + '.json',
    html: __ENV.REPORT_HTML || reportDir + '/' + reportBasename + '.html',
  };
}

function metricBaseName(name) {
  const s = String(name || '');
  const i = s.indexOf('{');
  return i >= 0 ? s.slice(0, i) : s;
}

function metricAllowed(name, allowExact, prefixes) {
  const base = metricBaseName(name);
  if (allowExact[name] || allowExact[base]) return true;
  for (let i = 0; i < prefixes.length; i++) {
    if (base.indexOf(prefixes[i]) === 0) return true;
  }
  return false;
}

function filterRootGroupForReport(group, opts) {
  if (!group) {
    return {
      name: '',
      path: '',
      id: 'd41d8cd98f00b204e9800998ecf8427e',
      groups: [],
      checks: [],
    };
  }
  const checkNameRe = opts.checkNameRe || null;
  const dropVuComplete = opts.dropVuComplete !== false;
  const checks = [];
  const rawChecks = group.checks || [];
  for (let i = 0; i < rawChecks.length; i++) {
    const c = rawChecks[i];
    const name = c && c.name ? String(c.name) : '';
    if (dropVuComplete && name.indexOf('__vu_complete__') === 0) continue;
    if (checkNameRe && !checkNameRe.test(name)) continue;
    checks.push(c);
  }
  return {
    name: group.name || '',
    path: group.path || '',
    id: group.id || 'd41d8cd98f00b204e9800998ecf8427e',
    groups: [],
    checks: checks,
  };
}

/**
 * กรอง k6 summary ให้เหลือเฉพาะ metrics ที่ต้องการ (ใช้กับ JSON/HTML report)
 *
 * @param {object} data handleSummary data
 * @param {{
 *   metricNames?: string[],
 *   metricPrefixes?: string[],
 *   keepContextMetrics?: boolean,
 *   checkNameRe?: RegExp,
 *   dropVuComplete?: boolean,
 * }} [options]
 */
export function filterSummaryData(data, options) {
  const opts = options || {};
  const metricNames = opts.metricNames || [];
  const metricPrefixes = opts.metricPrefixes || [];
  const allowExact = {};
  for (let i = 0; i < metricNames.length; i++) {
    allowExact[metricNames[i]] = true;
  }
  if (opts.keepContextMetrics !== false) {
    allowExact.vus = true;
    allowExact.vus_max = true;
    allowExact.iterations = true;
  }

  const srcMetrics = (data && data.metrics) || {};
  const filteredMetrics = {};
  const keys = Object.keys(srcMetrics);
  for (let k = 0; k < keys.length; k++) {
    const name = keys[k];
    if (metricAllowed(name, allowExact, metricPrefixes)) {
      filteredMetrics[name] = srcMetrics[name];
    }
  }

  const srcThresholds = (data && data.thresholds) || {};
  const filteredThresholds = {};
  const tKeys = Object.keys(srcThresholds);
  for (let t = 0; t < tKeys.length; t++) {
    const tName = tKeys[t];
    if (metricAllowed(tName, allowExact, metricPrefixes)) {
      filteredThresholds[tName] = srcThresholds[tName];
    }
  }

  return Object.assign({}, data || {}, {
    metrics: filteredMetrics,
    thresholds: filteredThresholds,
    root_group: filterRootGroupForReport(data && data.root_group, opts),
  });
}

/** allowlist สำหรับ phase bidding ของ buyer bidding scripts */
export const BIDDING_REPORT_METRICS = [
  'ws_bidding_sent',
  'ws_ack_ok',
  'ws_ack_retry',
  'ws_ack_timeout',
  'ws_reconnect',
  'ws_reconnect_gave_up',
];

/**
 * สร้าง handleSummary ที่ reuse ได้
 *
 * @param {object|function} configOrFactory
 *   - titleBase / reportDir / reportBasename
 *   - meta: object เพิ่มใน JSON (หรือ factory คืน object เหล่านี้)
 *   - extraStdout: string ต่อหน้า text summary ใน terminal
 *   - extraFiles: { [path]: stringContents } เขียนไฟล์เพิ่มตอนจบเทส
 *   - reportData: summary object สำหรับ JSON/HTML (ถ้าไม่ใส่ใช้ data เต็ม)
 *   - metricNames / metricPrefixes / checkNameRe: กรอง metrics ใน JSON/HTML
 * @returns {(data: object) => object}
 *
 * ตัวอย่าง:
 *   export const handleSummary = createHandleSummary(() => ({
 *     titleBase: 'my scenario',
 *     reportBasename: 'my-scenario',
 *     meta: { lotId: LOT_ID, buyers: [...] },
 *   }));
 */
export function createHandleSummary(configOrFactory) {
  return function handleSummary(data) {
    const cfg =
      typeof configOrFactory === 'function' ? configOrFactory(data) || {} : configOrFactory || {};

    const now = new Date();
    const titleBase = cfg.titleBase || __ENV.REPORT_TITLE || 'k6 report';
    const paths = buildReportPaths(now, {
      reportDir: cfg.reportDir,
      reportBasename: cfg.reportBasename,
    });
    const titleStamp = formatReportTitleStamp(now);
    const reportTitle = titleBase + ' — ' + titleStamp;

    let reportData = cfg.reportData || data;
    if (cfg.metricNames || cfg.metricPrefixes || cfg.checkNameRe) {
      reportData = filterSummaryData(reportData, {
        metricNames: cfg.metricNames,
        metricPrefixes: cfg.metricPrefixes,
        keepContextMetrics: cfg.keepContextMetrics,
        checkNameRe: cfg.checkNameRe,
        dropVuComplete: cfg.dropVuComplete,
      });
    }

    const meta = Object.assign(
      {
        generatedAt: now.toISOString(),
        reportDir: paths.dir,
        reportDate: paths.date,
        reportTime: paths.time,
        title: reportTitle,
        titleBase: titleBase,
        titleStamp: titleStamp,
      },
      cfg.meta || {}
    );

    const reportPayload = {
      meta: meta,
      summary: reportData,
    };

    console.log('[REPORT] dir  → ' + paths.dir);
    console.log('[REPORT] JSON → ' + paths.json);
    console.log('[REPORT] HTML → ' + paths.html);
    console.log('[REPORT] title → ' + reportTitle);
    if (cfg.metricNames || cfg.metricPrefixes) {
      console.log(
        '[REPORT] scope → filtered metrics (' +
          Object.keys((reportData && reportData.metrics) || {}).length +
          ')'
      );
    }

    const extraFiles = cfg.extraFiles || {};
    const extraKeys = Object.keys(extraFiles);
    for (let i = 0; i < extraKeys.length; i++) {
      console.log('[REPORT] extra → ' + extraKeys[i]);
    }

    // terminal ยังแสดง summary เต็ม เพื่อ debug setup/rejoin
    let stdout = textSummary(data, { indent: ' ', enableColors: true });
    if (cfg.extraStdout) {
      stdout = String(cfg.extraStdout) + stdout;
    }

    const result = {
      stdout: stdout,
      [paths.json]: JSON.stringify(reportPayload, null, 2),
      [paths.html]: htmlReport(reportData, {
        title: reportTitle,
      }),
    };
    for (let j = 0; j < extraKeys.length; j++) {
      const key = extraKeys[j];
      result[key] = extraFiles[key];
    }
    return result;
  };
}
