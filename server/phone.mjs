// Angolan mobile numbers: 9 digits starting with 9, stored without +244.

export function normalizePhone(input) {
  let digits = String(input ?? '').trim().replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00244')) digits = digits.slice(5);
  else if (digits.startsWith('244') && digits.length === 12) digits = digits.slice(3);
  return /^9\d{8}$/.test(digits) ? digits : null;
}

export const maskPhone = phone => (phone ? `+244 ${phone.slice(0, 3)} *** ${phone.slice(-3)}` : '');

export const formatPhone = phone =>
  phone ? `+244 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}` : '';

// Movicel (91x, 99x) currently receives messages from the numeric sender 46554.
export const isMovicel = phone => /^9[19]/.test(phone || '');
