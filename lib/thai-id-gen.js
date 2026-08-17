export function thaiIdGen() {
  // สุ่มเลข 12 หลักแรก
  let digits = [];
  for (let i = 0; i < 12; i++) {
    digits.push(Math.floor(Math.random() * 10));
  }

  // คำนวณเลขหลักที่ 13 (checksum) ตามสูตรเลขบัตรประชาชนไทย
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (13 - i);
  }
  let checkDigit = (11 - (sum % 11)) % 10;
  digits.push(checkDigit);

  return digits.join('');
}