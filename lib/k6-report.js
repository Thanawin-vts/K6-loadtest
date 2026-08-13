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

/**
 * สร้าง handleSummary ที่ reuse ได้
 *
 * @param {object|function} configOrFactory
 *   - titleBase / reportDir / reportBasename
 *   - meta: object เพิ่มใน JSON (หรือ factory คืน object เหล่านี้)
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
      summary: data,
    };

    console.log('[REPORT] dir  → ' + paths.dir);
    console.log('[REPORT] JSON → ' + paths.json);
    console.log('[REPORT] HTML → ' + paths.html);
    console.log('[REPORT] title → ' + reportTitle);

    return {
      stdout: textSummary(data, { indent: ' ', enableColors: true }),
      [paths.json]: JSON.stringify(reportPayload, null, 2),
      [paths.html]: htmlReport(data, {
        title: reportTitle,
      }),
    };
  };
}
