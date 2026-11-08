// Minhas viagens: sign in with the phone (SMS code), then the trips in two tabs (next / past).
// Each card shows only the route, the dates, the status and the one thing to do. Everything else
// (flights, passengers, payment, invoice) opens in a side panel, a bottom sheet on phones.
import { api, auth, esc, formatKz, formatDate, formatPhone, duration, stickyHeader } from './api.js';
import { icon } from './icons.js';
import { mountOtp } from './otp-widget.js';
import { loadAirports } from './airports.js';
import { airlineMark } from './itinerary-ui.js';
import { bookingLink } from './whatsapp.js';

const $ = selector => document.querySelector(selector);
const root = $('#trips');
const sheet = $('#trip-sheet');
const WHATSAPP = 'https://wa.me/244931343433';
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const CLOSED = ['cancelled', 'refunded', 'expired'];
// Short, customer-facing status (tone = colour of the pill).
const STATUS = {
  pending_payment: { label: 'Por pagar', tone: 'warn' },
  payment_failed: { label: 'Pagamento não concluído', tone: 'error' },
  paid: { label: 'Bilhete em emissão', tone: 'info' },
  ticketed: { label: 'Bilhete emitido', tone: 'ok' },
  expired: { label: 'Expirada', tone: 'muted' },
  cancelled: { label: 'Cancelada', tone: 'muted' },
  refunded: { label: 'Reembolsada', tone: 'muted' },
};
let cities = {};
let bookings = [];
let customer = null;
let tab = null;
let openRef = new URLSearchParams(location.search).get('ref');

document.querySelectorAll('[data-icon]').forEach(element => { element.outerHTML = icon(element.dataset.icon, 16); });
stickyHeader('.header');
document.addEventListener('error', event => {
  if (event.target.matches?.('.airline-logo')) {
    const fallback = document.createElement('span');
    fallback.className = 'logo-fallback';
    fallback.textContent = (event.target.alt || 'AV').slice(0, 2).toUpperCase();
    event.target.replaceWith(fallback);
  }
}, true);

const city = code => cities[code] || code;
const clock = value => String(value || '').slice(11, 16);
const dayOf = value => String(value || '').slice(0, 10);
const thisYear = new Date().getFullYear();
function shortDay(iso, withWeekday = false) {
  if (!iso) return '';
  const [year, month, day] = dayOf(iso).split('-').map(Number);
  const weekday = withWeekday ? `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}, ` : '';
  return `${weekday}${day} ${MONTHS[month - 1]}${year !== thisYear ? ` ${year}` : ''}`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dayShift = (from, to) => Math.round((Date.parse(dayOf(to)) - Date.parse(dayOf(from))) / 86400000);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' }).format(new Date());
const isUpcoming = booking => !CLOSED.includes(booking.status) && (booking.returnDate || booking.departureDate) >= today;
const statusOf = booking => STATUS[booking.status] || { label: booking.statusLabel || booking.status, tone: 'muted' };
const payHref = booking => `/compra?ref=${encodeURIComponent(booking.reference)}`;
const routeHtml = booking => `${esc(city(booking.origin))} <i aria-hidden="true">→</i> ${esc(city(booking.destination))}`;
const tripLine = booking => `${booking.returnDate ? `${shortDay(booking.departureDate)} → ${shortDay(booking.returnDate)}` : shortDay(booking.departureDate)} · ${booking.tripType === 'return' ? 'Ida e volta' : 'Só ida'} · ${plural(booking.passengersCount, 'adulto', 'adultos')}`;
const whatsappButton = booking => `<a class="primary whatsapp-btn" href="${esc(bookingLink(booking, city))}" target="_blank" rel="noopener"><img class="wa-glyph" src="/assets/payments/whatsapp.svg" width="18" height="18" alt=""> Pagar pelo WhatsApp</a>`;

// ── List ──────────────────────────────────────────────────────────────────────
// Bottom of the card: one fact, plus the action when the customer has something to do.
function cardFoot(booking) {
  const payment = booking.payment || {};
  if (booking.status === 'ticketed') return `<span class="trip-fact"><small>Código da reserva</small><b class="pnr">${esc(booking.ticket?.pnr || '—')}</b></span>`;
  if (booking.status === 'paid') return '<span class="trip-fact"><small>Pagamento confirmado</small><b>Estamos a emitir o bilhete</b></span>';
  if (booking.status === 'pending_payment') {
    const action = booking.paymentMethod === 'manual'
      ? whatsappButton(booking)
      : payment.atmReference
        ? `<button class="primary trip-pay" type="button" data-open="${esc(booking.reference)}">Ver referência</button>`
        : `<a class="primary trip-pay" href="${payHref(booking)}">Pagar</a>`;
    return `<span class="trip-fact"><small>Total a pagar</small><b>${formatKz(booking.amountAoa)}</b></span>${action}`;
  }
  if (booking.status === 'payment_failed') {
    return `<span class="trip-fact"><small>Total</small><b>${formatKz(booking.amountAoa)}</b></span>${payment.canRetry ? `<a class="primary trip-pay" href="${payHref(booking)}">Tentar novamente</a>` : ''}`;
  }
  return `<span class="trip-fact"><small>Reserva</small><b>${esc(booking.reference)}</b></span>`;
}

function tripCard(booking) {
  const status = statusOf(booking);
  const leg = booking.itinerary?.outbound;
  return `<article class="trip ${status.tone}">
    <button class="trip-open" type="button" data-open="${esc(booking.reference)}" aria-haspopup="dialog">
      <span class="trip-logo">${leg?.segments?.length ? airlineMark(leg) : icon('plane', 20)}</span>
      <span class="trip-main"><span class="trip-top"><strong class="trip-title">${routeHtml(booking)}</strong><span class="trip-status ${status.tone}">${esc(status.label)}</span></span>
        <span class="trip-when">${esc(tripLine(booking))}</span></span>
      <span class="trip-chevron" aria-hidden="true">${icon('chevronRight', 18)}</span>
    </button>
    <div class="trip-foot">${cardFoot(booking)}</div>
  </article>`;
}

const tabButton = (key, label, count) => `<button type="button" role="tab" id="tab-${key}" aria-selected="${tab === key}" data-tab="${key}">${label} <span>${count}</span></button>`;

function emptyTab() {
  return tab === 'upcoming'
    ? `<div class="trips-none">${icon('plane', 18)}<span>Sem viagens marcadas.</span><a class="link-btn" href="/#pesquisa">Pesquisar voos ${icon('arrowRight', 14)}</a></div>`
    : `<div class="trips-none">${icon('clock', 18)}<span>Ainda sem viagens anteriores.</span></div>`;
}

function render() {
  const upcoming = bookings.filter(isUpcoming);
  const past = bookings.filter(booking => !isUpcoming(booking));
  if (!tab) tab = upcoming.length || !past.length ? 'upcoming' : 'past';
  const list = tab === 'upcoming' ? upcoming : past;
  const firstName = String(customer.name || '').trim().split(/\s+/)[0];
  root.innerHTML = `<header class="trips-head"><div><p class="trips-hello">${firstName ? `Olá, ${esc(firstName)}` : 'Olá!'} <span>· ${esc(formatPhone(customer.phone))}</span></p><h1>Minhas viagens</h1></div>
      <div class="trips-head-actions"><a class="primary" href="/#pesquisa">${icon('search', 15)} Nova viagem</a><button class="trips-logout" id="logout" type="button">${icon('logout', 15)} Sair</button></div></header>
    ${bookings.length
      ? `<div class="trips-tabs" role="tablist" aria-label="Viagens">${tabButton('upcoming', 'Próximas', upcoming.length)}${tabButton('past', 'Anteriores', past.length)}</div>
        <div class="trip-list" role="tabpanel" aria-labelledby="tab-${tab}">${list.length ? list.map(tripCard).join('') : emptyTab()}</div>`
      : `<div class="trips-empty"><span class="trips-empty-icon">${icon('ticket', 26)}</span><h2>Ainda não tens viagens</h2><p>Quando comprares uma passagem com este número, ela aparece aqui.</p><a class="primary" href="/#pesquisa">${icon('search', 16)} Pesquisar voos</a></div>`}`;
  $('#logout').onclick = async () => {
    await auth.logout().catch(() => {});
    if (sheet.open) sheet.close();
    customer = null;
    bookings = [];
    tab = null;
    login();
  };
  root.querySelectorAll('[data-tab]').forEach(button => {
    button.onclick = () => {
      tab = button.dataset.tab;
      render();
    };
  });
  root.querySelectorAll('[data-open]').forEach(button => { button.onclick = () => openSheet(button.dataset.open); });
}

// ── Details panel ─────────────────────────────────────────────────────────────
function legHtml(leg, label) {
  const segments = leg?.segments || [];
  if (!segments.length) return '';
  const first = segments[0];
  const last = segments.at(-1);
  const shift = dayShift(first.departure, last.arrival);
  const flights = segments.map(segment => `${esc(segment.airline)} ${esc(segment.number)}`).join(' · ');
  const layovers = (leg.layovers || []).slice(0, segments.length - 1).map(layover => `Conexão de ${duration(layover.duration)} em ${esc(city(layover.airport))}`).join(' · ');
  return `<div class="sheet-leg"><div class="sheet-leg-head"><b>${label}</b><span>${esc(shortDay(first.departure, true))}</span></div>
    <div class="sheet-leg-route"><div><strong>${esc(clock(first.departure))}</strong><span>${esc(city(first.from))} (${esc(first.from)})</span></div>
      <div class="sheet-leg-line" aria-hidden="true"><small>${leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'Directo'} · ${duration(leg.duration)}</small></div>
      <div class="to"><strong>${esc(clock(last.arrival))}${shift > 0 ? `<sup>+${shift}</sup>` : ''}</strong><span>${esc(city(last.to))} (${esc(last.to)})</span></div></div>
    <p class="sheet-leg-flights">${flights}${layovers ? `<br>${layovers}` : ''}</p></div>`;
}

// The one thing to know (or do) about this booking.
function statusBox(booking) {
  const payment = booking.payment || {};
  if (booking.status === 'ticketed') {
    const ticket = booking.ticket || {};
    return `<div class="sheet-box ok"><small>Código da reserva</small><strong class="pnr">${esc(ticket.pnr || '—')}</strong>
      <p>Apresenta este código e o passaporte no check-in da companhia aérea.</p>
      ${ticket.numbers ? `<p class="sheet-note">Número do bilhete: ${esc(ticket.numbers)}</p>` : ''}${ticket.notes ? `<p class="sheet-note">${esc(ticket.notes)}</p>` : ''}</div>`;
  }
  if (booking.status === 'paid') return '<div class="sheet-box info"><p><b>Pagamento confirmado.</b> Estamos a emitir o teu bilhete e avisamos-te por SMS assim que estiver pronto.</p></div>';
  if (booking.status === 'pending_payment' && booking.paymentMethod === 'manual') {
    return `<div class="sheet-box warn"><p><b>Por pagar.</b> Combina o pagamento de ${formatKz(booking.amountAoa)} com a equipa DOT no WhatsApp. A reserva espera até 72 horas.</p>${whatsappButton(booking)}</div>`;
  }
  if (booking.status === 'pending_payment' && payment.atmReference) {
    return `<div class="sheet-box warn"><p><b>Paga por referência</b> no ATM, no Multicaixa Express ou no internet banking.</p>
      <dl class="sheet-atm"><div><dt>Entidade</dt><dd>${esc(payment.atmEntity || '—')}</dd></div>
        <div><dt>Referência</dt><dd>${esc(payment.atmReference)}</dd><button class="link-btn" type="button" data-copy="${esc(String(payment.atmReference).replace(/\s/g, ''))}">${icon('file', 13)} Copiar</button></div>
        <div><dt>Valor</dt><dd>${formatKz(booking.amountAoa)}</dd></div></dl></div>`;
  }
  if (booking.status === 'pending_payment') {
    return `<div class="sheet-box warn"><p><b>Por pagar.</b> Se já pagaste, a confirmação pode demorar alguns minutos.</p><a class="primary" href="${payHref(booking)}">Concluir pagamento</a></div>`;
  }
  if (booking.status === 'payment_failed') {
    return `<div class="sheet-box error"><p><b>O pagamento não foi concluído.</b> ${esc(payment.message || '')} Nenhum valor foi cobrado.</p>${payment.canRetry ? `<a class="primary" href="${payHref(booking)}">Tentar novamente</a>` : ''}</div>`;
  }
  if (booking.status === 'cancelled') return '<div class="sheet-box muted"><p><b>Reserva cancelada.</b> Se tiveres dúvidas sobre reembolsos, fala com a equipa DOT.</p></div>';
  if (booking.status === 'refunded') return '<div class="sheet-box muted"><p><b>Reserva reembolsada.</b></p></div>';
  return '<div class="sheet-box muted"><p><b>Reserva expirada.</b> O prazo para pagar terminou. Faz uma nova pesquisa para ver os preços actuais.</p></div>';
}

function invoiceHtml(booking) {
  const invoice = booking.invoice;
  if (invoice?.pdfUrl) return `<a class="link-btn" href="${esc(invoice.pdfUrl)}" target="_blank" rel="noopener">${icon('download', 14)} ${esc(invoice.number || 'Descarregar')}</a>`;
  if (invoice) return esc(invoice.number || 'Em emissão');
  return ['paid', 'ticketed'].includes(booking.status) ? 'Em emissão' : 'Depois do pagamento';
}

function sheetHtml(booking) {
  const status = statusOf(booking);
  const names = (booking.passengers || []).map(p => `<li>${esc(p.givenNames)} ${esc(p.surname)}</li>`).join('');
  return `<div class="sheet-head"><button class="sheet-close" type="button" aria-label="Fechar">${icon('x', 18)}</button>
      <span class="trip-status ${status.tone}">${esc(status.label)}</span><h2 id="sheet-title">${routeHtml(booking)}</h2><p>${esc(tripLine(booking))}</p></div>
    <div class="sheet-body">${statusBox(booking)}
      <section class="sheet-sec"><h3>Voos</h3>${legHtml(booking.itinerary?.outbound, 'Ida')}${legHtml(booking.itinerary?.inbound, 'Volta')}<p class="sheet-note">Horários locais de cada aeroporto.</p></section>
      ${names ? `<section class="sheet-sec"><h3>Passageiros</h3><ul class="sheet-list">${names}</ul></section>` : ''}
      <section class="sheet-sec"><h3>Pagamento</h3><dl class="sheet-dl"><div><dt>Total</dt><dd>${formatKz(booking.amountAoa)}</dd></div><div><dt>Factura</dt><dd>${invoiceHtml(booking)}</dd></div></dl></section>
      <p class="sheet-meta">Reserva ${esc(booking.reference)} · comprada a ${esc(formatDate(booking.createdAt))}<br>Precisas de ajuda? <a href="${WHATSAPP}" target="_blank" rel="noopener">Fala com a DOT</a></p></div>`;
}

function openSheet(reference) {
  const booking = bookings.find(item => item.reference === reference);
  if (!booking) return;
  openRef = reference;
  sheet.innerHTML = sheetHtml(booking);
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  history.replaceState(null, '', `/minhas-viagens?ref=${encodeURIComponent(reference)}`);
  sheet.querySelector('.sheet-close').onclick = () => sheet.close();
  sheet.querySelectorAll('[data-copy]').forEach(button => {
    button.onclick = async () => {
      await navigator.clipboard?.writeText(button.dataset.copy).catch(() => {});
      button.innerHTML = `${icon('check', 13)} Copiado`;
    };
  });
}

sheet.addEventListener('close', () => {
  openRef = null;
  history.replaceState(null, '', '/minhas-viagens');
});
// A click on the dimmed area (outside the panel) closes it; keyboard "clicks" inside never do.
sheet.addEventListener('click', event => {
  if (event.target !== sheet) return;
  const box = sheet.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) sheet.close();
});

// ── Load and sign in ──────────────────────────────────────────────────────────
async function load() {
  root.innerHTML = '<div class="trips-loading"><span class="spinner" aria-label="A carregar"></span></div>';
  try {
    ({ bookings } = await api('/api/bookings'));
    const wanted = bookings.find(booking => booking.reference === openRef);
    if (wanted) tab = isUpcoming(wanted) ? 'upcoming' : 'past';
    render();
    if (wanted) openSheet(wanted.reference);
  } catch (error) {
    if (error.code === 'AUTH_REQUIRED') return login();
    root.innerHTML = `<div class="trips-empty"><span class="trips-empty-icon">${icon('alert', 26)}</span><h2>Não foi possível carregar as viagens</h2><p>${esc(error.message)}</p><button class="primary" id="again" type="button">Tentar novamente</button></div>`;
    $('#again').onclick = load;
  }
}

function login() {
  root.innerHTML = `<section class="trips-login"><span class="trips-login-icon">${icon('ticket', 24)}</span><h1>Minhas viagens</h1>
    <p>Entra com o número de telemóvel que usaste na compra.</p><div id="otp"></div>
    <p class="trips-help">Precisas de ajuda? <a href="${WHATSAPP}" target="_blank" rel="noopener">Fala com a DOT</a></p></section>`;
  mountOtp($('#otp'), {
    purpose: 'login',
    onSuccess: value => {
      customer = value;
      load();
    },
  });
}

// City names arrive with the airport catalogue (in the background); codes are shown until then.
loadAirports().then(list => {
  cities = Object.fromEntries(list.map(a => [a.code, a.city]));
  cities.CMN = 'Casablanca';
  if (customer && bookings.length) render();
  if (sheet.open && openRef) {
    // Same panel with the city names; keep the reader where they were.
    const top = sheet.scrollTop;
    openSheet(openRef);
    sheet.scrollTop = top;
  }
}).catch(() => {});

customer = await auth.me();
if (customer) load();
else login();
