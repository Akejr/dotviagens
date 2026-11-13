// Purchase flow: quote -> booking saved as pending -> Wiza hosted checkout ->
// confirmation by GET status (or authenticated callback) -> SMS + Vero invoice.
// Ticket issuance is done by the DOT team in the admin (SerpApi does not issue tickets).

import { HttpError, json, readJson, assertSameOrigin, publicOrigin, defer, cleanText, cleanEmail } from './http.mjs';
import { db } from './supabase.mjs';
import { requireUser, secret } from './auth.mjs';
import { verifyItinerary, makeQuote, readQuote, QUOTE_TTL_MS } from './offers.mjs';
import { currentRate, currentMarkup, priceAoa } from './rates.mjs';
import { validatePassengers } from './passengers.mjs';
import { isGroup } from './places.mjs';
import { hasWiza, createCharge, paymentStatus, transactionInfo, wizaMessage } from './wiza.mjs';
import { hasVero, isVeroSandbox, ensureCustomer, issueInvoice, invoiceStatus } from './vero.mjs';
import { smsText } from './sms.mjs';
import { sendAndRecord } from './notify.mjs';
import { purchaseEmails, invoiceEmail, travellersText } from './emails.mjs';
import { sha256Hex, timingSafeEqual } from './crypto.mjs';

export const REFERENCE = /^DOT-\d{6}-\d{5,}$/;
// reference_id sent to Wiza: the booking reference, plus "-2", "-3"... on new attempts.
const ATTEMPT_REF = /^(DOT-\d{6}-\d{5,})(?:-\d{1,2})?$/;
const PAYMENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const knownCharges = row => [row.wiza_payment_id, ...(row.wiza_previous_ids || [])].filter(Boolean);
const MIN_KZ = 100;
// v2 quotes carry the DOT fee; older tokens (v1, without fee) must be refreshed.
const QUOTE_VERSION = 2;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BOOKINGS_PER_HOUR = 10;
const OPEN = ['pending_payment', 'payment_failed', 'expired'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const STATUS_LABEL = {
  pending_payment: 'A aguardar pagamento',
  paid: 'Pago · bilhete em emissão',
  payment_failed: 'Pagamento não concluído',
  expired: 'Expirada',
  ticketed: 'Bilhete emitido',
  cancelled: 'Cancelada',
  refunded: 'Reembolsada',
};

const offerSecret = env => secret(env, 'OFFER_SECRET');
const itineraryKey = itinerary => sha256Hex(`${itinerary?.outbound?.offer?.sig || ''}:${itinerary?.inbound?.offer?.sig || ''}`);
const nowIso = () => new Date().toISOString();

export async function logEvent(store, bookingId, source, outcome, payload = null) {
  await store.insert('payment_events', { booking_id: bookingId, source, outcome, payload }, { returning: false })
    .catch(error => console.error('payment event not saved:', error.message));
}

const publicQuery = q => ({ origin: q.origin, destination: q.destination, departureDate: q.departureDate, returnDate: q.returnDate, passengers: q.passengers, children: q.children || 0, cabin: q.cabin || 'economy' });

const publicLeg = leg => leg ? {
  airline: leg.airline,
  duration: leg.duration,
  stops: leg.stops,
  cabin: leg.cabin,
  logo: leg.logo ?? null,
  segments: (leg.segments || []).map(({ airline, number, from, to, departure, arrival, duration, logo }) => ({ airline, number, from, to, departure, arrival, duration, logo: logo ?? null })),
  layovers: leg.layovers || [],
} : null;

function lastTravelDate(verified) {
  const leg = verified.inbound || verified.outbound;
  const arrival = leg.offer.segments.at(-1)?.arrival?.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(arrival || '') ? arrival : verified.query.returnDate || verified.query.departureDate;
}

// Final price = converted value + DOT service fee (set in the admin). Only the total reaches the customer.
async function priceFor(env, deps, verified) {
  const [rate, markup] = await Promise.all([currentRate(env, deps, { fresh: true }), currentMarkup(env, deps, { fresh: true })]);
  if (!rate?.rate) {
    throw new HttpError(503, 'A compra está temporariamente indisponível: o câmbio do dia ainda não foi definido.', 'NO_RATE');
  }
  const price = priceAoa(verified.priceBrl, rate.rate, markup.markupBp);
  if (price.amountAoa < MIN_KZ) throw new HttpError(400, 'Valor demasiado baixo para pagamento.', 'AMOUNT_TOO_LOW');
  return { rate, ...price };
}

function parseInvoice(invoice) {
  if (!invoice || !invoice.nif) return null;
  const nif = String(invoice.nif).toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[0-9A-Z]{9,14}$/.test(nif)) throw new HttpError(400, 'Confirma o NIF para a factura.', 'INVALID_NIF');
  const name = cleanText(invoice.name, 120);
  if (name.length < 2) throw new HttpError(400, 'Indica o nome ou a empresa que deve constar na factura.', 'INVALID_INVOICE_NAME');
  return { nif, name };
}

const windowOpen = row => Boolean(row.wiza_created_at) && !row.wiza_window_closed && Date.now() - Date.parse(row.wiza_created_at) < WINDOW_MS;

// A pending Multicaixa reference can still be paid at the ATM: no second charge in that case.
const awaitingReference = row => row.status === 'pending_payment' && row.wiza_service === 'reference' && Boolean(row.wiza_atm_reference);

export const canRetry = row =>
  ['pending_payment', 'payment_failed'].includes(row.status) &&
  (row.payment_attempts || 0) < MAX_ATTEMPTS &&
  !awaitingReference(row) &&
  (row.status === 'payment_failed' || !row.wiza_payment_id || !windowOpen(row));

const mask = value => (value ? `${'•'.repeat(Math.max(0, value.length - 3))}${value.slice(-3)}` : '');

export function publicBooking(row, env) {
  const itinerary = row.itinerary || {};
  return {
    reference: row.reference,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    tripType: row.trip_type,
    origin: row.origin,
    destination: row.destination,
    departureDate: row.departure_date,
    returnDate: row.return_date,
    passengersCount: row.passengers_count,
    childrenCount: (row.booking_passengers || []).filter(p => p.passenger_type === 'child').length || Number(itinerary.query?.children) || 0,
    cabin: itinerary.query?.cabin || 'economy',
    amountAoa: Number(row.amount_aoa),
    contact: { name: row.contact_name, phone: row.contact_phone, email: row.contact_email },
    paymentMethod: row.payment_method === 'manual' ? 'manual' : 'wiza',
    itinerary: { outbound: publicLeg(itinerary.outbound), inbound: publicLeg(itinerary.inbound) },
    passengers: (row.booking_passengers || [])
      .sort((a, b) => a.position - b.position)
      .map(p => ({ type: p.passenger_type || 'adult', title: p.title, givenNames: p.given_names, surname: p.surname, nationality: p.nationality, documentNumber: mask(p.document_number) })),
    payment: {
      status: row.wiza_status,
      service: row.wiza_service,
      message: row.status === 'payment_failed' ? wizaMessage(row.wiza_status_code) : null,
      hostedUrl: row.status === 'pending_payment' && windowOpen(row) ? row.wiza_hosted_url : null,
      atmEntity: row.wiza_atm_entity,
      atmReference: row.wiza_atm_reference,
      windowOpen: windowOpen(row),
      canRetry: canRetry(row),
    },
    invoice: row.vero_invoice_id
      ? { number: row.vero_invoice_number, agtStatus: row.vero_agt_status, pdfUrl: isVeroSandbox(env) ? null : row.vero_pdf_url }
      : null,
    ticket: row.status === 'ticketed' ? { pnr: row.ticket_pnr, numbers: row.ticket_numbers, notes: row.ticket_notes, issuedAt: row.ticketed_at } : null,
  };
}

export async function quote(request, env, ctx, deps) {
  assertSameOrigin(request);
  const body = await readJson(request, 200000);
  const key = offerSecret(env);
  const verified = await verifyItinerary(key, body.itinerary);
  const { rate, baseAoa, feeAoa, amountAoa, markupBp } = await priceFor(env, deps, verified);
  const expiresAt = Date.now() + QUOTE_TTL_MS;
  const quoteToken = await makeQuote(key, {
    v: QUOTE_VERSION, h: await itineraryKey(body.itinerary), priceBrl: verified.priceBrl, rate: rate.rate, baseAoa, feeAoa, amountAoa, markupBp, exp: expiresAt,
  });
  // The customer sees only the final total; the breakdown stays in the signed token and the admin.
  return json({
    quoteToken,
    expiresAt: new Date(expiresAt).toISOString(),
    amountAoa,
    roundTrip: verified.roundTrip,
    query: publicQuery(verified.query),
    outbound: publicLeg(verified.outbound.stored),
    inbound: verified.inbound ? publicLeg(verified.inbound.stored) : null,
    lastTravelDate: lastTravelDate(verified),
    payments: hasWiza(env),
  });
}

async function startPayment(request, env, store, booking, deps) {
  const attempt = (booking.payment_attempts || 0) + 1;
  if (attempt > MAX_ATTEMPTS) {
    throw new HttpError(429, 'Atingiste o limite de tentativas de pagamento desta reserva. Fala com a equipa DOT.', 'PAYMENT_ATTEMPTS');
  }
  const referenceId = attempt === 1 ? booking.reference : `${booking.reference}-${attempt}`;
  const origin = publicOrigin(request, env);
  const back = `${origin}/compra?ref=${encodeURIComponent(booking.reference)}`;
  const charge = await createCharge(env, {
    amountAoa: Number(booking.amount_aoa),
    referenceId,
    phone: booking.contact_phone,
    callbackUrl: `${origin}/api/payments/wiza/callback?k=${encodeURIComponent(env.WIPAY_WEBHOOK_SECRET)}`,
    successUrl: back,
    failureUrl: `${back}&r=falhou`,
  }, deps.fetcher);
  const [updated] = await store.update('bookings', { id: `eq.${booking.id}`, status: `in.(${OPEN.join(',')})` }, {
    status: 'pending_payment',
    // A manual (WhatsApp) booking that later pays on the Wiza page becomes a Wiza payment.
    payment_method: 'wiza',
    payment_attempts: attempt,
    wiza_reference_id: referenceId,
    // Earlier charges stay linked: their callbacks must still find this booking.
    wiza_previous_ids: [...(booking.wiza_previous_ids || []), booking.wiza_payment_id].filter(Boolean).slice(-MAX_ATTEMPTS),
    wiza_payment_id: charge.id,
    wiza_nonce: charge.nonce,
    wiza_hosted_url: charge.hostedUrl,
    wiza_status: 'requested',
    wiza_status_code: null,
    wiza_service: null,
    wiza_atm_entity: null,
    wiza_atm_reference: null,
    wiza_window_closed: false,
    wiza_created_at: nowIso(),
  });
  if (!updated) throw new HttpError(409, 'Esta reserva já não aceita pagamentos.', 'BOOKING_CLOSED');
  await logEvent(store, booking.id, 'create', 'charge_created', { attempt, referenceId, paymentId: charge.id });
  return updated;
}

export async function createBooking(request, env, ctx, deps) {
  assertSameOrigin(request);
  const session = await requireUser(request, env, deps);
  const body = await readJson(request, 200000);
  const key = offerSecret(env);
  const verified = await verifyItinerary(key, body.itinerary);
  const quoted = await readQuote(key, body.quoteToken);
  if (quoted.v !== QUOTE_VERSION) {
    throw new HttpError(409, 'A cotação expirou. Revê o preço actualizado antes de pagar.', 'QUOTE_EXPIRED');
  }
  if (quoted.h !== await itineraryKey(body.itinerary) || quoted.priceBrl !== verified.priceBrl) {
    throw new HttpError(400, 'A cotação não corresponde à viagem seleccionada.', 'QUOTE_MISMATCH');
  }
  // 'wiza': Multicaixa Express or reference on the Wiza page. 'manual': agreed with the DOT team on
  // WhatsApp; the booking is saved the same way and the admin confirms the payment by hand.
  const paymentMethod = body.paymentMethod === 'manual' ? 'manual' : 'wiza';
  if (paymentMethod === 'wiza' && !hasWiza(env)) throw new HttpError(503, 'Os pagamentos ainda não estão configurados.', 'PAYMENTS_NOT_CONFIGURED');

  const contactName = cleanText(body.contact?.name, 80);
  const contactEmail = cleanEmail(body.contact?.email);
  if (contactName.length < 3) throw new HttpError(400, 'Indica o nome completo do contacto.', 'INVALID_CONTACT');
  if (!contactEmail) throw new HttpError(400, 'Indica um e-mail válido.', 'INVALID_EMAIL');
  const q = verified.query;
  const passengers = validatePassengers(body.passengers, { count: q.passengers, children: q.children || 0, departureDate: q.departureDate, lastTravelDate: lastTravelDate(verified) });
  const invoice = parseInvoice(body.invoice);
  if (body.accept !== true) throw new HttpError(400, 'Confirma que os dados dos passageiros estão correctos.', 'NOT_ACCEPTED');

  const store = db(env, deps.fetcher);
  // Each booking may open a Wiza charge or a WhatsApp conversation: limit how many one account creates per hour.
  const { total: lastHour } = await store.selectCount('bookings', {
    select: 'id',
    customer_id: `eq.${session.customer.id}`,
    created_at: `gte.${new Date(Date.now() - 3600e3).toISOString()}`,
    limit: 1,
  });
  if (lastHour >= BOOKINGS_PER_HOUR) {
    throw new HttpError(429, 'Criaste muitas reservas na última hora. Tenta mais tarde ou fala com a equipa DOT.', 'BOOKING_LIMIT');
  }
  // Law 1 of the payment guide: the sale exists in our database before any gateway call.
  const [booking] = await store.insert('bookings', {
    customer_id: session.customer.id,
    status: 'pending_payment',
    channel: deps.channel === 'ai' ? 'ai' : 'site',
    contact_name: contactName,
    contact_phone: session.customer.phone,
    contact_email: contactEmail,
    trip_type: verified.roundTrip ? 'return' : 'oneway',
    // A search to a whole country or city records the airports actually flown (the itinerary keeps the query).
    origin: isGroup(q.origin) ? verified.outbound.offer.segments[0].from : q.origin,
    destination: isGroup(q.destination) ? verified.outbound.offer.segments.at(-1).to : q.destination,
    departure_date: q.departureDate,
    return_date: q.returnDate,
    passengers_count: q.passengers + (q.children || 0),
    itinerary: {
      outbound: verified.outbound.stored,
      inbound: verified.inbound?.stored ?? null,
      query: q,
      searchedAt: { outbound: verified.outbound.searchedAt, inbound: verified.inbound?.searchedAt ?? null },
    },
    price_brl: verified.priceBrl,
    exchange_rate: quoted.rate,
    base_aoa: quoted.baseAoa,
    fee_aoa: quoted.feeAoa,
    markup_bp: quoted.markupBp,
    amount_aoa: quoted.amountAoa,
    invoice_nif: invoice?.nif ?? null,
    invoice_name: invoice?.name ?? null,
    payment_method: paymentMethod,
  });
  await store.insert('booking_passengers', passengers.map((p, index) => ({
    booking_id: booking.id,
    position: index + 1,
    passenger_type: p.type,
    title: p.title,
    given_names: p.givenNames,
    surname: p.surname,
    birth_date: p.birthDate,
    nationality: p.nationality,
    document_type: 'passport',
    document_number: p.documentNumber,
    document_country: p.documentCountry,
    document_expiry: p.documentExpiry,
  })), { returning: false });
  if (!session.customer.name || !session.customer.email) {
    await store.update('customers', { id: `eq.${session.customer.id}` }, {
      ...(session.customer.name ? {} : { name: contactName }),
      ...(session.customer.email ? {} : { email: contactEmail }),
    }).catch(() => {});
  }
  await logEvent(store, booking.id, 'create', 'booking_created', {
    amountAoa: quoted.amountAoa, baseAoa: quoted.baseAoa, feeAoa: quoted.feeAoa, markupBp: quoted.markupBp, rate: quoted.rate, priceBrl: verified.priceBrl, paymentMethod,
  });

  if (paymentMethod === 'manual') {
    // No gateway call: the customer continues on WhatsApp with the booking reference.
    await logEvent(store, booking.id, 'create', 'manual_requested', null);
    return json({ reference: booking.reference, amountAoa: Number(booking.amount_aoa), paymentMethod, hostedUrl: null }, 201);
  }

  try {
    const started = await startPayment(request, env, store, booking, deps);
    return json({ reference: booking.reference, amountAoa: Number(booking.amount_aoa), hostedUrl: started.wiza_hosted_url }, 201);
  } catch (error) {
    await logEvent(store, booking.id, 'create', 'charge_failed', { code: error.code || 'error' });
    return json({ reference: booking.reference, amountAoa: Number(booking.amount_aoa), hostedUrl: null, paymentError: error.message || 'Não foi possível iniciar o pagamento.' }, 201);
  }
}

export async function confirmPayment(env, store, booking, details, source, ctx, deps) {
  const now = nowIso();
  const [won] = await store.update('bookings', { id: `eq.${booking.id}`, status: `in.(${OPEN.join(',')})` }, {
    status: 'paid',
    paid_at: now,
    needs_review: false,
    wiza_status: 'accepted',
    wiza_status_code: details.code ?? '2000',
    wiza_service: details.service ?? booking.wiza_service ?? null,
    wiza_paid_payment_id: details.chargeId ?? booking.wiza_payment_id ?? null,
    wiza_checked_at: now,
  });
  // Only the request that flips the status delivers: poller and callback never deliver twice.
  if (!won) return (await store.one('bookings', { select: '*', id: `eq.${booking.id}` })) || booking;
  await logEvent(store, booking.id, source, 'confirmed', details);
  defer(ctx, afterPayment(env, store, won, deps));
  return won;
}

async function afterPayment(env, store, booking, deps) {
  // The e-mails need the passengers (the confirmed row comes without them).
  const passengers = await store.select('booking_passengers', { select: '*', booking_id: `eq.${booking.id}`, order: 'position.asc' }).catch(() => []);
  // The team hears of the sale at once; the customer's e-mail waits for the invoice (below).
  await purchaseEmails.admin(env, store, { ...booking, booking_passengers: passengers }, deps).catch(error => console.error('admin e-mail failed:', error.code || error.message));
  await sendAndRecord(env, store, {
    phone: booking.contact_phone,
    text: smsText.paid(booking.reference, Number(booking.amount_aoa)),
    category: 'TRANSACTIONAL',
    purpose: 'payment_confirmed',
    idempotencyKey: `booking-${booking.reference}-paid`,
    bookingId: booking.id,
  }, deps).catch(error => console.error('payment sms failed:', error.code || error.message));
  // Law 3: the invoice comes after the confirmation and its failure never cancels the sale.
  const invoiced = await issueBookingInvoice(env, store, booking, deps).catch(error => {
    console.error('invoice failed:', error.code || error.message);
    return null;
  });
  // Purchase confirmation with the invoice; without it, the invoice follows in its own e-mail.
  await purchaseEmails.customer(env, store, { ...booking, ...(invoiced || {}), booking_passengers: passengers }, deps)
    .catch(error => console.error('customer e-mail failed:', error.code || error.message));
}

// An invoice issued later (sweep or admin): sent by e-mail when the confirmation went without it.
export async function sendLateInvoice(env, store, booking, deps) {
  if (!booking?.vero_invoice_id) return;
  await invoiceEmail(env, store, booking, deps).catch(error => console.error('invoice e-mail failed:', error.code || error.message));
}

const invoiceDescription = b => {
  const children = Number(b.itinerary?.query?.children) || 0;
  return `Passagem aérea ${b.origin}-${b.destination}${b.trip_type === 'return' ? `-${b.origin}` : ''} · ${travellersText(b.passengers_count - children, children)} · ${b.reference}`;
};

export async function issueBookingInvoice(env, store, booking, deps, { poll = true } = {}) {
  if (!['paid', 'ticketed'].includes(booking.status)) return booking;
  if (!hasVero(env)) {
    const [row] = await store.update('bookings', { id: `eq.${booking.id}` }, { vero_error: 'not_configured' });
    return row || booking;
  }
  let current = booking;
  try {
    if (!current.vero_invoice_id) {
      const customerId = current.vero_customer_id || await ensureCustomer(env, { nif: current.invoice_nif, name: current.invoice_name }, deps.fetcher);
      const invoice = await issueInvoice(env, {
        customerId,
        reference: current.reference,
        description: invoiceDescription(current),
        amountAoa: Number(current.amount_aoa),
        consumidorFinal: !current.invoice_nif,
      }, deps.fetcher);
      [current] = await store.update('bookings', { id: `eq.${current.id}` }, {
        vero_customer_id: customerId,
        vero_invoice_id: invoice.id,
        vero_invoice_number: invoice.number,
        vero_pdf_url: invoice.pdfUrl,
        vero_agt_status: invoice.agtStatus,
        vero_error: null,
        invoiced_at: nowIso(),
      });
    }
    // No webhook for the AGT result: poll a few times, then the admin can refresh.
    if (poll && !isVeroSandbox(env) && current.vero_invoice_id && (current.vero_agt_status === 'pending' || current.vero_agt_status == null)) {
      for (const wait of [1500, 3000, 5000]) {
        await sleep(wait);
        const status = await invoiceStatus(env, current.vero_invoice_id, deps.fetcher);
        if (status.agtStatus && status.agtStatus !== 'pending') {
          [current] = await store.update('bookings', { id: `eq.${current.id}` }, {
            vero_agt_status: status.agtStatus,
            vero_invoice_number: status.number || current.vero_invoice_number,
            vero_error: status.agtStatus === 'rejected' ? JSON.stringify(status.agtErrors || []).slice(0, 500) : null,
          });
          break;
        }
      }
    }
    return current;
  } catch (error) {
    await store.update('bookings', { id: `eq.${current.id}` }, { vero_error: String(error.code || error.message || 'error').slice(0, 300) }).catch(() => {});
    throw error;
  }
}

export async function refreshInvoiceStatus(env, store, booking, deps) {
  if (!booking.vero_invoice_id) return issueBookingInvoice(env, store, booking, deps, { poll: false });
  const status = await invoiceStatus(env, booking.vero_invoice_id, deps.fetcher);
  const [row] = await store.update('bookings', { id: `eq.${booking.id}` }, {
    vero_agt_status: status.agtStatus,
    vero_invoice_number: status.number || booking.vero_invoice_number,
    vero_error: status.agtStatus === 'rejected' ? JSON.stringify(status.agtErrors || []).slice(0, 500) : null,
  });
  return row || booking;
}

// Asks Wiza for the real state. Safe to call many times (client poll, callback, admin, sweep).
export async function syncPayment(env, store, booking, source, ctx, deps, known = null) {
  if (!booking.wiza_payment_id || !OPEN.includes(booking.status)) return booking;
  // After ~5 minutes the GET always answers 404: only the authenticated callback can confirm.
  if (!known && booking.wiza_window_closed) return booking;
  const status = known || await paymentStatus(env, booking.wiza_payment_id, deps.fetcher);
  const now = nowIso();
  if (status.outsideWindow) {
    if (booking.wiza_window_closed) return booking;
    const [row] = await store.update('bookings', { id: `eq.${booking.id}` }, { wiza_window_closed: true, wiza_checked_at: now });
    return row || booking;
  }
  if (status.status === 'accepted') return confirmPayment(env, store, booking, { code: status.code, service: status.service }, source, ctx, deps);
  if (status.status === 'rejected') {
    const [row] = await store.update('bookings', { id: `eq.${booking.id}`, status: 'eq.pending_payment' }, {
      status: 'payment_failed', wiza_status: 'rejected', wiza_status_code: status.code, wiza_service: status.service, wiza_checked_at: now,
    });
    if (row) await logEvent(store, booking.id, source, 'rejected', { code: status.code, service: status.service });
    return row || booking;
  }
  const patch = {};
  if ((status.status || 'requested') !== booking.wiza_status) patch.wiza_status = status.status || 'requested';
  if (status.service && status.service !== booking.wiza_service) patch.wiza_service = status.service;
  if (status.service === 'reference' && !booking.wiza_atm_reference) {
    const info = await transactionInfo(env, booking.wiza_payment_id, deps.fetcher).catch(() => null);
    if (info?.reference) {
      patch.wiza_atm_reference = String(info.reference).slice(0, 40);
      if (info.entity) patch.wiza_atm_entity = String(info.entity).slice(0, 20);
    }
  }
  if (!Object.keys(patch).length) return booking;
  patch.wiza_checked_at = now;
  const [row] = await store.update('bookings', { id: `eq.${booking.id}` }, patch);
  return row || booking;
}

async function ownedBooking(request, env, deps, reference) {
  if (!REFERENCE.test(reference || '')) throw new HttpError(404, 'Reserva não encontrada.', 'NOT_FOUND');
  const session = await requireUser(request, env, deps);
  const store = db(env, deps.fetcher);
  const row = await store.one('bookings', { select: '*,booking_passengers(*)', reference: `eq.${reference}` });
  if (!row || (row.customer_id !== session.customer.id && session.customer.role !== 'admin')) {
    throw new HttpError(404, 'Reserva não encontrada.', 'NOT_FOUND');
  }
  return { session, store, row };
}

export async function listMyBookings(request, env, ctx, deps) {
  const session = await requireUser(request, env, deps);
  const rows = await db(env, deps.fetcher).select('bookings', {
    select: '*,booking_passengers(*)',
    customer_id: `eq.${session.customer.id}`,
    order: 'created_at.desc',
    limit: 50,
  });
  return json({ bookings: rows.map(row => publicBooking(row, env)) });
}

export async function getMyBooking(request, env, ctx, deps) {
  const { row } = await ownedBooking(request, env, deps, deps.params[0]);
  return json({ booking: publicBooking(row, env) });
}

export async function checkBooking(request, env, ctx, deps) {
  assertSameOrigin(request);
  const { store, row } = await ownedBooking(request, env, deps, deps.params[0]);
  let current = row;
  try {
    current = { ...row, ...(await syncPayment(env, store, row, 'poll', ctx, deps)) };
  } catch (error) {
    console.error('payment check failed:', error.code || error.message);
  }
  current.booking_passengers = row.booking_passengers;
  return json({ booking: publicBooking(current, env) });
}

export async function retryPayment(request, env, ctx, deps) {
  assertSameOrigin(request);
  const { store, row } = await ownedBooking(request, env, deps, deps.params[0]);
  if (!canRetry(row)) throw new HttpError(409, 'Esta reserva não aceita um novo pagamento agora.', 'RETRY_NOT_ALLOWED');
  if (!hasWiza(env)) throw new HttpError(503, 'Os pagamentos ainda não estão configurados.', 'PAYMENTS_NOT_CONFIGURED');
  const started = await startPayment(request, env, store, row, deps);
  return json({ reference: row.reference, hostedUrl: started.wiza_hosted_url });
}

export async function wizaCallback(request, env, ctx, deps) {
  const ok = () => json({ ok: true });
  try {
    const url = new URL(request.url);
    const raw = (await request.text()).slice(0, 20000);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const data = body?.data && typeof body.data === 'object' ? { ...body, ...body.data } : body || {};
    const rawId = String(data.id || data.payment_id || '').slice(0, 100);
    const paymentId = PAYMENT_ID.test(rawId) ? rawId : '';
    const referenceId = String(data.reference_id || '').slice(0, 100);
    const store = db(env, deps.fetcher);
    // The charge may be the current one or an earlier attempt of the same booking.
    let booking = paymentId
      ? await store.one('bookings', { select: '*', or: `(wiza_payment_id.eq.${paymentId},wiza_previous_ids.cs.{${paymentId}})` })
      : null;
    const baseReference = referenceId.match(ATTEMPT_REF)?.[1];
    if (!booking && baseReference) booking = await store.one('bookings', { select: '*', reference: `eq.${baseReference}` });
    const secretOk = Boolean(env.WIPAY_WEBHOOK_SECRET) && timingSafeEqual(url.searchParams.get('k') || '', env.WIPAY_WEBHOOK_SECRET);
    const accepted = String(data.status || '').toLowerCase() === 'accepted';
    const summary = { paymentId: rawId, referenceId, status: data.status ?? null, amount: data.amount ?? null, secretOk };
    if (!booking) {
      await logEvent(store, null, 'callback', 'unknown_booking', summary);
      return ok();
    }
    if (!secretOk) {
      await logEvent(store, booking.id, 'callback', 'bad_secret', summary);
      return ok();
    }
    // Only charges created by us for this booking count (the customer never sees these UUIDs).
    const chargeId = paymentId && knownCharges(booking).some(id => timingSafeEqual(id, paymentId)) ? paymentId : null;
    if (!OPEN.includes(booking.status)) {
      // Already paid or closed: a second accepted charge means the customer may have paid twice.
      const otherCharge = accepted && chargeId && chargeId !== (booking.wiza_paid_payment_id || booking.wiza_payment_id);
      await logEvent(store, booking.id, 'callback', otherCharge ? 'possible_double_payment' : 'already_final', { ...summary, chargeId });
      if (otherCharge) await store.update('bookings', { id: `eq.${booking.id}` }, { needs_review: true }).catch(() => {});
      return ok();
    }
    let status = null;
    try {
      status = await paymentStatus(env, chargeId || booking.wiza_payment_id, deps.fetcher);
    } catch {
      await logEvent(store, booking.id, 'callback', 'get_failed', summary);
      await store.update('bookings', { id: `eq.${booking.id}` }, { needs_review: true }).catch(() => {});
      return ok();
    }
    if (!status.outsideWindow) {
      // Inside the window the GET decides; the callback is only a nudge.
      await logEvent(store, booking.id, 'callback', 'verified_by_get', { ...summary, getStatus: status.status, chargeId });
      if (chargeId && chargeId !== booking.wiza_payment_id) {
        // An earlier attempt of this booking: only its acceptance matters.
        if (status.status === 'accepted') await confirmPayment(env, store, booking, { code: status.code, service: status.service, chargeId }, 'callback', ctx, deps);
      } else {
        await syncPayment(env, store, booking, 'callback', ctx, deps, status);
      }
      return ok();
    }
    // Outside the window (typical for Referência): secret + payment UUID + amount, together.
    const amountOk = Math.abs(Number(data.amount) - Number(booking.amount_aoa)) < 0.005;
    if (chargeId && amountOk && accepted) {
      await confirmPayment(env, store, booking, { code: String(data.status_code || '2000'), service: data.service || 'reference', chargeId }, 'callback', ctx, deps);
      return ok();
    }
    await logEvent(store, booking.id, 'callback', 'needs_review', { ...summary, idOk: Boolean(chargeId), amountOk, accepted });
    await store.update('bookings', { id: `eq.${booking.id}` }, { needs_review: true }).catch(() => {});
    return ok();
  } catch (error) {
    console.error('wiza callback failed:', error?.message);
    return ok();
  }
}

export async function runSweep(env, ctx, deps) {
  const store = db(env, deps.fetcher);
  const since = new Date(Date.now() - 7 * 60 * 1000).toISOString();
  const pending = await store.select('bookings', { select: '*', status: 'eq.pending_payment', wiza_created_at: `gte.${since}`, limit: 20 });
  let confirmed = 0;
  for (const booking of pending) {
    const result = await syncPayment(env, store, booking, 'sweep', ctx, deps).catch(() => booking);
    if (result.status === 'paid') confirmed += 1;
  }
  // Sales registered by hand (made outside the site) never get an automatic invoice.
  const missing = await store.select('bookings', {
    select: '*',
    status: 'in.(paid,ticketed)',
    imported: 'is.false',
    vero_invoice_id: 'is.null',
    paid_at: `gte.${new Date(Date.now() - 3 * 86400e3).toISOString()}`,
    limit: 5,
  });
  for (const booking of missing) {
    const row = await issueBookingInvoice(env, store, booking, deps, { poll: false }).catch(() => null);
    if (row?.vero_invoice_id) await sendLateInvoice(env, store, row, deps);
  }
  return { checked: pending.length, confirmed, invoicesRetried: missing.length };
}

export async function sweep(request, env, ctx, deps) {
  // x-cron-secret (own scheduler) or Authorization: Bearer (Vercel Cron Jobs).
  const bearer = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const provided = request.headers.get('x-cron-secret') || bearer;
  if (!env.CRON_SECRET || String(env.CRON_SECRET).length < 16 || !timingSafeEqual(provided, env.CRON_SECRET)) {
    throw new HttpError(403, 'Pedido não permitido.', 'FORBIDDEN');
  }
  return json(await runSweep(env, ctx, deps));
}
