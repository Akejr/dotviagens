import { api, auth, esc, formatKz, formatDate, formatPhone, duration, stickyHeader } from './api.js';
import { icon } from './icons.js';
import { mountOtp } from './otp-widget.js';
import { countryName } from './countries.js';
import { loadAirports } from './airports.js';

const $ = selector => document.querySelector(selector);
const root = $('#trips');
const lead = $('#trips-lead');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const CLOSED = ['cancelled', 'refunded', 'expired'];
let cities = {};
let bookings = [];
let customer = null;
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
const shortDay = iso => {
  if (!iso) return '';
  const [, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dayShift = (from, to) => Math.round((Date.parse(dayOf(to)) - Date.parse(dayOf(from))) / 86400000);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' }).format(new Date());
const isUpcoming = booking => !CLOSED.includes(booking.status) && (booking.returnDate || booking.departureDate) >= today;
const logo = (url, name) => (url
  ? `<img class="airline-logo" src="${esc(url)}" alt="${esc(name)}" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="logo-fallback">${esc((name || 'AV').slice(0, 2).toUpperCase())}</span>`);

function legBlock(leg, label, date) {
  if (!leg?.segments?.length) return '';
  const rows = leg.segments.map((segment, index) => {
    const layover = leg.layovers?.[index];
    const shift = dayShift(segment.departure, segment.arrival);
    return `<div class="seg">${logo(segment.logo, segment.airline)}
      <div><strong>${esc(city(segment.from))} (${esc(segment.from)}) → ${esc(city(segment.to))} (${esc(segment.to)})</strong><small>${esc(segment.airline)} · ${esc(segment.number)} · ${duration(segment.duration)}</small></div>
      <div class="seg-time">${esc(clock(segment.departure))} → ${esc(clock(segment.arrival))}${shift > 0 ? `<sup>+${shift}</sup>` : ''}<small>${esc(shortDay(dayOf(segment.departure)))}</small></div></div>
      ${layover ? `<div class="layover-note">${icon('clock', 14)} Conexão de ${duration(layover.duration)} em ${esc(city(layover.airport))}${layover.overnight ? ' · durante a noite' : ''}</div>` : ''}`;
  }).join('');
  return `<div class="detail-block"><h4>${icon('plane', 16)} ${label} · ${esc(shortDay(date))} · ${leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'Directo'} · ${duration(leg.duration)}</h4><div class="seg-list">${rows}</div></div>`;
}

function paymentBlock(booking) {
  const payment = booking.payment || {};
  if (booking.status === 'pending_payment') {
    return `<div class="notice">${icon('clock', 18)}<div><b>À espera do pagamento.</b> ${payment.atmReference ? `Paga com entidade <b>${esc(payment.atmEntity || '—')}</b> e referência <b>${esc(payment.atmReference)}</b>, no valor de ${formatKz(booking.amountAoa)}.` : 'Se já pagaste, a confirmação pode demorar alguns minutos.'}</div></div>`;
  }
  if (booking.status === 'payment_failed') {
    return `<div class="notice error">${icon('x', 18)}<div><b>O pagamento não foi concluído.</b> ${esc(payment.message || '')}</div></div>`;
  }
  if (booking.status === 'paid') {
    return `<div class="notice success">${icon('checkCircle', 18)}<div><b>Pagamento confirmado.</b> A equipa DOT está a emitir o teu bilhete. Avisamos-te por SMS assim que estiver pronto.</div></div>`;
  }
  if (booking.status === 'ticketed') {
    return `<div class="notice success">${icon('ticket', 18)}<div><b>Bilhete emitido.</b> Apresenta o código da reserva e o teu passaporte no check-in da companhia aérea.</div></div>`;
  }
  if (booking.status === 'cancelled') return `<div class="notice">${icon('info', 18)}<div><b>Reserva cancelada.</b> Se tiveres dúvidas sobre reembolsos, fala com a equipa DOT.</div></div>`;
  if (booking.status === 'refunded') return `<div class="notice info">${icon('info', 18)}<div><b>Reserva reembolsada.</b></div></div>`;
  return `<div class="notice">${icon('info', 18)}<div><b>${esc(booking.statusLabel)}.</b> Faz uma nova pesquisa para ver os preços actuais.</div></div>`;
}

function detailHtml(booking) {
  const ticket = booking.ticket;
  const invoice = booking.invoice;
  return `${paymentBlock(booking)}
    ${ticket ? `<div class="detail-block"><h4>${icon('ticket', 16)} Bilhete</h4><div class="detail-rows"><div><small>Código da reserva (PNR)</small><strong>${esc(ticket.pnr || '—')}</strong></div><div><small>Número(s) do bilhete</small><strong>${esc(ticket.numbers || '—')}</strong></div>${ticket.notes ? `<div><small>Notas da DOT</small><strong>${esc(ticket.notes)}</strong></div>` : ''}</div></div>` : ''}
    ${legBlock(booking.itinerary?.outbound, 'Ida', booking.departureDate)}
    ${legBlock(booking.itinerary?.inbound, 'Volta', booking.returnDate)}
    <div class="detail-block"><h4>${icon('users', 16)} Passageiros</h4><div class="detail-rows">${booking.passengers.map(p => `<div><small>${p.title === 'MR' ? 'Sr.' : 'Sra.'} · ${esc(countryName(p.nationality))}</small><strong>${esc(p.givenNames)} ${esc(p.surname)}</strong><small>Passaporte ${esc(p.documentNumber)}</small></div>`).join('')}</div></div>
    <div class="detail-block"><h4>${icon('receipt', 16)} Factura</h4>${invoice
      ? `<div class="detail-rows"><div><small>Número</small><strong>${esc(invoice.number || 'Em emissão')}</strong></div><div><small>Estado na AGT</small><strong>${esc({ validated: 'Validada', pending: 'Em validação', rejected: 'Em revisão pela DOT' }[invoice.agtStatus] || 'Emitida')}</strong></div>${invoice.pdfUrl ? `<div><small>Documento</small><strong><a class="link-btn" href="${esc(invoice.pdfUrl)}" target="_blank" rel="noopener">${icon('download', 14)} Descarregar PDF</a></strong></div>` : ''}</div>`
      : `<p class="muted">${['paid', 'ticketed'].includes(booking.status) ? 'A factura é emitida automaticamente depois do pagamento e aparece aqui.' : 'A factura é emitida depois do pagamento.'}</p>`}</div>`;
}

function stubCode(booking) {
  if (booking.ticket?.pnr) return `<strong class="pnr">${esc(booking.ticket.pnr)}</strong>`;
  const text = { paid: 'Em emissão', pending_payment: 'Depois do pagamento', payment_failed: 'Pagamento por concluir' }[booking.status] || '—';
  return `<strong class="pnr pending">${text}</strong>`;
}

function stubAction(booking) {
  const payment = booking.payment || {};
  const href = `/compra.html?ref=${encodeURIComponent(booking.reference)}`;
  if (booking.status === 'pending_payment') return `<a class="primary pass-pay" href="${href}">${icon('wallet', 15)} ${payment.hostedUrl || payment.canRetry ? 'Concluir pagamento' : 'Ver pagamento'}</a>`;
  if (booking.status === 'payment_failed' && payment.canRetry) return `<a class="primary pass-pay" href="${href}">${icon('refresh', 15)} Tentar novamente</a>`;
  return '';
}

// Boarding-pass card: route and dates on the main part, booking code and total on the stub.
function passCard(booking) {
  const outbound = booking.itinerary?.outbound;
  const first = outbound?.segments?.[0];
  const last = outbound?.segments?.at(-1);
  const open = booking.reference === openRef;
  const shift = first && last ? dayShift(first.departure, last.arrival) : 0;
  const id = `detail-${booking.reference}`;
  return `<article class="pass ${esc(booking.status)}${CLOSED.includes(booking.status) ? ' closed' : ''}" data-ref="${esc(booking.reference)}">
    <div class="pass-main">
      <div class="pass-top"><span class="pass-kind">${icon('ticket', 15)} ${booking.tripType === 'return' ? 'Ida e volta' : 'Só ida'} · ${plural(booking.passengersCount, 'adulto', 'adultos')}</span><span class="badge ${esc(booking.status)}">${esc(booking.statusLabel)}</span></div>
      <div class="pass-route">
        <div class="pass-city"><strong>${esc(booking.origin)}</strong><span>${esc(city(booking.origin))}</span><small>${esc(shortDay(booking.departureDate))}${first ? ` · ${esc(clock(first.departure))}` : ''}</small></div>
        <div class="pass-path" aria-hidden="true"><span class="pass-line"></span><span class="pass-plane">${icon('plane', 18)}</span><small>${outbound ? `${outbound.stops ? plural(outbound.stops, 'escala', 'escalas') : 'Directo'} · ${duration(outbound.duration)}` : ''}</small></div>
        <div class="pass-city to"><strong>${esc(booking.destination)}</strong><span>${esc(city(booking.destination))}</span><small>${last ? `${esc(shortDay(dayOf(last.arrival)))} · ${esc(clock(last.arrival))}${shift > 0 ? ` (+${shift})` : ''}` : ''}</small></div>
      </div>
      <div class="pass-meta">
        <div><small>${booking.returnDate ? 'Volta' : 'Companhia'}</small><strong>${booking.returnDate ? esc(shortDay(booking.returnDate)) : esc(outbound?.airline || '—')}</strong></div>
        <div><small>${booking.returnDate ? 'Companhia' : 'Passageiros'}</small><strong>${booking.returnDate ? esc(outbound?.airline || '—') : plural(booking.passengersCount, 'adulto', 'adultos')}</strong></div>
        <div><small>Reserva DOT</small><strong>${esc(booking.reference)}</strong></div>
      </div>
    </div>
    <div class="pass-stub">
      <div><small>Código da reserva</small>${stubCode(booking)}</div>
      <div><small>Total pago ou a pagar</small><strong class="pass-amount">${formatKz(booking.amountAoa)}</strong><span class="pass-date">Comprado a ${esc(formatDate(booking.createdAt))}</span></div>
      <div class="pass-buttons">${stubAction(booking)}<button class="pass-toggle" type="button" aria-expanded="${open}" aria-controls="${esc(id)}"><span>${open ? 'Ocultar detalhes' : 'Ver detalhes'}</span>${icon('chevron', 14)}</button></div>
    </div>
    <div class="pass-detail" id="${esc(id)}" ${open ? '' : 'hidden'}>${detailHtml(booking)}</div>
  </article>`;
}

function group(title, list, emptyText) {
  return `<section class="trips-group"><div class="group-head"><h2>${title}</h2><span>${list.length}</span></div>
    ${list.length ? `<div class="pass-list">${list.map(passCard).join('')}</div>` : `<div class="group-empty">${icon('plane', 18)}<span>${emptyText}</span><a class="link-btn" href="/#pesquisa">Pesquisar voos ${icon('arrowRight', 14)}</a></div>`}</section>`;
}

function render() {
  const firstName = String(customer.name || '').trim().split(/\s+/)[0];
  const initials = (customer.name || 'DOT').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  const upcoming = bookings.filter(isUpcoming);
  const past = bookings.filter(booking => !isUpcoming(booking));
  lead.textContent = `${firstName ? `Olá, ${firstName}. ` : ''}Aqui tens as tuas passagens, o estado dos pagamentos, os bilhetes e as facturas.`;
  root.innerHTML = `<div class="trips-account"><div class="trips-user"><span class="avatar" aria-hidden="true">${esc(initials)}</span><div><strong>${esc(customer.name || 'Olá!')}</strong><span>${esc(formatPhone(customer.phone))}</span></div></div>
      <div class="trips-actions"><a class="primary" href="/#pesquisa">${icon('search', 15)} Nova viagem</a><button class="secondary" id="logout" type="button">${icon('logout', 14)} Terminar sessão</button></div></div>
    ${bookings.length
      ? `${group('Próximas viagens', upcoming, 'Sem viagens marcadas. Vamos planear a próxima?')}${past.length ? group('Anteriores e canceladas', past, '') : ''}`
      : `<div class="trips-empty"><div><span class="eyebrow">AINDA SEM PASSAGENS</span><h3>O teu próximo destino começa com uma pesquisa.</h3><p>Quando comprares uma passagem com este número, ela aparece aqui com o estado do pagamento, a factura e o bilhete.</p><a class="primary" href="/#pesquisa">${icon('search', 16)} Pesquisar voos</a></div><picture class="art-picture"><source media="(max-width: 760px)" srcset="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><source type="image/webp" srcset="/assets/boarding-tickets-900.webp"><img src="/assets/boarding-tickets-900.png" width="900" height="460" alt="" decoding="async"></picture></div>`}`;
  $('#logout').onclick = async () => {
    await auth.logout().catch(() => {});
    customer = null;
    bookings = [];
    login();
  };
  root.querySelectorAll('.pass-toggle').forEach(button => {
    button.onclick = () => {
      const card = button.closest('.pass');
      const detail = card.querySelector('.pass-detail');
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      button.querySelector('span').textContent = open ? 'Ver detalhes' : 'Ocultar detalhes';
      detail.hidden = open;
      openRef = open ? null : card.dataset.ref;
    };
  });
}

async function load() {
  root.innerHTML = '<div class="panel status-hero"><span class="spinner"></span></div>';
  try {
    ({ bookings } = await api('/api/bookings'));
    if (!openRef) openRef = bookings.find(isUpcoming)?.reference ?? null;
    render();
  } catch (error) {
    if (error.code === 'AUTH_REQUIRED') return login();
    root.innerHTML = `<div class="panel status-hero"><span class="round-icon error">${icon('alert', 30)}</span><h2>Não foi possível carregar as viagens</h2><p>${esc(error.message)}</p><div class="form-actions"><button class="primary" id="again" type="button">Tentar novamente</button></div></div>`;
    $('#again').onclick = load;
  }
}

function login() {
  lead.textContent = 'Entra com o número de telemóvel usado na compra. Enviamos um código por SMS.';
  root.innerHTML = `<div class="trips-login"><div class="panel"><div class="panel-head"><span class="round-icon">${icon('lock', 22)}</span><div><h2>Entra com o teu telemóvel</h2><p>Usa o número indicado na compra. Não precisas de palavra-passe.</p></div></div><div id="otp"></div></div>
    <aside class="trips-perks"><h3>O que encontras aqui</h3>
      <div class="perk"><span class="benefit-icon">${icon('ticket', 22)}</span><p><strong>Bilhetes</strong><small>Código da reserva (PNR) e números do bilhete, assim que a DOT os emite.</small></p></div>
      <div class="perk"><span class="benefit-icon">${icon('wallet', 22)}</span><p><strong>Pagamentos</strong><small>Estado do Multicaixa Express ou da referência, e retomar um pagamento.</small></p></div>
      <div class="perk"><span class="benefit-icon">${icon('receipt', 22)}</span><p><strong>Facturas</strong><small>Factura-recibo certificada pela AGT.</small></p></div>
      <p class="perk-help">Precisas de ajuda? <a href="https://wa.me/244931343433" target="_blank" rel="noopener">Fala com a DOT ↗</a></p></aside></div>`;
  mountOtp($('#otp'), {
    purpose: 'login',
    onSuccess: value => {
      customer = value;
      load();
    },
  });
}

loadAirports().then(list => {
  cities = Object.fromEntries(list.map(a => [a.code, a.city]));
  cities.CMN = 'Casablanca';
  if (customer && bookings.length) render();
}).catch(() => {});

customer = await auth.me();
if (customer) load();
else login();
