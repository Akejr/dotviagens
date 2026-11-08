// Vero.ao: Factura-Recibo certified by AGT, issued only after the payment is confirmed.
// Rules: amounts in cents, never send taxRate, M04 unless Consumidor Final,
// idempotencyKey = booking reference, PDF from the public route.

const VERO = 'https://api.vero.ao';

export const hasVero = env => Boolean(env.VERO_API_KEY && env.VERO_ORG_ID);
export const isVeroSandbox = env => String(env.VERO_API_KEY || '').startsWith('vero_test_sk_');
export const publicPdf = id => `${VERO}/v1/public/invoices/${encodeURIComponent(id)}/pdf`;

export class VeroError extends Error {
  constructor(code, status = 0) {
    super(`vero:${code}`);
    this.code = code;
    this.status = status;
  }
}

async function call(env, method, path, body, fetcher) {
  let response;
  try {
    response = await fetcher(`${VERO}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.VERO_API_KEY}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new VeroError('unavailable');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code = data?.error?.code || data?.code || (typeof data?.error === 'string' ? data.error : null) || `http_${response.status}`;
    console.error('vero refused', method, response.status, code);
    throw new VeroError(String(code), response.status);
  }
  return data;
}

const org = env => encodeURIComponent(env.VERO_ORG_ID);

export async function ensureCustomer(env, { nif, name }, fetcher = fetch) {
  const body = nif
    ? { externalId: `nif-${nif}`, name: name || `Cliente NIF ${nif}`, taxId: nif }
    : { externalId: 'consumidor-final', name: 'Consumidor Final', isConsumidorFinal: true };
  const data = await call(env, 'POST', `/v1/organisations/${org(env)}/customers/ensure`, body, fetcher);
  const id = data?.data?.id;
  if (!id) throw new VeroError('no_customer_id');
  return id;
}

export function invoicePayload({ customerId, reference, description, amountAoa, consumidorFinal }) {
  const body = {
    customerId,
    documentType: 'FR',
    idempotencyKey: reference,
    items: [{ description, quantity: 1, unitPrice: Math.round(amountAoa * 100) }],
  };
  if (!consumidorFinal) body.taxExemptionCode = 'M04';
  return body;
}

export async function issueInvoice(env, args, fetcher = fetch) {
  const data = await call(env, 'POST', `/v1/organisations/${org(env)}/invoices`, invoicePayload(args), fetcher);
  const invoice = data?.data;
  if (!invoice?.id) throw new VeroError('no_invoice_id');
  return { id: invoice.id, number: invoice.number ?? null, agtStatus: invoice.agtStatus ?? null, pdfUrl: publicPdf(invoice.id) };
}

export async function invoiceStatus(env, id, fetcher = fetch) {
  const data = await call(env, 'GET', `/v1/organisations/${org(env)}/invoices/${encodeURIComponent(id)}`, null, fetcher);
  return { agtStatus: data?.data?.agtStatus ?? null, agtErrors: data?.data?.agtErrors ?? null, number: data?.data?.number ?? null };
}
