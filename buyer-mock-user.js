/**
 * Build buyer mock list for k6 scenarios.
 *
 * @param {number} [startLoopIndex=1]  first index (inclusive)
 * @param {number} [endLoopIndex=100]  last index (inclusive)
 * @param {string} [usernamePrefix='loadtestuser']
 * @returns {{ username: string, password: string, loginType: string }[]}
 *
 * example:
 *   getMockBuyer()                          // loadtestuser01 .. loadtestuser100
 *   getMockBuyer(1, 10)                     // loadtestuser01 .. loadtestuser10
 *   getMockBuyer(21, 30, 'k6buyer')         // k6buyer21 .. k6buyer30
 */
export function getMockBuyer(startLoopIndex, endLoopIndex, usernamePrefix) {
  const start = Math.max(1, Number(startLoopIndex != null ? startLoopIndex : 1));
  const end = Math.max(start, Number(endLoopIndex != null ? endLoopIndex : 100));
  const prefix = String(usernamePrefix != null ? usernamePrefix : 'loadtestuser');

  const buyers = [];
  for (let i = start; i <= end; i++) {
    let n = String(i);
    while (n.length <= 1) n = '0' + n;
    buyers.push({
      username: prefix + n,
      password: 'P@ssw0rd',
      loginType: 'buyer',
    });
  }
  return buyers;
}
