// Nsangu SMS API (https://api.nsangu.com/docs/).
// - Every send carries a unique Idempotency-Key; retries reuse the same key.
// - OTP category for codes (text never returned), TRANSACTIONAL for notices.
// - Movicel numbers receive the numeric sender 46554; the response says which sender was used.

const DEFAULT_BASE = 'https://api.nsangu.com';
const base = env => String(env.NSANGU_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const hasSms = env => Boolean(env.NSANGU_API_KEY);

export class SmsError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const publicMessages = {
  validation_error: 'Confirma o número de telemóvel.',
  insufficient_balance: 'O envio de SMS está temporariamente indisponível. Tenta mais tarde.',
  unauthorized: 'O envio de SMS está temporariamente indisponível. Tenta mais tarde.',
  tenant_suspended: 'O envio de SMS está temporariamente indisponível. Tenta mais tarde.',
  organization_not_approved: 'O envio de SMS está temporariamente indisponível. Tenta mais tarde.',
};

// Every SMS is plain ASCII: no accents or special symbols. One SMS = 160 characters
// (a single non-GSM character would turn it into 70-character parts and cost more).
export function ascii(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[ºª]/g, '')
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[→⇄]/g, '-')
    .replace(/[^\x20-\x7e\n]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}
// Older name kept for callers: same rule.
export const gsm7 = ascii;

export const SMS_MAX = 160;
const groupDigits = value => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const dayMonth = iso => String(iso || '').slice(5, 10).split('-').reverse().join('/');

// Price alert: first text that fits one SMS (city names, then airport codes, then without the link).
function priceDrop({ origin, destination, originName, destinationName, departureDate, returnDate, from, to, link }) {
  const dates = returnDate ? `${dayMonth(departureDate)} a ${dayMonth(returnDate)}` : dayMonth(departureDate);
  const named = originName && destinationName ? `${originName}-${destinationName}` : null;
  const build = (route, url) => ascii(`DOT Viagens: o preco da viagem ${route} ${dates} caiu de ${groupDigits(from)} Kz para ${groupDigits(to)} Kz.${url ? ` Ve: ${url}` : ''}`);
  const codes = `${origin}-${destination}`;
  const options = [named && build(named, link), build(codes, link), named && build(named, null), build(codes, null)].filter(Boolean);
  return options.find(text => text.length <= SMS_MAX) || options.at(-1);
}

export const smsText = {
  otp: code => ascii(`DOT Viagens: o teu codigo e ${code}. Valido por 5 minutos. Nao o partilhes.`),
  paid: (reference, amountAoa) =>
    ascii(`DOT Viagens: recebemos o pagamento de ${groupDigits(amountAoa)} Kz da reserva ${reference}. Vamos emitir o teu bilhete e avisamos por SMS.`),
  ticketed: (reference, pnr) =>
    ascii(`DOT Viagens: o teu bilhete foi emitido. Reserva ${reference}${pnr ? `, codigo ${pnr}` : ''}. Ve os detalhes em Minhas viagens.`),
  cancelled: reference =>
    ascii(`DOT Viagens: a reserva ${reference} foi cancelada. A nossa equipa vai contactar-te.`),
  priceDrop,
};

async function request(env, method, path, { body, idempotencyKey, fetcher }) {
  const headers = { Authorization: `Bearer ${env.NSANGU_API_KEY}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return fetcher(`${base(env)}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
}

// Retries only network failures, 5xx and non-JSON replies, always with the same key.
export async function sendSms(env, { to, text, category, idempotencyKey }, { fetcher = fetch, retries = 2, wait = sleep } = {}) {
  if (!hasSms(env)) throw new SmsError('not_configured', 'O envio de SMS ainda não está configurado.');
  if (!idempotencyKey) throw new SmsError('missing_key', 'Falta a chave de idempotência.');
  let lastError = new SmsError('unavailable', 'O serviço de SMS não respondeu.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await wait(1000 * 2 ** (attempt - 1));
    let response;
    try {
      response = await request(env, 'POST', '/v1/messages', { body: { to, text, category }, idempotencyKey, fetcher });
    } catch {
      lastError = new SmsError('network', 'O serviço de SMS não respondeu.');
      continue;
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data?.id) return data;
    if (!data || response.status >= 500) {
      lastError = new SmsError('unavailable', 'O serviço de SMS não respondeu.', response.status);
      continue;
    }
    console.error('nsangu send refused', response.status, data.code, data.requestId);
    throw new SmsError(data.code || 'error', publicMessages[data.code] || 'Não foi possível enviar o SMS.', response.status);
  }
  console.error('nsangu send failed', lastError.code, lastError.status);
  throw lastError;
}

export async function smsStatus(env, id, { fetcher = fetch } = {}) {
  if (!hasSms(env)) throw new SmsError('not_configured', 'O envio de SMS ainda não está configurado.');
  const response = await request(env, 'GET', `/v1/messages/${encodeURIComponent(id)}`, { fetcher });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new SmsError(data?.code || 'error', 'Não foi possível consultar a mensagem.', response.status);
  return data;
}

export async function smsBalance(env, { fetcher = fetch } = {}) {
  if (!hasSms(env)) return null;
  const response = await request(env, 'GET', '/v1/balance', { fetcher });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new SmsError(data?.code || 'error', 'Não foi possível consultar o saldo.', response.status);
  return data;
}
