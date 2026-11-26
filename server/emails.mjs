// E-mails of a purchase, sent with Resend (https://resend.com/docs/api-reference/emails/send-email):
// - to the DOT team (ADMIN_EMAIL, dotangola@gmail.com by default) as soon as a sale is paid;
// - to the customer: the purchase confirmation with the Vero factura-recibo (link + PDF attached),
//   after the invoice; an invoice issued later goes in its own e-mail.
// Every e-mail has an Idempotency-Key and a row in email_messages: a booking never gets the same
// e-mail twice. A failure is logged and never changes the sale.
import { airportCity } from './airport-names.mjs';
import { CABINS } from './flights.mjs';
import { isVeroSandbox } from './vero.mjs';

const RESEND = 'https://api.resend.com/emails';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const hasEmail = env => Boolean(env.RESEND_API_KEY);
const fromOf = env => env.RESEND_FROM || 'DOT Viagens <reservas@dotviagens.com>';
const adminOf = env => env.ADMIN_EMAIL || 'dotangola@gmail.com';
const baseOf = env => String(env.PUBLIC_BASE_URL || 'https://www.dotviagens.com').replace(/\/+$/, '');
const WHATSAPP = 'https://wa.me/244931343433';

export class EmailError extends Error {
  constructor(code, status = 0) {
    super(`email:${code}`);
    this.code = code;
    this.status = status;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────
async function post(env, body, key, fetcher) {
  return fetcher(RESEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
}

// Retries network failures and 5xx with the same key. An attachment Resend cannot fetch (4xx) is
// dropped: the e-mail goes with the link only.
export async function sendEmail(env, { to, subject, html, text, attachments, idempotencyKey }, { fetcher = fetch, wait = sleep } = {}) {
  if (!hasEmail(env)) throw new EmailError('not_configured');
  let body = { from: fromOf(env), to: [to], reply_to: adminOf(env), subject, html, text, ...(attachments?.length ? { attachments } : {}) };
  let key = idempotencyKey;
  let last = new EmailError('unavailable');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(1000 * attempt);
    let response;
    try {
      response = await post(env, body, key, fetcher);
    } catch {
      last = new EmailError('network');
      continue;
    }
    const data = await response.json().catch(() => null);
    if (response.ok && data?.id) return data;
    if (response.status >= 500 || !data) {
      last = new EmailError('unavailable', response.status);
      continue;
    }
    if (body.attachments && response.status < 500 && response.status !== 401 && response.status !== 403 && response.status !== 429) {
      console.error('resend refused the attachment, sending without it', response.status, data?.name);
      body = { ...body, attachments: undefined };
      key = `${idempotencyKey}-link`;
      continue;
    }
    console.error('resend refused', response.status, data?.name);
    throw new EmailError(data?.name || `http_${response.status}`, response.status);
  }
  throw last;
}

// Sends once per key (email_messages) and records the result.
async function deliver(env, store, { key, to, purpose, bookingId, withInvoice = false, message }, deps = {}) {
  if (!hasEmail(env) || !to) return null;
  const done = await store.one('email_messages', { select: 'id,status', idempotency_key: `eq.${key}` }).catch(() => null);
  if (done?.status === 'sent') return done;
  const row = { idempotency_key: key, to_address: to, purpose, booking_id: bookingId ?? null, with_invoice: withInvoice };
  try {
    const data = await sendEmail(env, { ...message, to, idempotencyKey: key }, { fetcher: deps.fetcher || fetch });
    await store.upsert('email_messages', { ...row, provider_id: data.id, status: 'sent', error: null }, 'idempotency_key').catch(error => console.error('email not recorded:', error.message));
    return data;
  } catch (error) {
    await store.upsert('email_messages', { ...row, status: 'failed', error: String(error.code || error.message).slice(0, 300) }, 'idempotency_key').catch(() => {});
    throw error;
  }
}

// ── Text helpers ─────────────────────────────────────────────────────────────
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const travellersText = (adults, children = 0) =>
  [plural(adults, 'adulto', 'adultos'), children ? plural(children, 'criança', 'crianças') : ''].filter(Boolean).join(' e ');
const kz = value => `${String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0Kz`;
const city = code => airportCity.get(code) || code;
const dayOf = value => String(value || '').slice(0, 10);
const clock = value => String(value || '').slice(11, 16);
const shift = (from, to) => Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${dayOf(from)}T00:00:00Z`)) / 86400000) || 0;
const longDay = value => {
  const text = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${dayOf(value)}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const duration = minutes => `${Math.floor((minutes || 0) / 60)}h ${String((minutes || 0) % 60).padStart(2, '0')}min`;
const phoneText = phone => (/^9\d{8}$/.test(phone || '') ? `+244 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}` : phone || '');
const cabinOf = booking => (CABINS[booking.itinerary?.query?.cabin] || CABINS.economy).label;
const childrenOf = booking => (booking.booking_passengers || []).filter(p => p.passenger_type === 'child').length || Number(booking.itinerary?.query?.children) || 0;
const tripLine = booking => {
  const children = childrenOf(booking);
  return `${booking.trip_type === 'return' ? 'Ida e volta' : 'Só ida'} · ${travellersText(booking.passengers_count - children, children)} · ${cabinOf(booking)}`;
};
const route = booking => `${city(booking.origin)} → ${city(booking.destination)}`;
const pdfOf = (env, booking) => (booking.vero_pdf_url && !isVeroSandbox(env) ? booking.vero_pdf_url : null);

// ── Design: the site's colours (cream, ink, the orange gradient), Manrope and DM Sans ──────
const FONT = "'DM Sans',Arial,Helvetica,sans-serif";
const HEAD = "Manrope,'DM Sans',Arial,Helvetica,sans-serif";
const INK = '#262820';
const MUTED = '#777b73';
const LINE = '#e8e9e3';
const ORANGE = '#ef5900';
const GRADIENT = 'linear-gradient(115deg,#ffad00 0%,#ff8500 38%,#ff5900 76%,#ed4600 100%)';

const button = (href, label, primary = true) => `<a href="${esc(href)}" style="display:inline-block;padding:14px 26px;border-radius:12px;font:700 15px/1 ${HEAD};text-decoration:none;${primary
  ? `background-color:${ORANGE};background-image:${GRADIENT};color:#ffffff`
  : `background:#ffffff;color:${INK};border:1px solid ${LINE}`}">${esc(label)}</a>`;

const card = inner => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:16px;background:#ffffff;margin:0 0 14px"><tr><td style="padding:20px 22px">${inner}</td></tr></table>`;
const label = text => `<div style="font:700 11px/1.4 ${HEAD};letter-spacing:1.4px;text-transform:uppercase;color:${ORANGE};margin:0 0 10px">${esc(text)}</div>`;

function legHtml(leg, title) {
  if (!leg?.segments?.length) return '';
  const first = leg.segments[0];
  const last = leg.segments.at(-1);
  const plus = shift(first.departure, last.arrival);
  const stops = leg.segments.length - 1;
  const flights = leg.segments.map(s => `${esc(s.airline)} ${esc(s.number)}`).join(' · ');
  return card(`${label(`${title} · ${longDay(first.departure)}`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="34%" valign="top"><div style="font:800 26px/1 ${HEAD};color:${INK}">${esc(first.from)}</div><div style="font:700 16px/1.6 ${FONT};color:${INK};margin-top:6px">${esc(clock(first.departure))}</div><div style="font:13px/1.4 ${FONT};color:${MUTED}">${esc(city(first.from))}</div></td>
      <td width="32%" align="center" valign="middle" style="font:12px/1.5 ${FONT};color:${MUTED}">${stops ? plural(stops, 'escala', 'escalas') : 'Directo'}<br><span style="color:${ORANGE};font-size:14px;letter-spacing:-1px">—— → ——</span><br>${duration(leg.duration)}</td>
      <td width="34%" align="right" valign="top"><div style="font:800 26px/1 ${HEAD};color:${INK}">${esc(last.to)}</div><div style="font:700 16px/1.6 ${FONT};color:${INK};margin-top:6px">${esc(clock(last.arrival))}${plus > 0 ? `<sup style="font-size:11px;color:${ORANGE}">+${plus}</sup>` : ''}</div><div style="font:13px/1.4 ${FONT};color:${MUTED}">${esc(city(last.to))}</div></td>
    </tr></table>
    <div style="font:12px/1.5 ${FONT};color:${MUTED};margin-top:14px;padding-top:12px;border-top:1px solid ${LINE}">${flights} · ${esc(leg.cabin || 'Económica')}</div>`);
}

function passengersHtml(booking, { admin = false } = {}) {
  const rows = (booking.booking_passengers || []).sort((a, b) => a.position - b.position).map(p => {
    const name = `${p.title === 'MR' ? 'Sr.' : 'Sra.'} ${p.given_names} ${p.surname}`;
    const kind = p.passenger_type === 'child' ? 'Criança' : 'Adulto';
    const extra = admin ? [p.birth_date ? `nascido(a) a ${p.birth_date.split('-').reverse().join('/')}` : '', p.nationality || ''].filter(Boolean).join(' · ') : '';
    return `<tr><td style="padding:9px 0;border-top:1px solid ${LINE};font:600 14px/1.4 ${FONT};color:${INK}">${esc(name)}${extra ? `<div style="font:400 12px/1.4 ${FONT};color:${MUTED}">${esc(extra)}</div>` : ''}</td><td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font:12px ${FONT};color:${MUTED}">${kind}</td></tr>`;
  }).join('');
  return rows ? card(`${label('Passageiros')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`) : '';
}

function layout(env, { preheader, eyebrow, title, intro, body }) {
  const base = baseOf(env);
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Manrope:wght@700;800&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#faf9f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="padding:0 6px 18px"><a href="${esc(base)}"><img src="${esc(base)}/assets/logo-dot-320.png" width="120" height="40" alt="DOT Viagens" style="display:block;border:0"></a></td></tr>
  <tr><td style="border-radius:20px;background-color:${ORANGE};background-image:${GRADIENT};padding:30px 28px">
    <div style="font:700 11px/1.4 ${HEAD};letter-spacing:1.6px;text-transform:uppercase;color:#fff3e6">${esc(eyebrow)}</div>
    <h1 style="margin:10px 0 10px;font:800 26px/1.2 ${HEAD};color:#ffffff;letter-spacing:-.4px">${esc(title)}</h1>
    <p style="margin:0;font:15px/1.55 ${FONT};color:#ffffff">${intro}</p>
  </td></tr>
  <tr><td style="padding:18px 0 0">${body}</td></tr>
  <tr><td style="padding:10px 6px 0;font:12px/1.6 ${FONT};color:${MUTED}">Precisas de ajuda? Fala connosco no <a href="${WHATSAPP}" style="color:${ORANGE};font-weight:700;text-decoration:none">WhatsApp +244 931 343 433</a>.<br>DOT Viagens · Luanda, Angola · <a href="${esc(base)}" style="color:${MUTED}">dotviagens.com</a></td></tr>
</table></td></tr></table></body></html>`;
}

function invoiceHtml(env, booking) {
  const pdf = pdfOf(env, booking);
  if (!pdf) return card(`${label('Factura-recibo')}<p style="margin:0;font:14px/1.55 ${FONT};color:${INK}">A tua factura-recibo segue num próximo e-mail, assim que for emitida.</p>`);
  return card(`${label('Factura-recibo')}<p style="margin:0 0 14px;font:14px/1.55 ${FONT};color:${INK}">${booking.vero_invoice_number ? `Factura-recibo <b>${esc(booking.vero_invoice_number)}</b>, certificada pela AGT.` : 'A tua factura-recibo, certificada pela AGT.'} Vai também em anexo, em PDF.</p>${button(pdf, 'Ver a factura (PDF)')}`);
}
const attachmentsOf = (env, booking) => {
  const pdf = pdfOf(env, booking);
  return pdf ? [{ filename: `Factura-${booking.reference}.pdf`, path: pdf }] : [];
};

// ── Messages ─────────────────────────────────────────────────────────────────
export function customerMessage(env, booking) {
  const base = baseOf(env);
  const first = String(booking.contact_name || '').split(/\s+/)[0];
  const summary = card(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td valign="top"><div style="font:12px ${FONT};color:${MUTED}">Reserva</div><div style="font:800 18px/1.4 ${HEAD};color:${INK}">${esc(booking.reference)}</div></td>
    <td align="right" valign="top"><div style="font:12px ${FONT};color:${MUTED}">Total pago</div><div style="font:800 20px/1.4 ${HEAD};color:${ORANGE}">${kz(booking.amount_aoa)}</div></td></tr></table>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid ${LINE};font:700 16px/1.4 ${HEAD};color:${INK}">${esc(route(booking))}</div>
    <div style="font:13px/1.5 ${FONT};color:${MUTED}">${esc(tripLine(booking))}</div>`);
  const next = card(`${label('O que acontece agora')}<p style="margin:0 0 16px;font:14px/1.6 ${FONT};color:${INK}">A equipa DOT emite o teu bilhete na companhia aérea e envia-te o código da reserva (PNR) por SMS. Em Minhas viagens vês os voos, os passageiros e o bilhete.</p>${button(`${base}/minhas-viagens?ref=${encodeURIComponent(booking.reference)}`, 'Ver em Minhas viagens', false)}`);
  const html = layout(env, {
    preheader: `Recebemos o pagamento de ${kz(booking.amount_aoa)}. Vamos emitir o teu bilhete.`,
    eyebrow: 'Compra confirmada',
    title: first ? `Obrigado, ${first}! A tua viagem está confirmada.` : 'A tua viagem está confirmada.',
    intro: `Recebemos o pagamento da reserva <b>${esc(booking.reference)}</b>. Vamos emitir o teu bilhete e avisamos-te por SMS.`,
    body: summary + legHtml(booking.itinerary?.outbound, 'Ida') + legHtml(booking.itinerary?.inbound, 'Volta') + passengersHtml(booking) + invoiceHtml(env, booking) + next,
  });
  const text = [
    `Compra confirmada · ${booking.reference}`,
    `${route(booking)} · ${tripLine(booking)}`,
    `Total pago: ${kz(booking.amount_aoa)}`,
    pdfOf(env, booking) ? `Factura-recibo: ${pdfOf(env, booking)}` : 'A factura-recibo segue num próximo e-mail.',
    `Minhas viagens: ${base}/minhas-viagens?ref=${booking.reference}`,
    `Ajuda: ${WHATSAPP}`,
  ].join('\n');
  return { subject: `Compra confirmada · ${booking.reference} · ${route(booking)}`, html, text, attachments: attachmentsOf(env, booking) };
}

export function invoiceMessage(env, booking) {
  const html = layout(env, {
    preheader: `A factura-recibo da reserva ${booking.reference}.`,
    eyebrow: 'Factura-recibo',
    title: 'A tua factura está pronta.',
    intro: `Segue a factura-recibo da reserva <b>${esc(booking.reference)}</b> (${esc(route(booking))}), no valor de <b>${kz(booking.amount_aoa)}</b>.`,
    body: invoiceHtml(env, booking),
  });
  return { subject: `A tua factura · ${booking.reference}`, html, text: `Factura-recibo da reserva ${booking.reference}: ${pdfOf(env, booking)}`, attachments: attachmentsOf(env, booking) };
}

export function adminMessage(env, booking) {
  const base = baseOf(env);
  const method = booking.payment_method === 'manual' ? 'Manual (WhatsApp)' : booking.wiza_service === 'reference' ? 'Wiza · Referência' : booking.wiza_service ? 'Wiza · Multicaixa Express' : 'Wiza';
  const row = (name, value) => `<tr><td style="padding:7px 0;font:12px ${FONT};color:${MUTED};width:38%">${esc(name)}</td><td style="padding:7px 0;font:600 14px/1.4 ${FONT};color:${INK}">${value}</td></tr>`;
  const details = card(`${label('Cliente e pagamento')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${row('Nome', esc(booking.contact_name))}
    ${row('Telemóvel', `<a href="tel:+244${esc(booking.contact_phone)}" style="color:${INK};text-decoration:none">${esc(phoneText(booking.contact_phone))}</a>`)}
    ${row('E-mail', esc(booking.contact_email || '—'))}
    ${row('Pagamento', esc(method))}
    ${row('Total pago', `<span style="color:${ORANGE}">${kz(booking.amount_aoa)}</span>`)}
    ${row('Viagem', `${esc(route(booking))}<div style="font:400 12px ${FONT};color:${MUTED}">${esc(tripLine(booking))}</div>`)}
    ${booking.invoice_nif ? row('NIF da factura', `${esc(booking.invoice_nif)} · ${esc(booking.invoice_name || '')}`) : ''}
  </table>`);
  const todo = card(`${label('Próximo passo')}<p style="margin:0 0 16px;font:14px/1.6 ${FONT};color:${INK}">Emite o bilhete na companhia ou no consolidador e regista o PNR no painel: o cliente recebe o SMS. Os passaportes estão no painel.</p>${button(`${base}/admin#booking/${encodeURIComponent(booking.reference)}`, 'Abrir a reserva no painel')}`);
  const html = layout(env, {
    preheader: `${booking.contact_name} pagou ${kz(booking.amount_aoa)} · ${route(booking)}`,
    eyebrow: 'Nova compra paga',
    title: `${kz(booking.amount_aoa)} · ${booking.reference}`,
    intro: `${esc(booking.contact_name)} comprou <b>${esc(route(booking))}</b>. O pagamento está confirmado.`,
    body: details + legHtml(booking.itinerary?.outbound, 'Ida') + legHtml(booking.itinerary?.inbound, 'Volta') + passengersHtml(booking, { admin: true }) + todo,
  });
  const text = [
    `Nova compra paga · ${booking.reference} · ${kz(booking.amount_aoa)}`,
    `${booking.contact_name} · ${phoneText(booking.contact_phone)} · ${booking.contact_email || ''}`,
    `${route(booking)} · ${tripLine(booking)} · ${method}`,
    `Painel: ${base}/admin#booking/${booking.reference}`,
  ].join('\n');
  return { subject: `Nova compra paga · ${booking.reference} · ${kz(booking.amount_aoa)}`, html, text };
}

export const purchaseEmails = {
  admin: (env, store, booking, deps) => deliver(env, store, {
    key: `booking-${booking.reference}-admin-paid`, to: adminOf(env), purpose: 'admin_paid', bookingId: booking.id, message: adminMessage(env, booking),
  }, deps),
  customer: (env, store, booking, deps) => deliver(env, store, {
    key: `booking-${booking.reference}-paid`, to: booking.contact_email, purpose: 'payment_confirmed', bookingId: booking.id,
    withInvoice: Boolean(pdfOf(env, booking)), message: customerMessage(env, booking),
  }, deps),
};

// The invoice alone, when the confirmation was sent without it (or never sent).
export async function invoiceEmail(env, store, booking, deps) {
  if (!hasEmail(env) || !pdfOf(env, booking) || !booking.contact_email) return null;
  const paid = await store.one('email_messages', { select: 'status,with_invoice', idempotency_key: `eq.booking-${booking.reference}-paid` }).catch(() => null);
  if (paid?.status === 'sent' && paid.with_invoice) return null;
  return deliver(env, store, {
    key: `booking-${booking.reference}-invoice`, to: booking.contact_email, purpose: 'invoice', bookingId: booking.id, withInvoice: true, message: invoiceMessage(env, booking),
  }, deps);
}

// ── Ticket (bilhete): the e-mail and the A4 page share the same data ─────────────────────────
// bookings.ticket_details = { legs: [{ flight, airline, from, to, departure, arrival, terminal, checkinClose,
//   duration, cabin, direction }], checkedPieces, checkedKg, carryOnKg, carryOnSize, personalItem, personalSize }
const flightDay = value => longDay(value).replace(/^[^,]+,\s*/, '');
const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const niceName = text => String(text || '').toLowerCase().split(/\s+/).filter(Boolean)
  .map((word, index) => (index && PARTICLES.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(' ');
const dateOfIssue = value => new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Luanda' }).format(new Date(value || Date.now()));

// The private link of the ticket page carries a random token saved with the ticket details.
export const ticketToken = (env, booking) => booking.ticket_details?.token || '';
export const ticketUrl = async (env, booking) =>
  `${baseOf(env)}/api/bookings/${encodeURIComponent(booking.reference)}/bilhete?t=${ticketToken(env, booking)}`;

export function ticketFromBooking(booking) {
  const d = booking.ticket_details || {};
  const people = (booking.booking_passengers || []).slice().sort((a, b) => a.position - b.position).map(p => niceName(`${p.given_names} ${p.surname}`));
  const promo = booking.itinerary?.promo;
  const discountAoa = Number(promo?.discountAoa) || 0;
  const children = childrenOf(booking);
  const legs = (d.legs || []).map(leg => ({ ...leg, cabin: leg.cabin || cabinOf(booking) }));
  return {
    passenger: people.join(' · ') || niceName(booking.contact_name),
    pnr: booking.ticket_pnr,
    ticketNumber: booking.ticket_numbers || '',
    legs,
    checkedPieces: Number(d.checkedPieces) || 0,
    checkedKg: Number(d.checkedKg) || 0,
    carryOnKg: Number(d.carryOnKg) || 0,
    carryOnSize: d.carryOnSize || '',
    personalItem: d.personalItem !== false,
    personalSize: d.personalSize || '',
    travellers: travellersText(booking.passengers_count - children, children),
    fullAoa: Number(booking.amount_aoa) + discountAoa,
    discountAoa,
    discountLabel: promo?.label ? `Desconto ${promo.label}` : 'Desconto',
    totalAoa: Number(booking.amount_aoa),
    issuedAt: dateOfIssue(booking.ticketed_at),
  };
}
const fromTo = t => `${t.legs[0]?.from || ''} → ${t.legs.at(-1)?.to || ''}`;
const sizeOf = text => (text ? ` · ${text}` : '');
const bagLines = t => [
  t.checkedPieces ? { n: t.checkedPieces, name: t.checkedPieces === 1 ? 'Mala de porão' : 'Malas de porão', note: `até ${t.checkedKg} kg${t.checkedPieces > 1 ? ' cada' : ''}` } : null,
  t.carryOnKg ? { n: 1, name: 'Bagagem de mão', note: `até ${t.carryOnKg} kg${sizeOf(t.carryOnSize)}` } : null,
  t.personalItem ? { n: 1, name: 'Item pessoal', note: `debaixo do assento${sizeOf(t.personalSize)}` } : null,
].filter(Boolean);

function routeCard(leg, planeSrc) {
  const check = leg.checkinClose ? ` · Check-in até <b style="color:#ffffff">${esc(leg.checkinClose)}</b>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:20px;background-color:${INK};margin:0 0 14px"><tr><td style="padding:24px 24px 20px">
    <div style="font:700 11px/1.4 ${HEAD};letter-spacing:1.4px;text-transform:uppercase;color:#ffad00;margin:0 0 18px">${leg.direction ? `${esc(leg.direction)} · ` : ''}${esc(longDay(leg.departure))} de ${esc(dayOf(leg.departure).slice(0, 4))}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="32%" valign="top"><div style="font:800 40px/1 ${HEAD};color:#ffffff;letter-spacing:-1px">${esc(leg.from)}</div><div style="font:14px/1.5 ${FONT};color:#c9ccc4;margin-top:6px">${esc(city(leg.from))}</div><div style="font:800 22px/1.3 ${HEAD};color:#ffffff;margin-top:12px">${esc(clock(leg.departure))}</div></td>
      <td width="36%" align="center" valign="top" style="padding-top:6px"><div style="font:12px/1.4 ${FONT};color:#c9ccc4">${duration(leg.duration)}</div><img src="${esc(planeSrc)}" width="190" alt="" style="display:block;border:0;width:100%;max-width:190px;height:auto;margin:8px auto"><div style="font:12px/1.4 ${FONT};color:#c9ccc4">Directo</div></td>
      <td width="32%" align="right" valign="top"><div style="font:800 40px/1 ${HEAD};color:#ffffff;letter-spacing:-1px">${esc(leg.to)}</div><div style="font:14px/1.5 ${FONT};color:#c9ccc4;margin-top:6px">${esc(city(leg.to))}</div><div style="font:800 22px/1.3 ${HEAD};color:#ffffff;margin-top:12px">${esc(clock(leg.arrival))}</div></td>
    </tr></table>
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #45483f;font:13px/1.5 ${FONT};color:#c9ccc4">${esc(leg.airline)} · Voo <b style="color:#ffffff">${esc(leg.flight)}</b> · ${esc(leg.cabin)}${check}</div>
  </td></tr></table>`;
}

function ticketDetailsCard(t) {
  const row = (name, value) => `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font:13px/1.4 ${FONT};color:${MUTED};width:42%" valign="top">${esc(name)}</td><td style="padding:10px 0;border-top:1px solid ${LINE};font:600 14px/1.4 ${FONT};color:${INK}">${value}</td></tr>`;
  const bags = bagLines(t).map(b => `${b.n} ${esc(b.name.toLowerCase())}<span style="font:400 12px ${FONT};color:${MUTED}"> · ${esc(b.note)}</span>`).join('<br>');
  return card(`${label('O teu bilhete')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${row('Passageiro', esc(t.passenger))}
    ${row('Código da reserva', `<span style="font:800 16px ${HEAD};letter-spacing:1px">${esc(t.pnr)}</span>`)}
    ${t.ticketNumber ? row('Número do bilhete', esc(t.ticketNumber)) : ''}
    ${bags ? row('Bagagem incluída', bags) : ''}
  </table>`);
}

function priceCard(t) {
  const row = (name, value, { strong = false, color = INK } = {}) => `<tr><td style="padding:9px 0;${strong ? `border-top:1px solid ${LINE};` : ''}font:${strong ? 700 : 400} 14px/1.4 ${FONT};color:${strong ? INK : MUTED}">${esc(name)}</td><td align="right" style="padding:9px 0;${strong ? `border-top:1px solid ${LINE};` : ''}font:${strong ? '800 18px' : '600 14px'}/1.4 ${HEAD};color:${color}">${value}</td></tr>`;
  return card(`${label('Preço')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${row(`Passagem aérea · ${t.travellers}`, kz(t.fullAoa))}
    ${t.discountAoa ? row(t.discountLabel, `−${kz(t.discountAoa)}`, { color: '#1a8a4a' }) : ''}
    ${row('Total pago', kz(t.totalAoa), { strong: true, color: ORANGE })}
  </table><div style="font:12px/1.5 ${FONT};color:${MUTED};margin-top:4px">Já inclui taxas de aeroporto e da companhia.</div>`);
}

export function ticketMessage(env, booking, t) {
  const planeSrc = t.planeSrc || `${baseOf(env)}/assets/rota-aviao.png`;
  const first = t.passenger.split(/\s+/)[0];
  const page = t.pageUrl ? card(`${label('Bilhete em PDF')}<p style="margin:0 0 14px;font:14px/1.55 ${FONT};color:${INK}">Abre o bilhete numa página limpa e guarda-o em PDF ou imprime-o.</p>${button(t.pageUrl, 'Abrir o bilhete', false)}`) : '';
  const html = layout(env, {
    preheader: `O teu bilhete ${fromTo(t)}, ${flightDay(t.legs[0].departure)}, está pronto.`,
    eyebrow: 'Bilhete emitido',
    title: `${first}, o teu bilhete está pronto.`,
    intro: `Segue o bilhete e a factura da reserva <b>${esc(booking.reference)}</b>. No aeroporto, apresenta o passaporte.`,
    body: t.legs.map(leg => routeCard(leg, planeSrc)).join('') + ticketDetailsCard(t) + priceCard(t) + invoiceHtml(env, booking) + page,
  });
  const text = [
    `Bilhete emitido · ${booking.reference}`,
    ...t.legs.map(l => `${city(l.from)} (${l.from}) → ${city(l.to)} (${l.to}) · ${flightDay(l.departure)} · ${clock(l.departure)} → ${clock(l.arrival)} · Voo ${l.flight}`),
    `Código da reserva ${t.pnr}${t.ticketNumber ? ` · Bilhete ${t.ticketNumber}` : ''}`,
    `Total pago: ${kz(t.totalAoa)}`,
    pdfOf(env, booking) ? `Factura-recibo: ${pdfOf(env, booking)}` : '',
    t.pageUrl ? `Bilhete: ${t.pageUrl}` : '',
    `Ajuda: ${WHATSAPP}`,
  ].filter(Boolean).join('\n');
  return { subject: `O teu bilhete · ${fromTo(t)} · ${booking.reference}`, html, text, attachments: attachmentsOf(env, booking) };
}

// A4 page of the ticket (printed to PDF): one boarding-pass card per flight.
export function ticketPageHtml(env, booking, t, { printBar = false } = {}) {
  const base = baseOf(env);
  const plane = t.planeSrc || `${base}/assets/rota-aviao.png`;
  const line = (name, value, { strong = false, green = false } = {}) => `<tr class="${strong ? 'tot' : ''}"><td>${esc(name)}</td><td class="r${green ? ' g' : ''}">${value}</td></tr>`;
  const pass = (leg, index) => `<div class="bp"><div class="main">
  <div class="eyebrow">${leg.direction ? `${esc(leg.direction)} · ` : ''}${esc(longDay(leg.departure))} de ${esc(dayOf(leg.departure).slice(0, 4))}</div>
  <div class="rt">
    <div class="ap"><div class="code">${esc(leg.from)}</div><div class="name">${esc(city(leg.from))}${leg.terminal ? ` · ${esc(leg.terminal)}` : ''}</div><div class="time">${esc(clock(leg.departure))}</div><div class="day">Partida</div></div>
    <div class="mid"><small>${duration(leg.duration)}</small><img src="${esc(plane)}" alt=""><small>Voo directo</small></div>
    <div class="ap" style="text-align:right"><div class="code">${esc(leg.to)}</div><div class="name">${esc(city(leg.to))}</div><div class="time">${esc(clock(leg.arrival))}</div><div class="day">Chegada</div></div>
  </div>
  <div class="fl"><span>${esc(leg.airline)}</span><span>Voo <b>${esc(leg.flight)}</b></span><span>${esc(leg.cabin)}</span>${leg.checkinClose ? `<span>Check-in até <b>${esc(leg.checkinClose)}</b></span>` : ''}</div>
</div>
<div class="stub"><div><div class="l">Código da reserva</div><div class="pnr">${esc(t.pnr)}</div><div class="l">Passageiro</div><div class="s">${esc(t.passenger)}</div></div>
<div>${t.ticketNumber ? `<div class="l">Bilhete</div><div class="s" style="margin-bottom:0">${esc(t.ticketNumber)}</div>` : ''}</div></div></div>`;
  const bags = bagLines(t).map(b => `<div class="bag"><div class="n">${b.n}</div><div class="v">${esc(b.name)}</div><div class="sm">${esc(b.note)}</div></div>`).join('');
  const first = t.legs[0];
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bilhete ${esc(booking.reference)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Manrope:wght@700;800&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-family:${FONT};color:${INK}}
.page{width:210mm;min-height:297mm;position:relative;margin:0 auto;background:#faf9f6;padding-bottom:26mm}
.top{height:7mm;background:${GRADIENT}}
.in{padding:11mm 14mm 0}
.head{display:flex;justify-content:space-between;align-items:center}
.head img{height:12mm}
.doc{text-align:right}
.doc b{display:block;font:800 17px ${HEAD};letter-spacing:-.2px}
.doc span{font-size:11px;color:${MUTED}}
.bp{display:flex;margin-top:8mm;border-radius:6mm;overflow:hidden;background:${INK};color:#fff;break-inside:avoid}
.main{flex:1;padding:8mm 9mm 7mm}
.stub{width:50mm;background:${ORANGE};background-image:${GRADIENT};padding:8mm 6mm;position:relative;display:flex;flex-direction:column;justify-content:space-between}
.stub:before{content:"";position:absolute;left:-2.4mm;top:0;bottom:0;width:4.8mm;background:radial-gradient(circle at 50% 50%,#faf9f6 0 1.5mm,transparent 1.6mm) 0 0/4.8mm 6mm repeat-y}
.eyebrow{font:700 10px ${HEAD};letter-spacing:1.6px;text-transform:uppercase;color:#ffad00}
.rt{display:flex;align-items:flex-start;justify-content:space-between;margin-top:6mm}
.ap .code{font:800 46px/1 ${HEAD};letter-spacing:-1.5px}
.ap .name{font-size:12px;color:#c9ccc4;margin-top:6px}
.ap .time{font:800 22px ${HEAD};margin-top:5mm}
.ap .day{font-size:11px;color:#c9ccc4}
.mid{flex:1;text-align:center;padding:2mm 4mm 0}
.mid small{display:block;font-size:11px;color:#c9ccc4}
.mid img{width:100%;max-width:56mm;margin:2mm auto}
.fl{margin-top:7mm;padding-top:4mm;border-top:1px solid #45483f;font-size:12px;color:#c9ccc4;display:flex;gap:6mm;flex-wrap:wrap}
.fl b{color:#fff}
.stub .l{font-size:10px;color:#fff3e6;text-transform:uppercase;letter-spacing:1px}
.stub .pnr{font:800 30px/1.1 ${HEAD};letter-spacing:2px;margin:1mm 0 4mm}
.stub .s{font:700 14px ${HEAD};margin:1mm 0 4mm}
.sec{margin-top:5mm;background:#fff;border:1px solid ${LINE};border-radius:4mm;padding:6mm 7mm;break-inside:avoid}
.sec h3{margin:0 0 4mm;font:700 10px ${HEAD};letter-spacing:1.6px;text-transform:uppercase;color:${ORANGE}}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}
.v{font:600 13px/1.35 ${FONT}}
.sm{font-size:11px;color:${MUTED};font-weight:400;margin-top:.5mm}
.bag{border:1px solid ${LINE};border-radius:3mm;padding:4mm;background:#faf9f6}
.bag .n{font:800 20px ${HEAD};color:${ORANGE}}
.two{display:grid;grid-template-columns:1.15fr 1fr;gap:5mm;margin-top:5mm;break-inside:avoid}
.two .sec{margin-top:0}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:2.4mm 0;color:${MUTED}}td.r{text-align:right;color:${INK};font-weight:600}td.g{color:#1a8a4a}
tr.tot td{border-top:1px solid ${LINE};padding-top:3.2mm;color:${INK};font:700 14px ${HEAD}}tr.tot td.r{color:${ORANGE};font-size:18px;font-weight:800}
ul{margin:0;padding:0;list-style:none;font-size:12.5px;line-height:1.5}
li{padding:1.6mm 0 1.6mm 5mm;position:relative}li:before{content:"";position:absolute;left:0;top:3.3mm;width:2mm;height:2mm;border-radius:50%;background:${GRADIENT}}
.foot{position:absolute;left:14mm;right:14mm;bottom:9mm;display:flex;justify-content:space-between;align-items:flex-end;font-size:10.5px;color:${MUTED};border-top:1px solid ${LINE};padding-top:4mm}
.foot b{color:${INK}}
.bar{position:sticky;top:0;z-index:5;background:${INK};color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;font:600 14px ${FONT}}
.bar button{border:0;border-radius:10px;padding:10px 18px;font:700 14px ${HEAD};color:#fff;background:${GRADIENT};cursor:pointer}
@media print{.bar{display:none}}
</style></head><body>${printBar ? '<div class="bar"><span>O teu bilhete DOT Viagens</span><button type="button" onclick="window.print()">Guardar em PDF / imprimir</button></div>' : ''}<div class="page"><div class="top"></div><div class="in">
<div class="head"><img src="${esc(base)}/assets/logo-dot-320.png" alt="DOT Viagens"><div class="doc"><b>Bilhete electrónico</b><span>Reserva ${esc(booking.reference)} · emitido a ${esc(t.issuedAt)}</span></div></div>
${t.legs.map(pass).join('')}
${bags ? `<div class="sec"><h3>Bagagem incluída</h3><div class="g3">${bags}</div></div>` : ''}
<div class="two">
  <div class="sec"><h3>Pagamento</h3><table>
    ${line(`Passagem aérea · ${t.travellers}`, kz(t.fullAoa))}
    ${t.discountAoa ? line(t.discountLabel, `−${kz(t.discountAoa)}`, { green: true }) : ''}
    ${line('Total pago', kz(t.totalAoa), { strong: true })}
  </table><div class="sm" style="margin-top:2mm">Inclui taxas de aeroporto e da companhia. A factura-recibo segue em documento separado.</div></div>
  <div class="sec"><h3>Antes de viajar</h3><ul>
    <li>Leva o passaporte válido. É pedido no check-in.</li>
    <li>Chega ao aeroporto com 3 horas de antecedência.</li>
    ${first?.checkinClose ? `<li>O check-in fecha às ${esc(first.checkinClose)}.</li>` : ''}
    <li>Guarda este bilhete e o código ${esc(t.pnr)}.</li>
  </ul></div>
</div>
</div>
<div class="foot"><div><b>DOT Viagens</b> · Luanda, Angola<br>dotviagens.com · WhatsApp +244 931 343 433</div><div style="text-align:right">Bilhete emitido pela companhia aérea ${esc(first?.airline || '')}.<br>Reserva ${esc(booking.reference)}</div></div>
</div></body></html>`;
}

export const ticketEmail = async (env, store, booking, deps) => {
  const t = { ...ticketFromBooking(booking), pageUrl: await ticketUrl(env, booking) };
  return deliver(env, store, {
    key: `booking-${booking.reference}-ticket-${booking.ticket_pnr}`, to: booking.contact_email, purpose: 'ticket', bookingId: booking.id,
    withInvoice: Boolean(pdfOf(env, booking)), message: ticketMessage(env, booking, t),
  }, deps);
};