export function getMockBuyer() {
//   const buyers = [{
//     username: 'loadtestuser58',
//     password: 'P@ssw0rd',
//     loginType: 'buyer',
//   }];
  const buyers = [];
  for (let i = 1; i <= 100; i++) {
    const n = i < 10 ? '0' + i : String(i);
    buyers.push({
      username: 'loadtestuser' + n,
      password: 'P@ssw0rd',
      loginType: 'buyer',
    });
  }
  return buyers;
}
