import { api, auth, esc, formatKz, formatDate, formatPhone, duration, stickyHeader } from './api.js';
import { icon } from './icons.js';
import { mountOtp } from './otp-widget.js';
import { countryOptions } from './countries.js';
import { loadAirports } from './airports.js';
import { airlineMark, airlineNames, legTimeline } from './itinerary-ui.js';

const $ = selector => document.querySelector(selector);
const STORE_KEY = 'dot-checkout-v1';
const POLL_MS = 3000;
const POLL_LIMIT_MS = 6 * 60 * 1000;
const STEPS = [['review', 'Revisão'], ['contact', 'Contacto'], ['passengers', 'Passageiros'], ['payment', 'Pagamento']];
const params = new URLSearchParams(location.search);
const main = $('#checkout-main');
const aside = $('#checkout-aside');
const state = { step: 'review', itinerary: null, quote: null, customer: null, contact: { name: '', email: '' }, passengers: [], invoice: { wanted: false, nif: '', name: '' }, accept: false };
let cities = {};
let airportNames = {};
let poll = null;
let currentRef = null;
let lastBooking = null;
let statusBooking = null;

document.querySelectorAll('[data-icon]').forEach(element => { element.outerHTML = icon(element.dataset.icon, 15); });
stickyHeader();
document.addEventListener('error', event => {
  if (event.target.matches?.('.airline-logo')) {
    const fallback = document.createElement('span');
    fallback.className = 'logo-fallback';
    fallback.textContent = (event.target.alt || 'AV').slice(0, 2).toUpperCase();
    event.target.replaceWith(fallback);
  }
}, true);

const city = code => cities[code] || code;
const clock = value => esc(String(value || '').slice(11, 16));
const dayOf = value => String(value || '').slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clockOf = iso => new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const dayShift = (from, to) => Math.round((Date.parse(dayOf(to)) - Date.parse(dayOf(from))) / 86400000);
const weekday = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortWeekday = new Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = iso => {
  const text = weekday.format(new Date(`${dayOf(iso)}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const airportName = code => airportNames[code] || '';
const backIcon = `<span class="back-icon" aria-hidden="true">${icon('arrowLeft', 15)}</span>`;
const backButton = (label = 'Voltar') => `<button class="back-link step-back" type="button" data-back>${backIcon}<span class="back-text">${esc(label)}</span></button>`;

// Boarding-pass summary of one leg: airport codes, times, stops and the airline logos.
function legSummary(leg, label) {
  const first = leg.segments[0];
  const last = leg.segments.at(-1);
  const shift = dayShift(first.departure, last.arrival);
  return `<div class="trip-leg"><div class="trip-leg-top"><small>${label} · ${esc(shortWeekday.format(new Date(`${dayOf(first.departure)}T12:00:00Z`)))}</small>${airlineMark(leg)}</div>
    <div class="trip-route"><div><b>${esc(first.from)}</b><span>${clock(first.departure)}</span></div>
      <div class="trip-line" aria-hidden="true"><i></i><em>${leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'Directo'} · ${duration(leg.duration)}</em></div>
      <div class="to"><b>${esc(last.to)}</b><span>${clock(last.arrival)}${shift > 0 ? `<sup>+${shift}</sup>` : ''}</span></div></div>
    <span class="trip-airlines">${esc(city(first.from))} → ${esc(city(last.to))} · ${esc(airlineNames(leg))}</span></div>`;
}

function tripCard({ passengers, outbound, inbound, amountAoa, totalLabel, note = '' }) {
  return `<div class="trip-card"><div class="trip-card-head"><span class="eyebrow">A TUA VIAGEM</span><span>${inbound ? 'Ida e volta' : 'Só ida'} · ${plural(passengers, 'adulto', 'adultos')}</span></div>
    ${legSummary(outbound, 'IDA')}${inbound ? legSummary(inbound, 'VOLTA') : ''}
    <div class="trip-total"><span>${esc(totalLabel)}</span><strong>${formatKz(amountAoa)}</strong>${note ? `<p>${note}</p>` : ''}</div>
    <ul class="trip-trust"><li>${icon('lock', 14)} Pagamento seguro na página da Wiza</li><li>${icon('message', 14)} Confirmação e bilhete por SMS</li><li>${icon('receipt', 14)} Factura certificada pela AGT</li></ul></div>`;
}

function segmentsHtml(leg) {
  return legTimeline(leg, { city, airport: airportName, cabin: leg.cabin || 'Económica' });
}

function legCard(leg, label, date) {
  const first = leg.segments[0];
  const last = leg.segments.at(-1);
  return `<article class="leg-card"><div class="leg-card-head"><div><span class="leg-tag">${label}</span><h3>${esc(longDay(date || first.departure))}</h3>
    <p>${esc(city(first.from))} → ${esc(city(last.to))} · ${duration(leg.duration)} · ${leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'Directo'}</p></div>${airlineMark(leg)}</div>${segmentsHtml(leg)}</article>`;
}

function backUrl() {
  const q = state.itinerary?.outbound?.query || state.quote?.query;
  if (!q) return '/#pesquisa';
  const search = new URLSearchParams({ origin: q.origin, destination: q.destination, departureDate: q.departureDate, passengers: String(q.passengers), cabin: 'economy' });
  if (q.returnDate) search.set('returnDate', q.returnDate);
  return `/resultados.html?${search}`;
}

function renderHeading(info) {
  if (!info) return;
  $('#checkout-title').innerHTML = `${esc(city(info.origin))} <span>→</span> ${esc(city(info.destination))}`;
  $('#checkout-meta').textContent = `${formatDate(info.departureDate)}${info.returnDate ? ` — ${formatDate(info.returnDate)}` : ''} · ${info.returnDate ? 'Ida e volta' : 'Só ida'} · ${plural(info.passengers, 'adulto', 'adultos')} · Económica`;
  $('#back-link').href = backUrl();
}

function renderSteps(hidden = false) {
  const steps = $('#checkout-steps');
  steps.hidden = hidden;
  const index = STEPS.findIndex(([key]) => key === state.step);
  steps.innerHTML = STEPS.map(([, label], i) =>
    `<li class="${i === index ? 'current' : i < index ? 'done' : ''}" ${i === index ? 'aria-current="step"' : ''}><b>${i < index ? icon('check', 14) : i + 1}</b><span>${label}</span></li>`).join('');
}

function renderAside() {
  const q = state.quote;
  if (!q) {
    aside.innerHTML = '';
    return;
  }
  aside.innerHTML = tripCard({
    passengers: q.query.passengers,
    outbound: q.outbound,
    inbound: q.inbound,
    amountAoa: q.amountAoa,
    totalLabel: `Total para ${plural(q.query.passengers, 'adulto', 'adultos')}`,
    note: `Preço final, com taxas incluídas.${q.expiresAt ? ` Garantido até às ${esc(clockOf(q.expiresAt))}.` : ''}`,
  });
}

function go(step, scroll = true) {
  state.step = step;
  renderSteps();
  ({ review: renderReview, contact: renderContact, passengers: renderPassengers, payment: renderPayment })[step]();
  if (scroll) $('#checkout-steps').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function errorBox(message) {
  const box = main.querySelector('.form-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
  if (message) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fatal(title, message, actions = '') {
  renderSteps(true);
  main.innerHTML = `<div class="panel status-hero"><span class="round-icon error">${icon('alert', 30)}</span><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="form-actions">${actions || `<a class="primary" href="${backUrl()}">Voltar aos resultados</a>`}</div></div>`;
}

// ── Step 1: review ────────────────────────────────────────────────────────────
function renderReview() {
  const q = state.quote;
  main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('plane', 22)}</span><div><h2>Revê a tua viagem</h2><p>Confirma os voos, as datas e os horários antes de continuar. Os horários são locais de cada aeroporto.</p></div></div>
    ${legCard(q.outbound, 'IDA', q.query.departureDate)}
    ${q.inbound ? legCard(q.inbound, 'VOLTA', q.query.returnDate) : ''}
    <div class="notice info">${icon('info', 18)}<div>O preço em kwanzas é final, com taxas incluídas, e fica garantido durante 15 minutos.</div></div>
    ${q.payments ? '' : `<div class="notice error">${icon('alert', 18)}<div>Os pagamentos estão temporariamente indisponíveis. Podes rever a viagem e tentar novamente dentro de momentos.</div></div>`}
    <div class="form-actions"><a class="back-link step-back" href="${backUrl()}">${backIcon}<span class="back-text">Escolher outro voo</span></a><button class="primary" id="next" type="button">Continuar ${icon('arrowRight', 16)}</button></div></div>`;
  $('#next').onclick = () => go('contact');
}

// ── Step 2: contact + OTP ─────────────────────────────────────────────────────
function renderContact() {
  if (!state.customer) {
    main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('phone', 22)}</span><div><h2>Contacto e verificação</h2><p>Confirmamos o teu número por SMS. É com ele que entras em Minhas viagens para ver os bilhetes.</p></div></div><div id="otp"></div>
      <div class="form-actions">${backButton()}</div></div>`;
    main.querySelector('[data-back]').onclick = () => go('review');
    mountOtp($('#otp'), {
      purpose: 'checkout',
      askContact: true,
      initial: state.contact,
      onSuccess: (customer, contact) => {
        state.customer = customer;
        state.contact = contact;
        go('passengers');
      },
    });
    return;
  }
  const name = state.contact.name || state.customer.name || '';
  const email = state.contact.email || state.customer.email || '';
  main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('user', 22)}</span><div><h2>Dados de contacto</h2><p>Usamos estes dados para te enviar a confirmação e o bilhete.</p></div></div>
    <div class="account-bar"><div><span class="round-icon">${icon('shield', 20)}</span><div><strong>${esc(formatPhone(state.customer.phone))}</strong>Número confirmado por SMS</div></div><button class="link-btn" id="switch" type="button">Usar outro número</button></div>
    <div class="form-grid"><label class="form-field"><span>Nome completo</span><input name="name" autocomplete="name" maxlength="80" value="${esc(name)}"></label>
    <label class="form-field"><span>E-mail</span><input name="email" type="email" autocomplete="email" maxlength="160" value="${esc(email)}"></label></div>
    <p class="form-error" role="alert" hidden></p>
    <div class="form-actions">${backButton()}<button class="primary" id="next" type="button">Continuar ${icon('arrowRight', 16)}</button></div></div>`;
  main.querySelector('[data-back]').onclick = () => go('review');
  $('#switch').onclick = async () => {
    await auth.logout().catch(() => {});
    state.customer = null;
    renderContact();
  };
  $('#next').onclick = () => {
    const nameValue = main.querySelector('[name=name]').value.trim();
    const emailValue = main.querySelector('[name=email]').value.trim();
    if (nameValue.length < 3) return errorBox('Indica o teu nome completo.');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(emailValue)) return errorBox('Indica um e-mail válido.');
    state.contact = { name: nameValue, email: emailValue };
    go('passengers');
  };
}

// ── Step 3: passengers (airline style) ───────────────────────────────────────
const emptyPassenger = () => ({ title: '', givenNames: '', surname: '', birthDate: '', nationality: 'AO', documentNumber: '', documentCountry: 'AO', documentExpiry: '' });
const plusMonths = (iso, months) => {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};
const addYears = (iso, years) => plusMonths(iso, years * 12);
const NAME = /^[\p{L}][\p{L}'’ -]*$/u;

function passengerError(p) {
  const q = state.quote;
  const today = new Date().toISOString().slice(0, 10);
  if (!p.title) return ['title', 'escolhe o tratamento.'];
  if (p.givenNames.trim().length < 2 || !NAME.test(p.givenNames.trim())) return ['givenNames', 'indica o(s) nome(s) próprio(s) como no passaporte.'];
  if (p.surname.trim().length < 2 || !NAME.test(p.surname.trim())) return ['surname', 'indica o(s) apelido(s) como no passaporte.'];
  if (!p.birthDate || p.birthDate >= today) return ['birthDate', 'confirma a data de nascimento.'];
  if (p.birthDate > addYears(q.query.departureDate, -12)) return ['birthDate', 'nesta versão só vendemos para adultos (12 anos ou mais na data da viagem).'];
  if (!/^[A-Z0-9]{5,20}$/.test(p.documentNumber.toUpperCase().replace(/[\s-]/g, ''))) return ['documentNumber', 'confirma o número do passaporte.'];
  if (!p.documentExpiry || p.documentExpiry <= q.lastTravelDate) return ['documentExpiry', 'o passaporte tem de estar válido para além da data da viagem.'];
  return null;
}

function renderPassengers() {
  const q = state.quote;
  while (state.passengers.length < q.query.passengers) state.passengers.push(emptyPassenger());
  state.passengers.length = q.query.passengers;
  const maxBirth = addYears(q.query.departureDate, -12);
  main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('idCard', 22)}</span><div><h2>Dados dos passageiros</h2><p>Escreve os nomes exactamente como aparecem no passaporte. A companhia aérea pode recusar o embarque se não coincidirem.</p></div></div>
    ${state.passengers.map((p, i) => `<article class="passenger-card" data-index="${i}"><div class="passenger-head"><span class="passenger-num">${i + 1}</span><div><h3>Passageiro ${i + 1}</h3><small>Adulto · 12 anos ou mais na data da viagem</small></div></div>
      <div class="form-grid">
        <label class="form-field"><span>Tratamento</span><select name="title"><option value="">Escolhe</option><option value="MR" ${p.title === 'MR' ? 'selected' : ''}>Sr.</option><option value="MS" ${p.title === 'MS' ? 'selected' : ''}>Sra.</option></select></label>
        <label class="form-field"><span>Data de nascimento</span><input type="date" name="birthDate" min="1900-01-01" max="${maxBirth}" value="${esc(p.birthDate)}"></label>
        <label class="form-field"><span>Nome(s) próprio(s) <small>como no passaporte</small></span><input name="givenNames" autocomplete="${i ? 'off' : 'given-name'}" maxlength="60" value="${esc(p.givenNames)}"></label>
        <label class="form-field"><span>Apelido(s) <small>como no passaporte</small></span><input name="surname" autocomplete="${i ? 'off' : 'family-name'}" maxlength="60" value="${esc(p.surname)}"></label>
        <label class="form-field"><span>Nacionalidade</span><select name="nationality">${countryOptions(p.nationality)}</select></label>
        <label class="form-field"><span>Número do passaporte</span><input name="documentNumber" maxlength="20" autocapitalize="characters" spellcheck="false" value="${esc(p.documentNumber)}"></label>
        <label class="form-field"><span>País emissor do passaporte</span><select name="documentCountry">${countryOptions(p.documentCountry)}</select></label>
        <label class="form-field"><span>Validade do passaporte</span><input type="date" name="documentExpiry" min="${esc(q.lastTravelDate)}" value="${esc(p.documentExpiry)}"></label>
      </div><p class="form-hint" data-expiry-warning hidden>${icon('alert', 14)} Muitos países exigem passaporte válido 6 meses depois da viagem. Confirma as regras do destino.</p></article>`).join('')}
    <p class="form-error" role="alert" hidden></p>
    <div class="form-actions">${backButton()}<button class="primary" id="next" type="button">Continuar para pagamento ${icon('arrowRight', 16)}</button></div></div>`;

  const sixMonths = plusMonths(q.lastTravelDate, 6);
  main.querySelectorAll('.passenger-card').forEach(card => {
    const index = Number(card.dataset.index);
    card.dataset.nationality = state.passengers[index].nationality;
    const update = () => {
      const p = state.passengers[index];
      card.querySelectorAll('[name]').forEach(field => { p[field.name] = field.value; });
      const warning = card.querySelector('[data-expiry-warning]');
      warning.hidden = !(p.documentExpiry && p.documentExpiry > q.lastTravelDate && p.documentExpiry < sixMonths);
    };
    // The issuing country follows the nationality until the user picks another one.
    card.querySelector('[name=nationality]').addEventListener('change', event => {
      const issuer = card.querySelector('[name=documentCountry]');
      if (issuer.value === card.dataset.nationality) issuer.value = event.target.value;
      card.dataset.nationality = event.target.value;
      update();
    });
    card.addEventListener('input', update);
    card.addEventListener('change', event => {
      if (event.target.name === 'documentNumber') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      update();
      event.target.removeAttribute('aria-invalid');
    });
    update();
  });
  main.querySelector('[data-back]').onclick = () => go('contact');
  $('#next').onclick = () => {
    const seen = new Set();
    for (const [index, p] of state.passengers.entries()) {
      let problem = passengerError(p);
      const number = p.documentNumber.toUpperCase().replace(/[\s-]/g, '');
      if (!problem && seen.has(number)) problem = ['documentNumber', 'este passaporte já foi usado noutro passageiro.'];
      seen.add(number);
      if (problem) {
        const field = main.querySelector(`.passenger-card[data-index="${index}"] [name=${problem[0]}]`);
        field?.setAttribute('aria-invalid', 'true');
        field?.focus();
        return errorBox(`Passageiro ${index + 1}: ${problem[1]}`);
      }
    }
    go('payment');
  };
}

// ── Step 4: payment ───────────────────────────────────────────────────────────
function renderPayment(notice = '') {
  const q = state.quote;
  main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('wallet', 22)}</span><div><h2>Pagamento em kwanzas</h2><p>Pagas na página segura da Wiza. Escolhes lá o método que preferires.</p></div></div>
    ${notice}
    <div class="pay-methods"><div class="pay-method"><span class="benefit-icon">${icon('phone', 21)}</span><div><strong>Multicaixa Express</strong><small>Autorizas o pagamento no telemóvel, em poucos segundos.</small></div></div>
      <div class="pay-method"><span class="benefit-icon">${icon('receipt', 21)}</span><div><strong>Referência Multicaixa</strong><small>Pagas no ATM ou no internet banking. A confirmação chega por SMS.</small></div></div></div>
    <div class="review-list">
      <div class="review-row"><span>${icon('user', 16)} Contacto</span><div><strong>${esc(state.contact.name)}</strong><small>${esc(formatPhone(state.customer?.phone))} · ${esc(state.contact.email)}</small></div><button class="link-btn" type="button" data-goto="contact">Alterar</button></div>
      <div class="review-row"><span>${icon('users', 16)} Passageiros</span><div>${state.passengers.map(p => `<strong>${p.title === 'MR' ? 'Sr.' : 'Sra.'} ${esc(p.givenNames)} ${esc(p.surname)}</strong>`).join('')}<small>Nomes como no passaporte</small></div><button class="link-btn" type="button" data-goto="passengers">Alterar</button></div></div>
    <div class="choice-list">
      <label class="check-row"><input type="checkbox" id="want-invoice" ${state.invoice.wanted ? 'checked' : ''}><span><b>Quero factura com NIF</b> (empresa ou particular). Sem NIF, a factura sai em nome de Consumidor Final.</span></label>
      <div class="form-grid" id="invoice-fields" ${state.invoice.wanted ? '' : 'hidden'}>
        <label class="form-field"><span>NIF</span><input name="nif" maxlength="14" autocapitalize="characters" value="${esc(state.invoice.nif)}"></label>
        <label class="form-field"><span>Nome ou empresa na factura</span><input name="invoiceName" maxlength="120" value="${esc(state.invoice.name)}"></label></div>
      <label class="check-row"><input type="checkbox" id="accept" ${state.accept ? 'checked' : ''}><span>Confirmo que os nomes e os passaportes estão exactamente como nos documentos de viagem. Sei que a DOT emite o bilhete depois de confirmar o pagamento e que recebo a confirmação por SMS.</span></label></div>
    <p class="form-error" role="alert" hidden></p>
    <div class="form-actions">${backButton()}<button class="primary pay-button" id="pay" type="button" ${q.payments ? '' : 'disabled'}>${icon('lock', 16)} Pagar ${formatKz(q.amountAoa)}</button></div>
    <p class="pay-note">${icon('info', 14)} Vai abrir a página de pagamento da Wiza. Mantém esta página aberta até a confirmação aparecer.</p></div>`;
  main.querySelector('[data-back]').onclick = () => go('passengers');
  main.querySelectorAll('[data-goto]').forEach(button => { button.onclick = () => go(button.dataset.goto); });
  $('#want-invoice').onchange = event => {
    state.invoice.wanted = event.target.checked;
    $('#invoice-fields').hidden = !event.target.checked;
  };
  $('#accept').onchange = event => { state.accept = event.target.checked; };
  main.querySelector('[name=nif]').oninput = event => { state.invoice.nif = event.target.value.toUpperCase(); };
  main.querySelector('[name=invoiceName]').oninput = event => { state.invoice.name = event.target.value; };
  $('#pay').onclick = pay;
}

async function refreshQuote() {
  state.quote = await api('/api/checkout/quote', { method: 'POST', body: { itinerary: state.itinerary } });
  renderAside();
}

async function pay() {
  if (!state.accept) return errorBox('Confirma que os dados dos passageiros estão correctos.');
  if (state.invoice.wanted && (!/^[0-9A-Z]{9,14}$/.test(state.invoice.nif.replace(/[\s.-]/g, '')) || state.invoice.name.trim().length < 2)) {
    return errorBox('Indica o NIF e o nome que devem constar na factura.');
  }
  const button = $('#pay');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> A preparar o pagamento…';
  try {
    const result = await api('/api/bookings', {
      method: 'POST',
      timeout: 60000,
      body: {
        itinerary: state.itinerary,
        quoteToken: state.quote.quoteToken,
        contact: state.contact,
        passengers: state.passengers.map(p => ({ ...p, givenNames: p.givenNames.trim(), surname: p.surname.trim() })),
        invoice: state.invoice.wanted ? { nif: state.invoice.nif, name: state.invoice.name } : null,
        accept: true,
      },
    });
    sessionStorage.removeItem(STORE_KEY);
    currentRef = result.reference;
    history.replaceState(null, '', `/compra.html?ref=${encodeURIComponent(result.reference)}`);
    renderSteps(true);
    if (result.hostedUrl) {
      renderStatus({ reference: result.reference, status: 'pending_payment', amountAoa: result.amountAoa, payment: { hostedUrl: result.hostedUrl, canRetry: false, windowOpen: true } });
      openPayment(result.hostedUrl);
    } else {
      renderStatus({ reference: result.reference, status: 'pending_payment', amountAoa: result.amountAoa, payment: { canRetry: true, message: result.paymentError } });
    }
  } catch (error) {
    button.disabled = false;
    button.innerHTML = `${icon('lock', 16)} Pagar ${formatKz(state.quote.amountAoa)}`;
    if (error.code === 'AUTH_REQUIRED') {
      state.customer = null;
      return go('contact');
    }
    if (error.code === 'QUOTE_EXPIRED' || error.code === 'NO_RATE') {
      try {
        const before = state.quote.amountAoa;
        await refreshQuote();
        return renderPayment(`<div class="notice">${icon('refresh', 18)}<div>${state.quote.amountAoa === before ? 'Actualizámos a cotação.' : `O preço foi actualizado e o total passou a <b>${formatKz(state.quote.amountAoa)}</b>.`} Confirma novamente para pagar.</div></div>`);
      } catch (inner) {
        return errorBox(inner.message);
      }
    }
    if (error.code === 'OFFER_EXPIRED') return fatal('Os preços expiraram', error.message);
    if (error.code === 'PASSENGER_INVALID') {
      go('passengers');
      return errorBox(error.message);
    }
    errorBox(error.message);
  }
}

// ── Payment window + confirmation polling ────────────────────────────────────
function openPayment(url) {
  const dialog = $('#pay-dialog');
  $('#pay-frame').src = url;
  $('#pay-open').href = url;
  $('#pay-title').innerHTML = `${icon('lock', 16)} Pagamento seguro · ${esc(currentRef)}`;
  if (!dialog.open) dialog.showModal();
  startPolling();
}

function closePayment() {
  const dialog = $('#pay-dialog');
  if (dialog.open) dialog.close();
  $('#pay-frame').src = 'about:blank';
}

$('#pay-close').onclick = () => {
  closePayment();
  if (lastBooking) renderStatus(lastBooking);
};

addEventListener('message', event => {
  if (event.origin === location.origin && event.data?.type === 'dot-payment-return' && event.data.ref === currentRef) {
    closePayment();
    checkNow();
  }
});

function stopPolling() {
  clearInterval(poll?.timer);
  poll = null;
}

function startPolling() {
  stopPolling();
  poll = { started: Date.now(), timer: setInterval(checkNow, POLL_MS) };
  checkNow();
}

async function checkNow() {
  if (!currentRef) return;
  try {
    const { booking } = await api(`/api/bookings/${encodeURIComponent(currentRef)}/check`, { method: 'POST', body: {} });
    lastBooking = booking;
    const status = $('#pay-status');
    if (booking.payment?.atmReference) {
      status.innerHTML = `${icon('info', 16)} Referência gerada: entidade <b>${esc(booking.payment.atmEntity || '—')}</b>, referência <b>${esc(booking.payment.atmReference)}</b>.`;
    }
    const final = booking.status !== 'pending_payment';
    const expired = poll && Date.now() - poll.started > POLL_LIMIT_MS;
    if (final || expired) {
      stopPolling();
      closePayment();
    }
    if (final || expired || !$('#pay-dialog').open) renderStatus(booking);
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      stopPolling();
      closePayment();
      fatal('Não foi possível confirmar', error.message, '<a class="primary" href="/minhas-viagens.html">Ir para Minhas viagens</a>');
    }
  }
}

function renderStatus(booking) {
  lastBooking = booking;
  currentRef = booking.reference;
  renderSteps(true);
  const ref = `<span class="ref-chip">${icon('ticket', 16)} ${esc(booking.reference)}</span>`;
  const payment = booking.payment || {};
  if (booking.status === 'paid' || booking.status === 'ticketed') {
    const ticketed = booking.status === 'ticketed';
    main.innerHTML = `<div class="panel status-hero"><span class="round-icon success">${icon('checkCircle', 34)}</span><h2>Pagamento confirmado!</h2>${ref}
      <p>${ticketed ? 'O teu bilhete já foi emitido. Vê o código da reserva em Minhas viagens.' : 'Obrigado! Agora a equipa DOT emite o teu bilhete e avisa-te por SMS.'}</p>
      ${nextSteps(ticketed ? 3 : 1)}
      <div class="form-actions"><a class="primary" href="/minhas-viagens.html">${icon('ticket', 16)} Ver Minhas viagens</a><a class="back-link step-back" href="/#pesquisa">${backIcon}<span class="back-text">Nova pesquisa</span></a></div></div>`;
    return;
  }
  if (booking.status === 'pending_payment') {
    const atm = payment.atmReference
      ? `<div class="atm-card"><div><small>Entidade</small><strong>${esc(payment.atmEntity || '—')}</strong></div>
          <div><small>Referência</small><strong>${esc(payment.atmReference)}</strong><button class="link-btn copy-btn" type="button" data-copy="${esc(String(payment.atmReference).replace(/\s/g, ''))}">${icon('file', 13)} Copiar</button></div>
          <div><small>Valor</small><strong>${formatKz(booking.amountAoa)}</strong></div></div>
        <p class="atm-help">Paga no ATM, no Multicaixa Express ou no internet banking, com a opção de pagamento por referência.</p>`
      : '';
    main.innerHTML = `<div class="panel status-hero"><span class="round-icon">${icon('clock', 32)}</span><h2>À espera da confirmação do pagamento</h2>${ref}
      <p>${payment.message ? esc(payment.message) : 'Assim que a Wiza confirmar, esta página actualiza-se. Se pagaste por referência, a confirmação pode chegar mais tarde: avisamos-te por SMS.'}</p>${atm}
      <div class="form-actions">
        ${payment.hostedUrl ? `<button class="primary" type="button" id="resume">${icon('wallet', 16)} Continuar pagamento</button>` : ''}
        ${payment.canRetry ? `<button class="${payment.hostedUrl ? 'secondary' : 'primary'}" type="button" id="retry">${icon('refresh', 16)} Iniciar novo pagamento</button>` : ''}
        <button class="link-btn" type="button" id="check">${icon('refresh', 14)} Verificar agora</button></div></div>`;
    $('#resume')?.addEventListener('click', () => openPayment(payment.hostedUrl));
    $('#retry')?.addEventListener('click', retry);
    main.querySelectorAll('[data-copy]').forEach(button => {
      button.onclick = async () => {
        await navigator.clipboard?.writeText(button.dataset.copy).catch(() => {});
        button.innerHTML = `${icon('check', 13)} Copiado`;
      };
    });
    $('#check').onclick = () => {
      if (!poll) startPolling();
      else checkNow();
    };
    return;
  }
  if (booking.status === 'payment_failed') {
    main.innerHTML = `<div class="panel status-hero"><span class="round-icon error">${icon('x', 32)}</span><h2>O pagamento não foi concluído</h2>${ref}
      <p>${esc(payment.message || 'A Wiza não confirmou o pagamento.')} Nenhum valor foi cobrado por esta tentativa.</p>
      <div class="form-actions">${payment.canRetry ? `<button class="primary" type="button" id="retry">${icon('refresh', 16)} Tentar novamente</button>` : ''}<a class="link-btn" href="https://wa.me/244931343433" target="_blank" rel="noopener">Falar com a DOT</a></div></div>`;
    $('#retry')?.addEventListener('click', retry);
    return;
  }
  main.innerHTML = `<div class="panel status-hero"><span class="round-icon">${icon('info', 32)}</span><h2>${esc(booking.statusLabel || 'Reserva actualizada')}</h2>${ref}
    <p>${booking.status === 'expired' ? 'O prazo para pagar esta reserva terminou. Faz uma nova pesquisa para ver os preços actuais.' : 'Consulta os detalhes em Minhas viagens ou fala com a equipa DOT.'}</p>
    <div class="form-actions"><a class="primary" href="/#pesquisa">Nova pesquisa</a><a class="link-btn" href="/minhas-viagens.html">Minhas viagens</a></div></div>`;
}

// What happens after paying: payment → ticket issued by the DOT team → SMS and Minhas viagens.
function nextSteps(done) {
  const steps = [
    ['checkCircle', 'Pagamento confirmado', 'Recebes um SMS de confirmação.'],
    ['ticket', 'Emissão do bilhete', 'A equipa DOT emite o bilhete na companhia aérea.'],
    ['message', 'Bilhete no telemóvel', 'Código da reserva por SMS e em Minhas viagens.'],
  ];
  return `<ol class="next-steps">${steps.map(([glyph, title, text], index) => `<li class="${index < done ? 'done' : index === done ? 'current' : ''}"><span>${icon(index < done ? 'check' : glyph, 17)}</span><div><strong>${title}</strong><small>${text}</small></div></li>`).join('')}</ol>`;
}

async function retry() {
  const button = $('#retry');
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> A preparar…';
  }
  try {
    const result = await api(`/api/bookings/${encodeURIComponent(currentRef)}/pay`, { method: 'POST', body: {} });
    openPayment(result.hostedUrl);
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon('refresh', 16)} Tentar novamente`;
    }
    main.querySelector('.status-hero p').textContent = error.message;
  }
}

// Status page frame: route heading, back link to Minhas viagens and the trip card.
// Rendered again when the airport list arrives, so the cities replace the codes.
function renderBookingFrame(booking) {
  renderHeading({ origin: booking.origin, destination: booking.destination, departureDate: booking.departureDate, returnDate: booking.returnDate, passengers: booking.passengersCount });
  $('#back-link').href = '/minhas-viagens.html';
  $('#back-link .back-text').textContent = 'Minhas viagens';
  const legs = booking.itinerary;
  aside.innerHTML = legs?.outbound ? tripCard({ passengers: booking.passengersCount, outbound: legs.outbound, inbound: legs.inbound, amountAoa: booking.amountAoa, totalLabel: 'Total pago ou a pagar' }) : '';
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function statusMode(reference) {
  currentRef = reference;
  // Wiza returns to this URL inside the payment iframe: hand over to the parent page.
  if (window.top !== window.self) {
    try {
      window.parent.postMessage({ type: 'dot-payment-return', ref: reference, failed: params.get('r') === 'falhou' }, location.origin);
    } catch {
      // The parent keeps polling anyway.
    }
    document.body.innerHTML = '<p style="font:14px DM Sans,sans-serif;padding:30px;text-align:center">A concluir o pagamento…</p>';
    return;
  }
  renderSteps(true);
  $('#checkout-title').textContent = 'A tua compra';
  $('#checkout-meta').textContent = `Reserva ${reference}`;
  const customer = await auth.me();
  if (!customer) {
    main.innerHTML = `<div class="panel"><div class="panel-head"><span class="round-icon">${icon('lock', 22)}</span><div><h2>Entra para ver a tua compra</h2><p>Por segurança, confirma o número de telemóvel usado na compra.</p></div></div><div id="otp"></div></div>`;
    mountOtp($('#otp'), { purpose: 'login', onSuccess: () => statusMode(reference) });
    return;
  }
  try {
    const { booking } = await api(`/api/bookings/${encodeURIComponent(reference)}`);
    statusBooking = booking;
    renderBookingFrame(booking);
    renderStatus(booking);
    if (booking.status === 'pending_payment' && booking.payment?.windowOpen) startPolling();
    else if (booking.status === 'pending_payment') checkNow();
  } catch (error) {
    fatal('Reserva não encontrada', error.message, '<a class="primary" href="/minhas-viagens.html">Ir para Minhas viagens</a>');
  }
}

async function checkoutMode() {
  try {
    state.itinerary = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null')?.itinerary || null;
  } catch {
    state.itinerary = null;
  }
  if (!state.itinerary?.outbound) {
    return fatal('Ainda não escolheste uma viagem', 'Pesquisa voos e escolhe a ida e a volta para continuar a compra.', '<a class="primary" href="/#pesquisa">Pesquisar voos</a><a class="link-btn" href="/minhas-viagens.html">Minhas viagens</a>');
  }
  renderSteps();
  try {
    const [, customer] = await Promise.all([refreshQuote(), auth.me()]);
    state.customer = customer;
    if (customer) state.contact = { name: customer.name || '', email: customer.email || '' };
  } catch (error) {
    if (error.code === 'OFFER_EXPIRED') return fatal('Os preços expiraram', error.message);
    if (error.code === 'NO_RATE') return fatal('Compra temporariamente indisponível', error.message);
    return fatal('Não foi possível preparar a compra', error.message);
  }
  renderHeading(state.quote.query);
  go('review', false);
}

loadAirports().then(list => {
  cities = Object.fromEntries(list.map(a => [a.code, a.city]));
  cities.CMN = 'Casablanca';
  airportNames = Object.fromEntries(list.map(a => [a.code, a.name]));
  airportNames.LIS = 'Humberto Delgado';
  airportNames.CMN = 'Mohammed V';
  if (statusBooking) renderBookingFrame(statusBooking);
  else if (state.quote) {
    renderHeading(state.quote.query);
    renderAside();
    if (state.step === 'review') renderReview();
  }
}).catch(() => {});

if (params.get('ref')) statusMode(params.get('ref'));
else checkoutMode();
