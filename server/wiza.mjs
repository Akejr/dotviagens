// Wiza (WiPay) hosted checkout: Multicaixa Express or Referência.
// Rules from the integration guide:
// - POST /v1/hosts/payments answers 303 with an empty body: read Location with redirect: 'manual'.
// - Only GET /v1/hosts/payments/{id} decides that a payment is paid (window of ~5 minutes).
// - The callback body proves nothing; outside the window it needs secret + payment id + amount.

const base = env => String(env.WIPAY_BASE_URL || 'https://api.wipay.ao').replace(/\/+$/, '');

export const hasWiza = env => Boolean(env.WIPAY_CLIENT_ID && env.WIPAY_CLIENT_SECRET && env.WIPAY_WEBHOOK_SECRET);

export class WizaError extends Error {
  constructor(message, status = 0, code = 'WIZA_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MESSAGES = {
  2000: 'Pagamento confirmado.',
  3000: 'Não foi possível usar essa conta.',
  3001: 'Saldo insuficiente.',
  3002: 'O pagamento foi recusado no telemóvel.',
  3003: 'O tempo para autorizar esgotou. Tenta novamente.',
  3004: 'Não foi possível confirmar. Tenta novamente.',
  3005: 'PIN incorrecto.',
  3006: 'Valor demasiado baixo.',
  4000: 'Serviço indisponível. Tenta mais tarde.',
  4003: 'Serviço indisponível. Tenta mais tarde.',
  4004: 'A transacção expirou. Tenta novamente.',
  9000: 'Ocorreu um erro. Tenta novamente.',
};

export const wizaMessage = code => (code ? MESSAGES[code] || 'O pagamento não foi concluído.' : null);

let tokenCache = { token: null, until: 0, client: null };

export async function wizaToken(env, fetcher = fetch) {
  if (tokenCache.token && tokenCache.until > Date.now() && tokenCache.client === env.WIPAY_CLIENT_ID) return tokenCache.token;
  let response;
  try {
    response = await fetcher(`${base(env)}/v1/credentials/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.WIPAY_CLIENT_ID, client_secret: env.WIPAY_CLIENT_SECRET, scope: 'payment' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new WizaError('O serviço de pagamentos não respondeu. Tenta novamente.', 0, 'WIZA_UNAVAILABLE');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    console.error('wiza token refused', response.status, data?.error);
    throw new WizaError('O serviço de pagamentos está temporariamente indisponível.', response.status, 'WIZA_AUTH');
  }
  const ttl = Math.max(120, Number(data.expires_in) || 3600);
  tokenCache = { token: data.access_token, until: Date.now() + (ttl - 60) * 1000, client: env.WIPAY_CLIENT_ID };
  return data.access_token;
}

export const forgetWizaToken = () => {
  tokenCache = { token: null, until: 0, client: null };
};

export async function createCharge(env, { amountAoa, referenceId, phone, callbackUrl, successUrl, failureUrl }, fetcher = fetch) {
  if (!Number.isInteger(amountAoa) || amountAoa < 100) throw new WizaError('Valor demasiado baixo para pagamento.', 0, 'WIZA_AMOUNT');
  if (!/^9\d{8}$/.test(phone || '')) throw new WizaError('Número de telemóvel inválido para pagamento.', 0, 'WIZA_PHONE');
  const send = token => fetcher(`${base(env)}/v1/hosts/payments`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountAoa.toFixed(2),
      currency: 'aoa',
      reference_id: referenceId,
      customer: phone,
      callback_url: callbackUrl,
      success_url: successUrl,
      failure_url: failureUrl,
    }),
    signal: AbortSignal.timeout(20000),
  });
  let response;
  try {
    response = await send(await wizaToken(env, fetcher));
    if (response.status === 401) {
      forgetWizaToken();
      response = await send(await wizaToken(env, fetcher));
    }
  } catch (error) {
    if (error instanceof WizaError) throw error;
    throw new WizaError('O serviço de pagamentos não respondeu. Tenta novamente.', 0, 'WIZA_UNAVAILABLE');
  }
  const location = response.headers.get('location');
  if (response.status !== 303 || !location) {
    console.error('wiza charge refused', response.status);
    throw new WizaError('Não foi possível iniciar o pagamento. Tenta novamente.', response.status, 'WIZA_CHARGE');
  }
  let url;
  try {
    url = new URL(location);
  } catch {
    throw new WizaError('Não foi possível iniciar o pagamento. Tenta novamente.', 303, 'WIZA_LOCATION');
  }
  const id = url.searchParams.get('id');
  if (url.protocol !== 'https:' || !id) throw new WizaError('Não foi possível iniciar o pagamento. Tenta novamente.', 303, 'WIZA_LOCATION');
  return { hostedUrl: url.href, id, nonce: url.searchParams.get('nonce') };
}

export async function paymentStatus(env, id, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${base(env)}/v1/hosts/payments/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new WizaError('O serviço de pagamentos não respondeu.', 0, 'WIZA_UNAVAILABLE');
  }
  if (response.status === 404) return { outsideWindow: true };
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new WizaError('Não foi possível consultar o pagamento.', response.status, 'WIZA_STATUS');
  const last = (Array.isArray(data.transactions) ? data.transactions : []).at(-1) || {};
  return {
    outsideWindow: false,
    status: data.status || null,
    code: last.status_code ? String(last.status_code) : null,
    service: last.service || null,
    amount: data.amount ?? null,
    referenceId: data.reference_id ?? null,
  };
}

// ATM entity/reference appears a few seconds after the customer picks "Referência".
export async function transactionInfo(env, id, fetcher = fetch) {
  const response = await fetcher(`${base(env)}/v1/hosts/transactions/${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) return null;
  const item = data.data && typeof data.data === 'object' ? data.data : data;
  return {
    service: item.service ?? null,
    reference: item.reference ?? item.reference_number ?? null,
    entity: item.entity ?? item.entity_id ?? null,
  };
}
