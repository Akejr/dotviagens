// DOT Viagens admin panel (/admin). Real time without database keys in the browser:
// every 3 s the panel asks /api/admin/live what changed and reloads only the screen
// whose data changed (deferred while a dialog or a form field is in use).

import { api, auth, esc, formatKz, formatBrl, formatDate, formatDateTime, formatPhone, duration } from './api.js';
import { icon } from './icons.js';
import { mountOtp } from './otp-widget.js';
import { countryName } from './countries.js';
import { loadAirports } from './airports.js';
import { toKz, totalKz, totalBrl } from './flight-model.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const root = $('#admin-root');
const dialog = $('#admin-dialog');
const LIVE_MS = 3000;
const NAV = [
  ['OPERAÇÃO', [['overview', 'Visão geral', 'dashboard'], ['searches', 'Pesquisas', 'activity'], ['bookings', 'Compras', 'ticket'], ['customers', 'Utilizadores', 'users'], ['alerts', 'Avisos', 'bell']]],
  ['CONFIGURAÇÃO', [['rates', 'Câmbio e preço', 'coins'], ['sms', 'SMS', 'message'], ['audit', 'Auditoria', 'list'], ['system', 'Sistema', 'settings']]],
];
// Live topics (keys of admin_live_state) that refresh each screen.
const TOPICS = {
  overview: ['searches', 'bookings', 'payments', 'customers', 'sms', 'rates', 'pricing', 'provider_pause'],
  searches: ['searches', 'rates', 'pricing'],
  bookings: ['bookings', 'payments'],
  booking: ['bookings', 'payments', 'sms', 'audit'],
  customers: ['customers', 'bookings'],
  alerts: ['alerts', 'customers'],
  rates: ['rates', 'pricing'],
  sms: ['sms'],
  audit: ['audit'],
  system: ['pricing', 'provider_pause'],
};
const STATUS = {
  pending_payment: 'A aguardar pagamento',
  paid: 'Pago · por emitir',
  payment_failed: 'Pagamento falhado',
  expired: 'Expirada',
  ticketed: 'Bilhete emitido',
  cancelled: 'Cancelada',
  refunded: 'Reembolsada',
};
const FILTERS = [['', 'Todas'], ['paid', 'Por emitir'], ['pending_payment', 'Pendentes'], ['ticketed', 'Emitidas'], ['no_profit', 'Sem lucro'], ['payment_failed', 'Falhadas'], ['review', 'Para rever'], ['expired', 'Expiradas'], ['cancelled', 'Canceladas'], ['refunded', 'Reembolsadas']];
const KIND = { view: 'Ida · data escolhida', prefetch: 'Ida · data vizinha', return: 'Volta · data escolhida', 'return-prefetch': 'Volta · data vizinha', calendar: 'Calendário de preços' };
const SMS_STATUS = { queued: 'Em fila', sent: 'Enviada', delivered: 'Entregue', undelivered: 'Não entregue', failed: 'Falhou', expired: 'Expirou' };
const SMS_PURPOSE = { otp: 'Código de acesso', payment_confirmed: 'Pagamento confirmado', ticket_issued: 'Bilhete emitido', booking_cancelled: 'Cancelamento', price_drop: 'Aviso de preço' };
const SERVICE = { gpo: 'Multicaixa Express', reference: 'Referência' };
// Payment column: the Wiza method, "Manual · WhatsApp" when the customer chose to pay with the DOT team,
// or "Fora do site" for a sale made privately and registered by hand.
const paymentMethodLabel = row => (row.imported ? 'Fora do site' : row.payment_method === 'manual' ? 'Manual · WhatsApp' : SERVICE[row.wiza_service] || row.wiza_service || '—');
const PAID = ['paid', 'ticketed'];
// Profit typed by the team after the purchase (null until then).
const hasProfit = row => row.profit_aoa !== null && row.profit_aoa !== undefined;
const AUDIT = {
  'rate.set': 'Câmbio definido',
  'booking.recheck': 'Pagamento verificado',
  'booking.confirm_manual': 'Pagamento confirmado manualmente',
  'booking.ticket': 'Bilhete emitido/editado',
  'booking.cancel': 'Reserva cancelada',
  'booking.refund': 'Reembolso registado',
  'booking.invoice': 'Factura emitida/actualizada',
  'booking.note': 'Notas editadas',
  'booking.clear_review': 'Revisão concluída',
  'booking.profit': 'Lucro registado',
  'booking.import': 'Venda registada à mão',
  'customer.update': 'Utilizador alterado',
  'system.sweep': 'Verificação de pagamentos',
  'pricing.markup': 'Taxa DOT alterada',
  'provider.resume': 'Pesquisas de voos retomadas',
  'alert.cancel': 'Aviso de preço desactivado',
  'alert.reactivate': 'Aviso de preço reactivado',
};
// Price alerts: label and badge colour of each state.
const ALERT_STATUS = { active: ['Activo', 'paid'], done: ['Concluído', 'ticketed'], expired: ['Expirado', 'expired'], cancelled: ['Desactivado', 'cancelled'] };
const ALERT_FILTERS = [['', 'Todos'], ['active', 'Activos'], ['notified', 'Com SMS enviado'], ['done', 'Concluídos'], ['expired', 'Expirados'], ['cancelled', 'Desactivados']];
// Monthly quota of the flight provider (SearchApi or SerpApi): the panel warns from 80% used.
const SERP_WARN = 0.8;
// DOT fee limits accepted by the server (MAX_MARKUP_BP in server/rates.mjs).
const MAX_MARKUP_PERCENT = 50;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

let me = null;
let rate = null;
let markupBp = 1100;
// Flight provider in use (SearchApi, or SerpApi when FLIGHTS_PROVIDER=serpapi), read from the overview.
let searchProvider = 'SearchApi';
let cities = {};
let listening = false;
let screenToken = 0;
let screen = { section: '', topics: [], title: 'Painel', run: null };
const live = { timer: null, clock: null, state: null, at: 0, paused: false, busy: false, failures: 0, pending: false, seenSearches: null, agoPaint: 0 };
// Searches feed: rows already shown (to highlight new/updated ones) and expanded journeys.
const feed = { known: null, expanded: new Set(), calls: new Map() };
let knownRefs = null;

const fmtNumber = value => new Intl.NumberFormat('pt-AO').format(Number(value) || 0);
const fmtRate = value => new Intl.NumberFormat('pt-AO', { maximumFractionDigits: 4 }).format(Number(value) || 0);
const pct = bp => `${new Intl.NumberFormat('pt-AO', { maximumFractionDigits: 2 }).format((Number(bp) || 0) / 100)}%`;
// Searches for a whole country use its 2-letter ISO code (e.g. BR = every airport in Brazil).
const regionNames = new Intl.DisplayNames(['pt-AO', 'pt-PT', 'pt'], { type: 'region' });
const wholeCountry = code => (/^[A-Z]{2}$/.test(code || '') ? regionNames.of(code) || code : null);
const city = code => (cities[code] ? `${cities[code]} (${code})` : wholeCountry(code) ? `${wholeCountry(code)} (todos os aeroportos)` : code);
// A city with several airports ("SVO,DME,VKO,ZIA"): the city of the first one.
const cityName = code => cities[code] || wholeCountry(code) || (String(code || '').includes(',') ? `${cities[code.split(',')[0]] || code.split(',')[0]} (todos)` : code);
const clockLuanda = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Luanda' });
const hourLuanda = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Luanda' });
const longToday = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Luanda' });
const relative = new Intl.RelativeTimeFormat('pt-PT', { numeric: 'auto' });
const timeOf = iso => (iso ? clockLuanda.format(new Date(iso)) : '');
const shortDay = iso => {
  if (!iso) return '';
  const [, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};
function ago(iso) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (!Number.isFinite(seconds)) return '';
  if (abs < 45) return 'agora mesmo';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}
// Search prices are stored in BRL: the admin sees them exactly as the customer did (câmbio + taxa DOT).
const priceText = brl => (brl == null ? '—' : rate?.rate ? formatKz(totalKz(brl, rate.rate, markupBp)) : formatBrl(totalBrl(brl, markupBp)));
const statusBadge = status => `<span class="badge ${esc(status)}">${esc(STATUS[status] || status)}</span>`;
const plural = (n, one, many) => `${fmtNumber(n)} ${Number(n) === 1 ? one : many}`;
const hIcon = glyph => `<span class="h-icon">${icon(glyph, 17)}</span>`;
const emptyState = (glyph, title, text = '') => `<div class="admin-empty"><span class="kpi-icon">${icon(glyph, 22)}</span><strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
const greeting = () => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Luanda' }).format(new Date()));
  return hour < 12 ? 'Bom dia' : hour < 19 ? 'Boa tarde' : 'Boa noite';
};
const view = () => $('#admin-view');
const stale = ctx => ctx.token !== screenToken || !view();

function toast(message, kind = 'ok', link = null) {
  let stack = $('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.append(stack);
  }
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.setAttribute('role', 'status');
  const glyph = { ok: 'checkCircle', error: 'alert', money: 'wallet', info: 'ticket' }[kind] || 'checkCircle';
  element.innerHTML = `${icon(glyph, 18)}<span>${esc(message)}${link ? `<a href="${esc(link.href)}">${esc(link.label)}</a>` : ''}</span>`;
  stack.append(element);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(() => element.remove(), kind === 'money' || kind === 'info' ? 9000 : 4500);
}

function ask({ title, text = '', fields = '', confirm = 'Confirmar', onSubmit }) {
  dialog.innerHTML = `<form novalidate><h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}${fields}
    <p class="form-error" role="alert" hidden></p>
    <div class="form-actions"><button type="button" class="link-btn" data-cancel>Cancelar</button><button type="submit" class="primary">${esc(confirm)}</button></div></form>`;
  const form = $('form', dialog);
  $('[data-cancel]', form).onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const button = $('[type=submit]', form);
    button.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      dialog.close();
    } catch (error) {
      const box = $('.form-error', form);
      box.textContent = error.message;
      box.hidden = false;
      button.disabled = false;
    }
  };
  dialog.showModal();
  $('input:not([type=checkbox]),select,textarea', form)?.focus();
}

function paintDocTitle() {
  const waiting = Number(live.state?.awaiting_ticket) || 0;
  document.title = `${waiting ? `(${waiting}) ` : ''}${screen.title} — Painel DOT Viagens`;
}

function setTitle(text, actions = '') {
  $('#admin-title').textContent = text;
  $('#admin-actions').innerHTML = actions;
  screen.title = text;
  paintDocTitle();
}

// ── Real time ────────────────────────────────────────────────────────────────
const editing = () => dialog.open || Boolean(document.activeElement?.matches?.('input, textarea, select') && view()?.contains(document.activeElement));

function refreshScreen() {
  if (editing()) {
    live.pending = true;
    return;
  }
  live.pending = false;
  screen.run?.(true);
}

function flushPending() {
  if (live.pending && !editing()) refreshScreen();
}

function updateBadges(state) {
  const bookings = $('[data-badge="bookings"]');
  if (bookings) {
    const waiting = Number(state.awaiting_ticket) || 0;
    const review = Number(state.needs_review) || 0;
    bookings.hidden = !waiting && !review;
    bookings.textContent = waiting ? String(waiting) : '!';
    bookings.classList.toggle('alert', review > 0);
    bookings.title = [waiting ? plural(waiting, 'bilhete por emitir', 'bilhetes por emitir') : '', review ? plural(review, 'pagamento para rever', 'pagamentos para rever') : ''].filter(Boolean).join(' · ');
  }
  const searches = $('[data-badge="searches"]');
  if (searches) {
    if (screen.section === 'searches' || live.seenSearches === null) live.seenSearches = Number(state.searches) || 0;
    const fresh = Number(state.searches) > live.seenSearches;
    searches.hidden = !fresh;
    searches.classList.toggle('dot', fresh);
    searches.title = fresh ? 'Há pesquisas novas' : '';
  }
  paintDocTitle();
}

function announce(previous, state) {
  const paid = state.last_paid;
  if (paid?.reference && paid.reference !== previous.last_paid?.reference) {
    toast(`Pagamento confirmado · ${paid.reference} · ${formatKz(paid.amount_aoa)}`, 'money', { href: `#booking/${encodeURIComponent(paid.reference)}`, label: 'Abrir' });
  }
  const created = state.last_booking;
  if (created?.reference && created.reference !== previous.last_booking?.reference) {
    toast(`Nova reserva · ${created.reference}${created.contact_name ? ` · ${created.contact_name}` : ''} · ${formatKz(created.amount_aoa)}`, 'info', { href: `#booking/${encodeURIComponent(created.reference)}`, label: 'Ver' });
  }
  if (Number(state.needs_review) > Number(previous.needs_review)) {
    toast('Há um pagamento para rever.', 'error', { href: '#bookings?status=review', label: 'Rever' });
  }
  const pause = pauseEnd(state);
  if (pause && pause !== pauseEnd(previous)) {
    toast(`Pesquisas de voos em pausa até ${hourLuanda.format(new Date(pause))}: a ${searchProvider} recusou pedidos por limite de uso.`, 'error', { href: '#overview', label: 'Ver' });
  }
  const alerts = value => Number(String(value ?? '').split(':')[0]) || 0;
  if (alerts(state.alerts) > alerts(previous.alerts)) {
    toast('Novo aviso de preço criado.', 'info', { href: '#alerts?status=active', label: 'Ver' });
  }
}

// End of the flight provider pause (ms) from the live state, or 0 when there is none.
function pauseEnd(state) {
  const until = Date.parse(state?.provider_pause?.until || '') || 0;
  return until > Date.now() ? until : 0;
}

function paintPill() {
  const pill = $('#live-pill');
  if (!pill) return;
  const offline = !live.paused && live.failures >= 2;
  pill.classList.toggle('paused', live.paused);
  pill.classList.toggle('offline', offline);
  pill.setAttribute('aria-pressed', String(live.paused));
  $('span', pill).textContent = live.paused ? 'Em pausa' : offline ? 'Sem ligação' : 'Ao vivo';
  const seconds = live.at ? Math.max(0, Math.round((Date.now() - live.at) / 1000)) : null;
  $('small', pill).textContent = live.paused ? 'retomar' : seconds === null ? '' : seconds < 2 ? 'agora' : seconds < 60 ? `há ${seconds} s` : `há ${Math.round(seconds / 60)} min`;
  // Relative times ("há 3 minutos") stay current without reloading the data.
  if (Date.now() - live.agoPaint > 15000) {
    live.agoPaint = Date.now();
    document.querySelectorAll('[data-ago]').forEach(element => { element.textContent = ago(element.dataset.ago); });
  }
}

async function tick() {
  if (!me || !live.timer || live.paused || live.busy || document.hidden) return;
  live.busy = true;
  try {
    const { state } = await api('/api/admin/live', { timeout: 10000 });
    const previous = live.state;
    live.state = state;
    live.at = Date.now();
    live.failures = 0;
    updateBadges(state);
    if (previous) {
      announce(previous, state);
      const changed = Object.keys(state).filter(key => JSON.stringify(state[key]) !== JSON.stringify(previous[key]));
      if (changed.some(topic => screen.topics.includes(topic))) refreshScreen();
    }
    flushPending();
  } catch (error) {
    live.failures += 1;
    if (error.status === 401 || (error.status === 403 && error.code === 'NOT_ADMIN')) handleError(error);
  } finally {
    live.busy = false;
    paintPill();
  }
}

function startLive() {
  stopLive();
  live.timer = setInterval(tick, LIVE_MS);
  live.clock = setInterval(paintPill, 1000);
  tick();
}

function stopLive() {
  clearInterval(live.timer);
  clearInterval(live.clock);
  Object.assign(live, { timer: null, clock: null, state: null, at: 0, failures: 0, pending: false, seenSearches: null });
}

// ── Access ───────────────────────────────────────────────────────────────────
function loginScreen(notice = '') {
  stopLive();
  root.innerHTML = `<div class="admin-login">
    <section class="login-photo"><img src="/assets/logo-dot-320.png" alt="DOT Viagens">
      <div><span class="eyebrow light">PAINEL DE ADMINISTRAÇÃO</span><h1>Tudo o que acontece na DOT, <em>ao vivo.</em></h1>
        <p>Pesquisas, compras, bilhetes e o câmbio do dia num só lugar. Entra com o número de telemóvel autorizado.</p>
        <div class="login-points"><span>${icon('activity', 15)} Pesquisas em tempo real</span><span>${icon('ticket', 15)} Compras e bilhetes</span><span>${icon('coins', 15)} Câmbio e taxa DOT</span></div></div>
      <small>Luanda · Marginal ao anoitecer</small></section>
    <section class="login-side"><div class="login-card">
      <div class="login-eyebrow"><span class="kpi-icon">${icon('shield', 20)}</span><span class="eyebrow">ACESSO RESERVADO À EQUIPA DOT</span></div>
      ${notice ? `<div class="notice error">${icon('alert', 18)}<div>${esc(notice)}</div></div>` : ''}<div id="otp"></div></div></section></div>`;
  document.title = 'Entrar — Painel DOT Viagens';
  mountOtp($('#otp'), {
    purpose: 'admin',
    title: 'Entrar no painel',
    subtitle: 'Só os números com acesso de administrador recebem o código por SMS.',
    submitLabel: 'Enviar código',
    onSuccess: customer => {
      me = customer;
      if (customer.role === 'admin') shell();
      else loginScreen('Esta conta não tem acesso de administrador.');
    },
  });
}

function shell() {
  const initials = (me.name || 'Administrador').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  root.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><a class="admin-brand" href="#overview"><img src="/assets/logo-dot-320.png" alt="DOT Viagens"><span>PAINEL</span></a>
    ${NAV.map(([label, items]) => `<div class="nav-label">${label}</div><nav class="admin-nav" aria-label="${label === 'OPERAÇÃO' ? 'Operação' : 'Configuração'}">${items.map(([key, text, glyph]) => `<a href="#${key}" data-section="${key}">${icon(glyph, 18)}<span>${text}</span><b class="nav-badge" data-badge="${key}" hidden></b></a>`).join('')}</nav>`).join('')}
    <div class="admin-user"><span class="avatar" aria-hidden="true">${esc(initials)}</span><div><strong>${esc(me.name || 'Administrador')}</strong>${esc(formatPhone(me.phone))}<br><button class="link-btn" id="logout" type="button">${icon('logout', 13)} Terminar sessão</button></div></div></aside>
    <main class="admin-main"><header class="admin-top"><div><span class="eyebrow">PAINEL DOT VIAGENS</span><h1 id="admin-title"></h1></div>
      <div class="admin-top-actions"><div class="admin-actions" id="admin-actions"></div><button class="live-pill" id="live-pill" type="button" aria-pressed="false" title="Pausar ou retomar as actualizações automáticas"><i></i><span>Ao vivo</span><small></small></button><button class="btn-sm mobile-logout" id="logout-mobile" type="button" aria-label="Terminar sessão">${icon('logout', 14)}</button></div></header>
      <div class="admin-view" id="admin-view"></div></main></div>`;
  const logout = async () => {
    await auth.logout().catch(() => {});
    me = null;
    loginScreen();
  };
  $('#logout').onclick = logout;
  $('#logout-mobile').onclick = logout;
  $('#live-pill').onclick = () => {
    live.paused = !live.paused;
    paintPill();
    if (!live.paused) tick();
  };
  if (!listening) {
    addEventListener('hashchange', route);
    dialog.addEventListener('close', () => setTimeout(flushPending, 0));
    document.addEventListener('focusout', () => setTimeout(flushPending, 0));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });
    listening = true;
  }
  startLive();
  route();
}

function handleError(error) {
  if (error.status === 401) {
    me = null;
    return loginScreen('A sessão terminou. Entra novamente.');
  }
  if (error.status === 403 && error.code === 'NOT_ADMIN') {
    me = null;
    return loginScreen(error.message);
  }
  if (view()) view().innerHTML = `<div class="admin-card"><div class="notice error">${icon('alert', 18)}<div>${esc(error.message)}</div></div></div>`;
}

function route() {
  if (!me || !view()) return;
  if (dialog.open) dialog.close();
  const [path, query = ''] = (location.hash.slice(1) || 'overview').split('?');
  const [requested, argument] = path.split('/');
  const params = new URLSearchParams(query);
  const handlers = {
    overview: overviewView,
    searches: searchesView,
    bookings: bookingsView,
    booking: (p, ctx) => bookingView(decodeURIComponent(argument || ''), ctx),
    customers: customersView,
    alerts: alertsView,
    rates: ratesView,
    sms: smsView,
    audit: auditView,
    system: systemView,
  };
  const section = handlers[requested] ? requested : 'overview';
  const nav = section === 'booking' ? 'bookings' : section;
  document.querySelectorAll('[data-section]').forEach(link => {
    const active = link.dataset.section === nav;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const token = ++screenToken;
  live.pending = false;
  if (section !== 'searches') {
    feed.known = null;
    feed.expanded.clear();
    feed.calls.clear();
  }
  knownRefs = null;
  screen = {
    section,
    topics: TOPICS[section] || [],
    title: screen.title,
    run: silent => Promise.resolve(handlers[section](params, { token, silent })).catch(error => {
      if (!silent || error.status === 401 || error.status === 403) handleError(error);
    }),
  };
  if (section === 'searches' && live.state) {
    live.seenSearches = Number(live.state.searches) || 0;
    updateBadges(live.state);
  }
  view().innerHTML = '<div class="admin-card loading-card"><span class="spinner"></span></div>';
  scrollTo({ top: 0 });
  screen.run(false);
}

// ── Shared pieces ────────────────────────────────────────────────────────────
const kpi = (glyph, label, value, sub, href = '', extra = '') => {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${extra}"${href ? ` href="${href}"` : ''}><span class="kpi-icon">${icon(glyph, 21)}</span><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(sub)}</span></${tag}>`;
};

const table = (head, rows, empty, cls = '') => `<div class="table-wrap${cls ? ` ${cls}` : ''}"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td class="empty" colspan="12">${esc(empty)}</td></tr>`}</tbody></table></div>`;

// Phones (admin.css): each table row becomes a card and each cell shows its column name,
// taken here from the table header, so nothing needs horizontal scrolling.
function labelCells(scope) {
  scope.querySelectorAll('table.data-table:not([data-labels])').forEach(element => {
    const labels = [...element.querySelectorAll('thead th')].map(th => th.textContent.trim());
    element.querySelectorAll('tbody tr').forEach(row => [...row.cells].forEach((cell, index) => {
      if (labels[index] && cell.colSpan === 1) cell.dataset.label = labels[index];
    }));
    element.dataset.labels = '';
  });
}
new MutationObserver(() => labelCells(root)).observe(root, { childList: true, subtree: true });

function pager(total, offset, limit, base) {
  if (total <= limit) return `<div class="pager"><span>${plural(total, 'registo', 'registos')}</span></div>`;
  const prev = Math.max(0, offset - limit);
  const next = offset + limit;
  const link = value => {
    const [path, query = ''] = base.split('?');
    const params = new URLSearchParams(query);
    params.set('offset', value);
    return `#${path}?${params}`;
  };
  return `<div class="pager"><span>${fmtNumber(offset + 1)}–${fmtNumber(Math.min(total, offset + limit))} de ${fmtNumber(total)}</span><div>
    ${offset > 0 ? `<a class="btn-sm" href="${link(prev)}">${icon('arrowLeft', 14)} Anterior</a>` : ''}
    ${next < total ? `<a class="btn-sm" href="${link(next)}">Seguinte ${icon('arrowRight', 14)}</a>` : ''}</div></div>`;
}

function integrationList(state, sms) {
  const row = (ok, label, sub) => `<div><span><strong>${esc(label)}</strong><small>${esc(sub)}</small></span><span class="${ok ? 'ok-dot' : 'no-dot'}">${ok ? 'Activo' : 'Por configurar'}</span></div>`;
  return `<div class="status-list">
    ${row(state.supabase, 'Base de dados', 'Supabase')}
    ${row(state.search, 'Pesquisa de voos', `${state.searchProvider || searchProvider} · Google Flights e calendário de preços`)}
    ${row(state.sms, 'SMS', sms ? `Nsangu · ${fmtNumber(sms.availableSms)} SMS disponíveis` : 'Nsangu')}
    ${row(state.email, 'E-mails', 'Resend · confirmação ao cliente e aviso de compra')}
    ${row(state.payments, 'Pagamentos', 'Wiza · Multicaixa Express e referência')}
    ${row(state.invoices, 'Facturação', state.invoicesSandbox ? 'Vero · chave de teste (não chega à AGT)' : 'Vero · factura certificada AGT')}
    ${row(state.auth && state.offerSigning, 'Segredos internos', 'AUTH_SECRET e OFFER_SECRET')}
  </div>`;
}

function rateCard(current, today) {
  if (!current) {
    return `<div class="admin-card rate-card"><div class="card-head"><div><h2>${hIcon('coins')} Câmbio do dia</h2><p>Ainda não definido</p></div><a class="btn-sm" href="#rates">Definir</a></div>
      <div class="notice">${icon('alert', 18)}<div>Sem câmbio, os preços aparecem em reais e as compras ficam bloqueadas.</div></div></div>`;
  }
  return `<div class="admin-card rate-card"><div class="card-head"><div><h2>${hIcon('coins')} Câmbio do dia</h2><p>Em vigor desde ${esc(formatDate(current.effectiveDate))}</p></div><a class="btn-sm" href="#rates">Actualizar</a></div>
    <div class="rate-big">1 R$ = ${fmtRate(current.rate)} Kz</div>
    <div class="rate-meta"><div><small>Taxa DOT</small><strong>${pct(markupBp)}</strong></div><div><small>R$ 1.000 ao cliente</small><strong>${formatKz(totalKz(1000, current.rate, markupBp))}</strong></div></div>
    ${current.effectiveDate !== today ? `<div class="notice">${icon('alert', 18)}<div>O câmbio não foi actualizado hoje. Os preços continuam a usar este valor.</div></div>` : ''}</div>`;
}

// Plan and usage of the flight provider (read by the server with its free account call).
const serpUsed = serp => (serp?.monthly ? Math.min(1, Math.max(0, (Number(serp.used) || 0) / serp.monthly)) : null);
const serpLevel = serp => {
  const used = serpUsed(serp);
  return used === null ? '' : used >= 1 ? 'full' : used >= SERP_WARN ? 'warn' : '';
};

function serpCard(serp) {
  const head = `<div class="card-head"><div><h2>${hIcon('globe')} Cota da ${esc(serp?.provider || searchProvider)}</h2><p>${serp ? `${esc(serp.plan || serp.provider || 'Plano')}${serp.monthly ? ` · ${fmtNumber(serp.monthly)} pesquisas por mês` : ''}` : 'Pesquisa de voos e calendário de preços'}</p></div><a class="btn-sm" href="${(serp?.provider || searchProvider) === 'SerpApi' ? 'https://serpapi.com/dashboard' : 'https://www.searchapi.io/'}" target="_blank" rel="noopener">${icon('external', 14)} Conta</a></div>`;
  if (!serp) return `<div class="admin-card serp-card">${head}<div class="notice info">${icon('info', 18)}<div>Não foi possível ler o plano e o uso da ${esc(searchProvider)} agora. A pesquisa de voos não depende disto.</div></div></div>`;
  const used = serpUsed(serp);
  const level = serpLevel(serp);
  const percent = used === null ? '—' : `${Math.round(used * 100)}%`;
  const warning = level === 'full'
    ? 'A cota do mês acabou: as pesquisas de voos param até a cota renovar ou até subires de plano.'
    : `Já foi usado ${percent} da cota do mês. Ao chegar a 100%, as pesquisas de voos param até a cota renovar. Considera subir de plano.`;
  return `<div class="admin-card serp-card">${head}
    <div class="usage-big">${fmtNumber(serp.used)}<small>de ${serp.monthly ? fmtNumber(serp.monthly) : '—'} pesquisas este mês · ${percent}</small></div>
    <div class="usage-bar ${level}" role="img" aria-label="${percent} da cota do mês usada"><i style="width:${used === null ? 0 : Math.max(2, Math.round(used * 100))}%"></i></div>
    <div class="status-list">
      <div><span><strong>Restam</strong><small>Do plano e créditos extra</small></span><b>${serp.left == null ? '—' : fmtNumber(serp.left)}</b></div>
      <div><span><strong>Última hora</strong><small>Pesquisas feitas · limite por hora do plano</small></span><b>${fmtNumber(serp.lastHour)}${serp.hourLimit ? ` de ${fmtNumber(serp.hourLimit)}` : ''}</b></div>
    </div>
    ${level ? `<div class="notice ${level === 'full' ? 'error' : ''}" style="margin-top:14px">${icon('alert', 18)}<div>${warning}</div></div>` : ''}</div>`;
}

// Searches paused after a provider quota error (HTTP 429): customers see a notice meanwhile.
function pauseNotice(until) {
  if (!until) return '';
  return `<div class="notice error pause-notice">${icon('alert', 18)}<div><strong>Pesquisas de voos em pausa até ${esc(hourLuanda.format(new Date(until)))}.</strong> A ${esc(searchProvider)} recusou pedidos por limite de uso. Entretanto os clientes vêem um aviso para tentarem mais tarde ou falarem no WhatsApp. Se o plano já foi renovado, retoma agora.
    <div class="pause-actions"><button class="btn-sm primary-sm" type="button" data-resume>${icon('refresh', 14)} Retomar agora</button></div></div></div>`;
}

function bindResume() {
  view()?.querySelectorAll('[data-resume]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api('/api/admin/provider/resume', { method: 'POST', body: {} });
        toast('Pesquisas de voos retomadas.');
        route();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    };
  });
}

// Journeys: one customer search with the dates and returns it consulted.
const tripDates = j => `${shortDay(j.departure_date)}${j.return_date ? ` — ${shortDay(j.return_date)}` : ' · só ida'}`;
const bestBrl = j => j.outbound_min_brl ?? j.view_min_brl ?? j.return_min_brl;
const priceFrom = j => (bestBrl(j) == null ? (j.last_status === 'error' ? 'Erro do fornecedor' : 'Sem voos') : `desde ${priceText(bestBrl(j))}`);
const whoText = j => (j.customer ? j.customer.name || formatPhone(j.customer.phone) : `Visitante ${String(j.visitor || '').slice(0, 6)}`);
// Where the search was made: city and country from the IP (Vercel/Cloudflare geolocation), approximate.
const placeOf = j => {
  const place = [j.city, j.country ? countryName(j.country) : ''].filter(Boolean).join(', ');
  return place ? `<span class="place" title="Localização aproximada, pelo IP">${icon('pin', 12)}${esc(place)}</span>` : '';
};

function activityList(rows) {
  if (!rows.length) return emptyState('activity', 'Ainda não há pesquisas registadas.', 'Assim que alguém pesquisar no site, a pesquisa aparece aqui em segundos.');
  return `<ul class="activity-list">${rows.map(j => `<li><span class="activity-icon">${icon(j.round_trip ? 'swap' : 'plane', 17)}</span>
    <div><strong>${esc(cityName(j.origin))} → ${esc(cityName(j.destination))}</strong><small>${esc(tripDates(j))} · ${plural(j.passengers, 'adulto', 'adultos')}</small><small class="activity-who">${esc(whoText(j))}${placeOf(j) ? ` · ${placeOf(j)}` : ''}</small></div>
    <div class="activity-meta"><b>${esc(priceFrom(j))}</b><small data-ago="${esc(j.last_at)}">${esc(ago(j.last_at))}</small></div></li>`).join('')}</ul>`;
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function overviewView(params, ctx) {
  setTitle('Visão geral', `<a class="btn-sm" href="/" target="_blank" rel="noopener">${icon('external', 14)} Ver o site</a>`);
  const [data, recent] = await Promise.all([api('/api/admin/overview'), api('/api/admin/searches?limit=8')]);
  if (stale(ctx)) return;
  rate = data.rate;
  markupBp = data.pricing?.markupBp ?? markupBp;
  searchProvider = data.integrations?.searchProvider || searchProvider;
  const s = data.stats || {};
  const firstName = String(me.name || '').trim().split(/\s+/)[0];
  const quota = serpUsed(data.serp);
  view().innerHTML = `${pauseNotice(Date.parse(data.provider?.pausedUntil || '') || 0)}<section class="admin-hero"><div>
      <span class="eyebrow light">${esc(longToday.format(new Date()).toUpperCase())} · LUANDA</span>
      <h2>${greeting()}${firstName ? `, ${esc(firstName)}` : ''}.</h2>
      <p>Hoje: ${plural(s.searches_today, 'pesquisa', 'pesquisas')}, ${plural(s.visitors_today, 'visitante', 'visitantes')} e ${plural(s.paid_today, 'compra paga', 'compras pagas')}. Os números actualizam-se sozinhos.</p>
      <div class="hero-chips">
        ${s.awaiting_ticket ? `<a class="hero-chip warn" href="#bookings?status=paid">${icon('plane', 15)} ${plural(s.awaiting_ticket, 'bilhete por emitir', 'bilhetes por emitir')}</a>` : `<span class="hero-chip">${icon('checkCircle', 15)} Sem bilhetes por emitir</span>`}
        ${s.needs_review ? `<a class="hero-chip warn" href="#bookings?status=review">${icon('alert', 15)} ${plural(s.needs_review, 'pagamento para rever', 'pagamentos para rever')}</a>` : ''}
        <a class="hero-chip" href="#rates">${icon('coins', 15)} ${data.rate ? `1 R$ = ${fmtRate(data.rate.rate)} Kz` : 'Câmbio por definir'}</a>
      </div></div>
      <div class="hero-stats"><div><small>Vendas hoje</small><strong>${formatKz(s.revenue_today)}</strong><span>${formatKz(s.revenue_30d)} em 30 dias</span></div>
        <div><small>Lucro hoje</small><strong>${formatKz(s.profit_today)}</strong><span>${formatKz(s.profit_30d)} em 30 dias</span></div></div></section>
    <div class="kpi-grid cols-4">
      ${kpi('activity', 'Pesquisas hoje', fmtNumber(s.searches_today), `${fmtNumber(s.searches_hour)} na última hora`, '#searches')}
      ${kpi('users', 'Visitantes hoje', fmtNumber(s.visitors_today), plural(s.searches_7d, 'pesquisa em 7 dias', 'pesquisas em 7 dias'))}
      ${kpi('ticket', 'Compras pagas hoje', fmtNumber(s.paid_today), plural(s.bookings_today, 'reserva criada hoje', 'reservas criadas hoje'), '#bookings', s.paid_today ? 'good' : '')}
      ${kpi('plane', 'Bilhetes por emitir', fmtNumber(s.awaiting_ticket), 'Pagos, à espera de emissão', '#bookings?status=paid', s.awaiting_ticket ? 'warn' : '')}
      ${kpi('clock', 'Pagamentos pendentes', fmtNumber(s.pending_payment), 'Express ou referência por pagar', '#bookings?status=pending_payment')}
      ${kpi('alert', 'Para rever', fmtNumber(s.needs_review), 'Pagamentos por confirmar à mão', '#bookings?status=review', s.needs_review ? 'warn' : '')}
      ${kpi('user', 'Clientes', fmtNumber(s.customers_total), plural(s.customers_7d, 'novo em 7 dias', 'novos em 7 dias'), '#customers')}
      ${kpi('globe', `Consultas à ${searchProvider} hoje`, fmtNumber(s.provider_calls_today), quota === null ? 'Datas escolhidas, voltas e calendário' : `${Math.round(quota * 100)}% da cota do mês usada`, '#searches', serpLevel(data.serp) ? 'warn' : '')}
    </div>
    <div class="admin-grid"><div><div class="admin-card"><div class="card-head"><div><h2>${hIcon('activity')} Pesquisas agora</h2><p>As pesquisas mais recentes, uma linha por cliente.</p></div><a class="btn-sm" href="#searches">Ver todas ${icon('arrowRight', 14)}</a></div>
        ${activityList(recent.journeys || [])}</div>
        <div class="admin-card"><h2>${hIcon('settings')} Integrações</h2><p>Configuradas no ambiente do Worker.</p>${integrationList(data.integrations, data.sms)}</div></div>
      <div>${rateCard(data.rate, data.today)}${data.integrations?.search ? serpCard(data.serp) : ''}
        <div class="admin-card"><h2>${hIcon('wallet')} Vendas e lucro</h2><p>Compras pagas ou emitidas. O lucro é o valor que a equipa insere em cada compra.</p>
          <div class="money-rows"><div><span>30 dias</span><strong>${formatKz(s.revenue_30d)}</strong><small>lucro ${formatKz(s.profit_30d)}</small></div>
            <div><span>Desde o início</span><strong>${formatKz(s.revenue_total)}</strong><small>lucro ${formatKz(s.profit_total)}</small></div></div>
          ${s.profit_missing ? `<div class="notice" style="margin-top:14px">${icon('wallet', 18)}<div>${plural(s.profit_missing, 'compra paga sem lucro inserido', 'compras pagas sem lucro inserido')}. <a class="link-btn" href="#bookings?status=no_profit">Inserir lucro</a></div></div>` : ''}
          ${s.invoices_missing ? `<div class="notice" style="margin-top:14px">${icon('receipt', 18)}<div>${plural(s.invoices_missing, 'compra paga sem factura', 'compras pagas sem factura')}. Abre a reserva para reemitir.</div></div>` : ''}</div></div></div>`;
  bindResume();
}

// ── Exchange rate and price ──────────────────────────────────────────────────
async function ratesView(params, ctx) {
  setTitle('Câmbio e preço');
  const data = await api('/api/admin/rates');
  if (stale(ctx)) return;
  markupBp = data.pricing?.markupBp ?? markupBp;
  const current = data.rows[0];
  if (current) rate = { rate: Number(current.rate), effectiveDate: current.effective_date };
  const fee = data.pricing || {};
  const feeChange = fee.editor?.name
    ? `alterada a ${esc(formatDateTime(fee.updatedAt))} por ${esc(fee.editor.name)}`
    : 'valor inicial do sistema';
  view().innerHTML = `<div class="admin-grid"><div><div class="admin-card"><h2>${hIcon('coins')} Definir o câmbio</h2>
      <p>Os preços da pesquisa chegam em reais (BRL). O cliente vê o valor convertido a este câmbio (arredondado para cima ao kwanza) mais a taxa DOT de ${pct(markupBp)}, num único preço final.</p>
      <form id="rate-form" novalidate><div class="form-grid">
        <label class="form-field"><span>1 real brasileiro (R$) vale, em kwanzas</span><input name="rate" inputmode="decimal" required placeholder="Ex.: 165,50" value="${current ? esc(String(current.rate).replace('.', ',')) : ''}"></label>
        <label class="form-field"><span>Data de referência</span><input name="effectiveDate" type="date" value="${esc(data.today)}"></label>
        <label class="form-field span-2"><span>Nota (opcional)</span><input name="note" maxlength="140" placeholder="Ex.: BNA, câmbio do dia"></label></div>
        <div class="price-preview" id="rate-preview" aria-live="polite"></div>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions"><span class="muted">Fica activo imediatamente para novas pesquisas e compras.</span><button class="primary" type="submit">${icon('check', 16)} Guardar câmbio</button></div></form></div>
      <div class="admin-card"><h2>${hIcon('trend')} Taxa DOT</h2>
        <p>Percentagem somada ao valor convertido em kwanzas, dentro do preço final. Em vigor: <b>${pct(markupBp)}</b> (${feeChange}). Ao mudar, os preços novos aparecem logo nas pesquisas, no calendário, nos avisos e nas compras; as reservas já criadas mantêm o preço.</p>
        <form id="markup-form" novalidate><div class="form-grid">
          <label class="form-field"><span>Nova taxa DOT (%)</span><input name="markup" inputmode="decimal" required maxlength="6" placeholder="Ex.: 11 ou 11,5" value="${esc(String(markupBp / 100).replace('.', ','))}"></label></div>
          <div class="price-preview" id="markup-preview" aria-live="polite"></div>
          <p class="form-error" role="alert" hidden></p>
          <div class="form-actions"><span class="muted">De 0% a ${MAX_MARKUP_PERCENT}%. Cada alteração fica na auditoria.</span><button class="primary" type="submit">${icon('check', 16)} Guardar taxa</button></div></form></div></div>
    <div>${rateCard(current ? { rate: current.rate, effectiveDate: current.effective_date } : null, data.today)}
      <div class="admin-card"><h2>${hIcon('info')} Como se calcula o preço</h2><ol class="formula">
        <li><b>Voo em reais</b><span>O preço devolvido pela pesquisa (Google Flights, via ${esc(searchProvider)}).</span></li>
        <li><b>× câmbio do dia</b><span>Arredondado para cima ao kwanza.</span></li>
        <li><b>+ taxa DOT de ${pct(markupBp)}</b><span>Calculada sobre o valor convertido.</span></li>
        <li><b>= preço ao cliente</b><span>Um só valor, sem a taxa à parte. É o que a Wiza cobra e o que o Vero factura.</span></li></ol></div></div></div>
    <div class="admin-card"><h2>${hIcon('list')} Histórico</h2><p>Cada alteração fica registada com o autor.</p>
    ${table('<th>Registado em</th><th>Data de referência</th><th class="num">1 R$ =</th><th>Nota</th><th>Por</th>', data.rows.map(row => `<tr><td>${esc(formatDateTime(row.created_at))}</td><td>${esc(formatDate(row.effective_date))}</td><td class="num"><strong>${fmtRate(row.rate)} Kz</strong></td><td>${esc(row.note || '—')}</td><td>${esc(row.creator?.name || '—')}<small>${esc(formatPhone(row.creator?.phone))}</small></td></tr>`).join(''), 'Ainda não há câmbios registados.')}</div>`;
  const form = $('#rate-form');
  const input = form.querySelector('[name=rate]');
  const preview = () => {
    const value = Number(String(input.value).replace(/\s/g, '').replace(',', '.'));
    if (!(value > 0)) {
      $('#rate-preview').innerHTML = `<div class="notice-line">${icon('info', 16)}<span>Escreve o valor para ver o exemplo.</span></div>`;
      return;
    }
    const base = toKz(3500, value);
    const total = totalKz(3500, value, markupBp);
    $('#rate-preview').innerHTML = `<div class="preview-row"><span>Voo de R$ 3.500,00 convertido</span><b>${formatKz(base)}</b></div>
      <div class="preview-row"><span>Taxa DOT (${pct(markupBp)})</span><b>+ ${formatKz(total - base)}</b></div>
      <div class="preview-row total"><span>O cliente vê e paga</span><b>${formatKz(total)}</b></div>`;
  };
  input.oninput = preview;
  preview();
  form.onsubmit = async event => {
    event.preventDefault();
    const box = $('.form-error', form);
    box.hidden = true;
    try {
      await api('/api/admin/rates', {
        method: 'POST',
        body: {
          rate: String(input.value).replace(/\s/g, '').replace(',', '.'),
          effectiveDate: form.querySelector('[name=effectiveDate]').value,
          note: form.querySelector('[name=note]').value,
        },
      });
      document.activeElement?.blur();
      toast('Câmbio guardado.');
      route();
    } catch (error) {
      box.textContent = error.message;
      box.hidden = false;
    }
  };

  // DOT fee: example with the typed percentage, then a confirmation (it changes every price at once).
  const feeForm = $('#markup-form');
  const feeInput = feeForm.querySelector('[name=markup]');
  const typedBp = () => {
    const text = String(feeInput.value).replace('%', '').replace(/\s/g, '').replace(',', '.');
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value < 0 || value > MAX_MARKUP_PERCENT) return null;
    const bp = Math.round(value * 100);
    return Math.abs(bp - value * 100) < 1e-6 ? bp : null;
  };
  const feePreview = () => {
    const bp = typedBp();
    const target = $('#markup-preview');
    if (bp === null) {
      target.innerHTML = `<div class="notice-line">${icon('info', 16)}<span>Escreve uma percentagem de 0 a ${MAX_MARKUP_PERCENT}, com até 2 casas decimais.</span></div>`;
      return;
    }
    if (!rate?.rate) {
      target.innerHTML = `<div class="notice-line">${icon('info', 16)}<span>Define o câmbio para ver o exemplo em kwanzas.</span></div>`;
      return;
    }
    const base = toKz(3500, rate.rate);
    const total = totalKz(3500, rate.rate, bp);
    target.innerHTML = `<div class="preview-row"><span>Voo de R$ 3.500,00 convertido</span><b>${formatKz(base)}</b></div>
      <div class="preview-row"><span>Taxa DOT (${pct(bp)})</span><b>+ ${formatKz(total - base)}</b></div>
      <div class="preview-row total"><span>O cliente vê e paga</span><b>${formatKz(total)}</b></div>`;
  };
  feeInput.oninput = feePreview;
  feePreview();
  feeForm.onsubmit = event => {
    event.preventDefault();
    const box = $('.form-error', feeForm);
    box.hidden = true;
    const bp = typedBp();
    if (bp === null) {
      box.textContent = `Indica a taxa em percentagem, de 0 a ${MAX_MARKUP_PERCENT} (por exemplo 11 ou 11,5).`;
      box.hidden = false;
      return;
    }
    if (bp === markupBp) {
      box.textContent = `A taxa DOT já é ${pct(bp)}.`;
      box.hidden = false;
      return;
    }
    document.activeElement?.blur();
    ask({
      title: 'Mudar a taxa DOT?',
      text: `De <b>${pct(markupBp)}</b> para <b>${pct(bp)}</b>. Os preços novos aparecem logo em todo o site.`,
      confirm: 'Guardar taxa',
      onSubmit: async () => {
        const result = await api('/api/admin/pricing', { method: 'POST', body: { markupPercent: String(bp / 100) } });
        markupBp = result.pricing?.markupBp ?? bp;
        toast(`Taxa DOT guardada: ${pct(markupBp)}.`);
        route();
      },
    });
  };
}

// ── Searches (real time, one row per customer search) ────────────────────────
function journeyRow(j, index, previous) {
  const isNew = previous && !previous.has(j.key);
  const updated = previous && previous.has(j.key) && previous.get(j.key) !== j.last_id;
  const stages = j.round_trip
    ? `<span class="stages"><span class="stage done">Ida · ${plural(j.outbound_dates, 'data', 'datas')}</span><span class="stage ${j.reached_return ? 'done' : ''}">Volta${j.reached_return ? ` · ${plural(j.return_dates, 'data', 'datas')}` : ''}</span></span>`
    : `<span class="stages"><span class="stage done">Só ida · ${plural(j.outbound_dates, 'data', 'datas')}</span></span>`;
  const progress = j.chosen_outbound_date
    ? `Ida escolhida a ${shortDay(j.chosen_outbound_date)}${j.chosen_return_date ? ` · volta a ${shortDay(j.chosen_return_date)}` : ''}`
    : j.round_trip ? 'A escolher a ida' : 'A comparar datas';
  const place = placeOf(j);
  const who = j.customer
    ? `<strong>${esc(j.customer.name || 'Cliente')}</strong><small>${esc(formatPhone(j.customer.phone))}</small>${place ? `<small>${place}</small>` : ''}`
    : `<strong>Visitante ${esc(String(j.visitor || '').slice(0, 6))}</strong><small>${place || 'Localização desconhecida'}</small>`;
  const calls = `${plural(j.calls, 'consulta', 'consultas')}${j.errors ? ` · ${plural(j.errors, 'erro', 'erros')}` : ''}`;
  return `<article class="journey${isNew ? ' new' : ''}${updated ? ' updated' : ''}" data-key="${esc(j.key)}">
    <button class="journey-main" type="button" aria-expanded="false" aria-controls="calls-${index}">
      <span class="journey-time"><b>${esc(hourLuanda.format(new Date(j.last_at)))}</b><small data-ago="${esc(j.last_at)}">${esc(ago(j.last_at))}</small></span>
      <span class="journey-route"><strong>${esc(cityName(j.origin))}<i>${j.round_trip ? '⇄' : '→'}</i>${esc(cityName(j.destination))}</strong><small>${esc(j.origin)} · ${esc(j.destination)} · ${plural(j.passengers, 'adulto', 'adultos')} · ${esc(calls)}</small></span>
      <span class="journey-dates"><strong>${esc(tripDates(j))}</strong>${stages}</span>
      <span class="journey-price"><strong>${esc(priceFrom(j))}</strong><small>${esc(progress)}</small></span>
      <span class="journey-who">${who}</span>
      <span class="journey-toggle">${icon('chevron', 16)}</span>
    </button>
    <div class="journey-calls" id="calls-${index}" hidden></div></article>`;
}

const callRow = row => `<tr><td class="mono">${esc(timeOf(row.created_at))}</td>
  <td>${esc(KIND[row.kind] || '—')}${row.has_token ? '<small>voltas da ida escolhida</small>' : ''}</td>
  <td>${esc(shortDay(row.departure_date))}${row.return_date ? ` — ${esc(shortDay(row.return_date))}` : ''}</td>
  <td>${row.status === 'ok' ? `${plural(row.offers_count, 'opção', 'opções')}<small>desde ${esc(priceText(row.min_price_brl))}</small>` : row.status === 'empty' ? 'Sem voos' : `<span class="no-dot">Erro</span><small>${esc(row.error_code || '')}</small>`}</td>
  <td>${row.cached ? '<span class="tag">Cache</span>' : '<span class="tag serp">Pesquisa paga</span>'}</td>
  <td class="num">${row.duration_ms != null ? `${fmtNumber(row.duration_ms)} ms` : '—'}</td></tr>`;

async function openCalls(article) {
  const key = article.dataset.key;
  const button = $('.journey-main', article);
  const panel = $('.journey-calls', article);
  button.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
  feed.expanded.add(key);
  panel.innerHTML = feed.calls.get(key) || '<div class="calls-loading"><span class="spinner"></span> A carregar as consultas desta pesquisa…</div>';
  try {
    const { rows } = await api(`/api/admin/searches/calls?key=${encodeURIComponent(key)}`);
    const html = rows.length
      ? table('<th>Hora</th><th>Etapa</th><th>Datas</th><th>Resultado</th><th>Origem</th><th class="num">Tempo</th>', rows.map(callRow).join(''), '')
      : '<p class="muted">Sem consultas registadas.</p>';
    feed.calls.set(key, html);
    if (article.isConnected && feed.expanded.has(key)) panel.innerHTML = html;
  } catch (error) {
    if (article.isConnected) panel.innerHTML = `<div class="notice error">${icon('alert', 18)}<div>${esc(error.message)}</div></div>`;
  }
}

async function searchesView(params, ctx) {
  setTitle('Pesquisas', `<a class="btn-sm" href="/#pesquisa" target="_blank" rel="noopener">${icon('external', 14)} Fazer uma pesquisa</a>`);
  if (!rate) {
    const current = await api('/api/rate').catch(() => null);
    if (current?.rate) rate = { rate: current.rate, effectiveDate: current.effectiveDate };
    if (Number.isInteger(current?.markupBp)) markupBp = current.markupBp;
  }
  const data = await api('/api/admin/searches?limit=60&stats=1');
  if (stale(ctx)) return;
  markupBp = data.pricing?.markupBp ?? markupBp;
  const stats = data.stats || {};
  const journeys = data.journeys || [];
  const previous = ctx.silent ? feed.known : null;
  feed.known = new Map(journeys.map(j => [j.key, j.last_id]));
  const days = stats.per_day || [];
  const peak = Math.max(1, ...days.map(day => day.n));
  const routes = stats.top_routes || [];
  const top = Math.max(1, ...routes.map(item => item.n));
  view().innerHTML = `<div class="kpi-grid cols-5">
      ${kpi('activity', 'Pesquisas · 7 dias', fmtNumber(stats.journeys), 'Cada pesquisa conta uma vez')}
      ${kpi('users', 'Visitantes únicos', fmtNumber(stats.visitors), 'Sem guardar o IP')}
      ${kpi('globe', 'Pesquisas pagas', fmtNumber(stats.provider_calls), `${fmtNumber(stats.calendar_calls)} do calendário`)}
      ${kpi('search', 'Sem voos', fmtNumber(stats.empty_journeys), 'Nenhuma oferta encontrada')}
      ${kpi('alert', 'Erros do fornecedor', fmtNumber(stats.errors), 'Fornecedor em baixo ou sem créditos', '', stats.errors ? 'warn' : '')}
    </div>
    <div class="admin-card"><div class="card-head"><div><h2>${hIcon('activity')} Feed ao vivo</h2><p>Cada linha é uma pesquisa de um cliente, com as datas de ida e de volta que comparou. Toca numa linha para ver cada consulta. Guardadas 7 dias.</p></div><span class="feed-count">${plural(journeys.length, 'pesquisa', 'pesquisas')}</span></div>
      <div class="journey-list" id="feed">${journeys.length ? journeys.map((j, index) => journeyRow(j, index, previous)).join('') : emptyState('search', 'Ainda não há pesquisas registadas.', 'Abre o site noutra janela e faz uma pesquisa: aparece aqui em segundos.')}</div></div>
    <div class="admin-grid even"><div class="admin-card"><h2>${hIcon('trend')} Rotas mais pesquisadas</h2><p>Últimos 7 dias, com o menor preço visto pelos clientes.</p>
        ${routes.length ? `<div class="rank-list">${routes.map(item => `<div class="rank"><div><strong>${esc(cityName(item.origin))} → ${esc(cityName(item.destination))}</strong><small>${plural(item.visitors, 'visitante', 'visitantes')}${item.min_price_brl != null ? ` · desde ${esc(priceText(item.min_price_brl))}` : ''}</small></div><b>${fmtNumber(item.n)}</b><span class="bar"><i style="width:${Math.max(6, Math.round((item.n / top) * 100))}%"></i></span></div>`).join('')}</div>` : '<p class="muted">Sem dados ainda.</p>'}</div>
      <div class="admin-card"><h2>${hIcon('calendar')} Pesquisas por dia</h2><p>Hora de Luanda.</p><div class="mini-bars">${days.map(day => `<div style="height:${Math.max(6, Math.round((day.n / peak) * 100))}px" title="${esc(formatDate(day.day))}: ${fmtNumber(day.n)}"><b>${fmtNumber(day.n)}</b><span>${esc(shortDay(day.day))}</span></div>`).join('') || '<p class="muted">Sem dados ainda.</p>'}</div></div></div>`;
  $('#feed').onclick = event => {
    const button = event.target.closest('.journey-main');
    if (!button) return;
    const article = button.closest('.journey');
    if (button.getAttribute('aria-expanded') === 'true') {
      button.setAttribute('aria-expanded', 'false');
      $('.journey-calls', article).hidden = true;
      feed.expanded.delete(article.dataset.key);
    } else {
      openCalls(article);
    }
  };
  for (const key of [...feed.expanded]) {
    const article = [...view().querySelectorAll('.journey')].find(element => element.dataset.key === key);
    if (article) openCalls(article);
    else feed.expanded.delete(key);
  }
}

// ── Bookings ─────────────────────────────────────────────────────────────────
// Total paid, and under it the profit entered by the team (or a reminder once the sale is paid).
const amountCell = row => {
  const profit = hasProfit(row) ? `<small>lucro ${formatKz(row.profit_aoa)}</small>` : PAID.includes(row.status) ? '<small class="profit-missing">lucro por inserir</small>' : '';
  return `<strong class="kz">${formatKz(row.amount_aoa)}</strong>${profit}`;
};

async function bookingsView(params, ctx) {
  const status = params.get('status') || '';
  const term = params.get('q') || '';
  const offset = Number(params.get('offset')) || 0;
  const limit = 25;
  setTitle('Compras', `<button class="btn-sm" id="refresh" type="button">${icon('refresh', 14)} Actualizar</button>`);
  $('#refresh').onclick = route;
  const query = new URLSearchParams({ limit, offset });
  if (status) query.set('status', status);
  if (term) query.set('q', term);
  const data = await api(`/api/admin/bookings?${query}`);
  if (stale(ctx)) return;
  const previous = ctx.silent ? knownRefs : null;
  knownRefs = new Set(data.rows.map(row => row.reference));
  const base = `bookings?${new URLSearchParams({ ...(status ? { status } : {}), ...(term ? { q: term } : {}) })}`;
  view().innerHTML = `<div class="toolbar"><form class="search-input" id="search">${icon('search', 16)}<input name="q" value="${esc(term)}" placeholder="Referência, telefone, nome ou e-mail" aria-label="Pesquisar compras"></form></div>
    <div class="chips spaced">${FILTERS.map(([key, label]) => `<a class="chip ${status === key ? 'selected' : ''}" href="#bookings${key ? `?status=${key}` : ''}">${label}</a>`).join('')}</div>
    ${table('<th>Referência</th><th>Cliente</th><th>Viagem</th><th class="num">Valor</th><th>Estado</th><th>Pagamento</th><th>Factura</th>', data.rows.map(row => `<tr class="clickable${previous && !previous.has(row.reference) ? ' new' : ''}" data-ref="${esc(row.reference)}">
      <td class="mono"><strong>${esc(row.reference)}</strong><small>${esc(formatDateTime(row.created_at))}</small></td>
      <td>${esc(row.contact_name)}<small>${esc(formatPhone(row.contact_phone))}</small></td>
      <td>${esc(city(row.origin))} ${row.trip_type === 'return' ? '⇄' : '→'} ${esc(city(row.destination))}<small>${esc(formatDate(row.departure_date))}${row.return_date ? ` — ${esc(formatDate(row.return_date))}` : ''} · ${plural(row.passengers_count, 'passageiro', 'passageiros')}</small></td>
      <td class="num">${amountCell(row)}</td>
      <td>${statusBadge(row.status)}${row.needs_review ? '<small class="flag" style="margin-top:6px">Rever</small>' : ''}${row.ticket_pnr ? `<small>PNR ${esc(row.ticket_pnr)}</small>` : ''}</td>
      <td>${esc(paymentMethodLabel(row))}<small>${row.imported ? 'registada à mão' : row.payment_method === 'manual' && !row.wiza_status ? 'combinar no WhatsApp' : `${esc(row.wiza_status || '')}${row.wiza_status_code ? ` · ${esc(row.wiza_status_code)}` : ''}`}</small></td>
      <td>${row.vero_invoice_number ? esc(row.vero_invoice_number) : row.vero_error ? '<span class="no-dot">Erro</span>' : '—'}<small>${esc(row.vero_agt_status || '')}</small></td></tr>`).join(''), 'Nenhuma compra encontrada.', 'bookings-table')}
    ${pager(data.total, offset, limit, base)}`;
  $('#search').onsubmit = event => {
    event.preventDefault();
    const value = $('#search [name=q]').value.trim();
    document.activeElement?.blur();
    location.hash = `#bookings?${new URLSearchParams({ ...(status ? { status } : {}), ...(value ? { q: value } : {}) })}`;
  };
  view().querySelectorAll('tr[data-ref]').forEach(row => {
    row.onclick = () => { location.hash = `#booking/${encodeURIComponent(row.dataset.ref)}`; };
  });
}

const EMAIL_PURPOSE = { payment_confirmed: 'Confirmação da compra ao cliente', invoice: 'Factura ao cliente', admin_paid: 'Aviso de compra à equipa' };
const asciiName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z' -]/g, '').trim();
const airlineFormat = p => `${asciiName(p.surname)}/${asciiName(p.given_names)} ${p.title}`;

function legDetail(leg, label) {
  if (!leg?.segments?.length) return '';
  return `<div class="leg-block"><h3 class="leg-title">${[label, esc(leg.airline), ...legFacts(leg)].join(' · ')}</h3>
    ${table('<th>Voo</th><th>De</th><th>Para</th><th>Duração</th>', leg.segments.map((segment, index) => `<tr><td class="mono"><strong>${esc(segment.number || '—')}</strong><small>${esc(segment.airline)}</small></td>
      <td>${esc(city(segment.from))}<small>${esc(segment.departure || '')}</small></td><td>${esc(city(segment.to))}<small>${esc(segment.arrival || '')}</small></td>
      <td>${segment.duration ? esc(duration(segment.duration)) : '—'}${leg.layovers?.[index] ? `<small>Conexão ${esc(duration(leg.layovers[index].duration))} em ${esc(leg.layovers[index].airport)}</small>` : ''}</td></tr>`).join(''), '')}</div>`;
}

async function bookingView(reference, ctx) {
  setTitle(`Reserva ${reference}`, `<a class="btn-sm" href="#bookings">${icon('arrowLeft', 14)} Compras</a><button class="btn-sm" id="refresh" type="button">${icon('refresh', 14)} Actualizar</button>`);
  $('#refresh').onclick = route;
  const data = await api(`/api/admin/bookings/${encodeURIComponent(reference)}`);
  if (stale(ctx)) return;
  renderBooking(data);
}

// Total paid by the customer and the profit the team entered for this sale.
function amountBox(b) {
  const profit = hasProfit(b) ? formatKz(b.profit_aoa) : PAID.includes(b.status) ? '<span class="profit-missing">Por inserir</span>' : '—';
  return `<div class="amount-box"><small>Total pago pelo cliente</small><strong>${formatKz(b.amount_aoa)}</strong><dl>
    <div><dt>Lucro DOT</dt><dd>${profit}</dd></div></dl></div>`;
}

// Times, stops and duration can be unknown in a sale registered by hand.
const legFacts = leg => [leg.stops == null ? '' : leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'Directo', leg.duration ? duration(leg.duration) : ''].filter(Boolean);

function renderBooking(data) {
  const b = data.booking;
  const itinerary = b.itinerary || {};
  const open = ['pending_payment', 'payment_failed', 'expired'].includes(b.status);
  const paid = ['paid', 'ticketed'].includes(b.status);
  const button = (action, glyph, label, extra = '') => `<button class="btn-sm ${extra}" type="button" data-action="${action}">${icon(glyph, 14)} ${label}</button>`;
  const actions = [
    b.wiza_payment_id && open ? button('recheck', 'refresh', 'Verificar pagamento') : '',
    open ? button('confirm_manual', 'checkCircle', 'Confirmar pagamento à mão') : '',
    paid ? button('ticket', 'ticket', b.status === 'ticketed' ? 'Editar bilhete' : 'Emitir bilhete', b.status === 'paid' ? 'primary-sm' : '') : '',
    paid ? button('profit', 'wallet', hasProfit(b) ? 'Editar lucro' : 'Inserir lucro', !hasProfit(b) && b.status === 'ticketed' ? 'primary-sm' : '') : '',
    paid ? button('invoice', 'receipt', b.vero_invoice_id ? 'Actualizar factura' : 'Emitir factura') : '',
    b.needs_review ? button('clear_review', 'check', 'Marcar como revisto') : '',
    button('note', 'file', 'Notas internas'),
    ['paid', 'ticketed', 'cancelled'].includes(b.status) ? button('refund', 'wallet', 'Marcar reembolsado') : '',
    !['cancelled', 'refunded'].includes(b.status) ? button('cancel', 'x', 'Cancelar reserva', 'danger') : '',
  ].join('');
  view().innerHTML = `<div class="admin-card"><div class="detail-head"><div><h2>${esc(b.reference)} ${statusBadge(b.status)} ${b.needs_review ? `<span class="flag">${icon('alert', 14)} Para rever</span>` : ''}${b.imported ? `<span class="flag">${icon('file', 14)} Venda fora do site</span>` : ''}</h2>
      <p>${b.imported ? 'Registada à mão em' : 'Criada em'} ${esc(formatDateTime(b.created_at))}${b.paid_at ? ` · paga em ${esc(formatDateTime(b.paid_at))}` : ''}${b.ticketed_at ? ` · emitida em ${esc(formatDateTime(b.ticketed_at))}` : ''}</p>
      <div class="action-bar" style="margin-top:16px">${actions}</div></div>
      ${amountBox(b)}</div></div>
    <div class="admin-grid"><div>
      <div class="admin-card"><h2>${hIcon('plane')} Itinerário</h2><p>${esc(city(b.origin))} ${b.trip_type === 'return' ? '⇄' : '→'} ${esc(city(b.destination))} · ${esc(formatDate(b.departure_date))}${b.return_date ? ` — ${esc(formatDate(b.return_date))}` : ''} · horários locais</p>
        ${legDetail(itinerary.outbound, 'Ida')}${legDetail(itinerary.inbound, 'Volta')}
        ${itinerary.inbound?.bookingToken || itinerary.outbound?.bookingToken ? '<p class="muted" style="margin-top:12px">O booking_token do Google Flights está guardado na reserva para consulta das opções de compra.</p>' : ''}</div>
      <div class="admin-card"><h2>${hIcon('idCard')} Passageiros</h2><p>Dados tal como no passaporte. Copia o nome no formato das companhias aéreas.</p>
        ${b.booking_passengers.map((p, index) => `<div class="passenger-line"><div class="kv">
          <div><small>Passageiro ${index + 1} · ${p.passenger_type === 'child' ? 'Criança' : 'Adulto'}</small><strong>${p.title === 'MR' ? 'Sr.' : 'Sra.'} ${esc(p.given_names)} ${esc(p.surname)}</strong></div>
          <div><small>Nascimento</small><strong>${esc(formatDate(p.birth_date) || '—')}</strong></div>
          <div><small>Nacionalidade</small><strong>${p.nationality ? esc(countryName(p.nationality)) : '—'}</strong></div>
          <div><small>Passaporte</small><strong class="mono">${esc(p.document_number || '—')}</strong></div>
          <div><small>País emissor</small><strong>${p.document_country ? esc(countryName(p.document_country)) : '—'}</strong></div>
          <div><small>Validade</small><strong>${esc(formatDate(p.document_expiry) || '—')}</strong></div></div>
          <button class="btn-sm" type="button" data-copy="${esc(airlineFormat(p))}" title="Copiar ${esc(airlineFormat(p))}">${icon('file', 14)} Copiar nome</button></div>`).join('')}</div>
      <div class="admin-card"><h2>${hIcon('activity')} Eventos do pagamento</h2><p>Criação, consultas à Wiza, callbacks e confirmações.</p>
        ${table('<th>Quando</th><th>Origem</th><th>Resultado</th><th>Detalhes</th>', data.events.map(event => `<tr><td>${esc(formatDateTime(event.created_at))}</td><td>${esc(event.source)}</td><td><strong>${esc(event.outcome || '')}</strong></td><td><div class="code-box">${esc(JSON.stringify(event.payload || {}, null, 1))}</div></td></tr>`).join(''), 'Sem eventos.')}</div>
    </div><div>
      <div class="admin-card"><h2>${hIcon('user')} Contacto</h2><div class="kv"><div><small>Nome</small><strong>${esc(b.contact_name)}</strong></div><div><small>Telemóvel</small><strong>${esc(formatPhone(b.contact_phone))}</strong></div><div><small>E-mail</small><strong>${esc(b.contact_email || '—')}</strong></div><div><small>Conta</small><strong>${esc(b.customer?.name || '—')}</strong></div></div></div>
      <div class="admin-card"><h2>${hIcon('wallet')} Pagamento · ${b.imported ? 'Fora do site' : b.payment_method === 'manual' ? 'Manual (WhatsApp)' : 'Wiza'}</h2>
        ${b.imported ? `<div class="notice" style="margin:0 0 12px">${icon('info', 18)}<div>Venda feita fora do site e registada à mão. O sistema não enviou SMS nem emite factura automática; podes emitir a factura com o botão <b>Emitir factura</b>.</div></div>` : ''}
        ${b.payment_method === 'manual' && open ? `<div class="notice" style="margin:0 0 12px">${icon('message', 18)}<div>O cliente escolheu <b>pagamento manual</b> e foi para o WhatsApp da DOT com a referência ${esc(b.reference)}. Depois de receberes o pagamento, usa <b>Confirmar pagamento à mão</b>: o cliente recebe o SMS e a factura é emitida.</div></div>` : ''}${b.imported ? `<div class="kv"><div><small>Método</small><strong>${esc(paymentMethodLabel(b))}</strong></div><div><small>Pago</small><strong>${esc(formatDateTime(b.paid_at) || '—')}</strong></div></div>` : `<div class="kv">
        <div><small>Estado</small><strong>${esc(b.wiza_status || '—')}${b.wiza_status_code ? ` · ${esc(b.wiza_status_code)}` : ''}</strong></div>
        <div><small>Método</small><strong>${esc(paymentMethodLabel(b))}</strong></div>
        <div><small>Tentativas</small><strong>${esc(b.payment_attempts)}</strong></div>
        <div><small>Referência enviada</small><strong class="mono">${esc(b.wiza_reference_id || '—')}</strong></div>
        <div><small>ID do pagamento</small><strong class="mono">${esc(b.wiza_payment_id || '—')}</strong></div>
        <div><small>Entidade / referência ATM</small><strong>${esc(b.wiza_atm_entity || '—')} / ${esc(b.wiza_atm_reference || '—')}</strong></div>
        <div><small>Última consulta</small><strong>${esc(formatDateTime(b.wiza_checked_at) || '—')}</strong></div>
        <div><small>Janela de 5 min</small><strong>${b.wiza_window_closed ? 'Fechada (só callback)' : 'Aberta'}</strong></div>
        ${b.wiza_paid_payment_id ? `<div><small>Cobrança paga</small><strong class="mono">${esc(b.wiza_paid_payment_id)}</strong></div>` : ''}
        ${b.wiza_previous_ids?.length ? `<div><small>Cobranças anteriores</small><strong class="mono">${b.wiza_previous_ids.map(esc).join('<br>')}</strong></div>` : ''}</div>`}
        ${b.needs_review ? `<div class="notice" style="margin-top:12px">${icon('alert', 18)}<div>Há um aviso da Wiza que não foi possível confirmar automaticamente (ou um possível pagamento em duplicado). Confirma no painel da Wiza e vê os eventos.</div></div>` : ''}</div>
      <div class="admin-card"><h2>${hIcon('receipt')} Factura · Vero</h2><div class="kv">
        <div><small>Número</small><strong>${esc(b.vero_invoice_number || '—')}</strong></div>
        <div><small>Estado AGT</small><strong>${esc(b.vero_agt_status || (b.vero_invoice_id ? (data.invoicesSandbox ? 'teste (não chega à AGT)' : 'pendente') : '—'))}</strong></div>
        <div><small>Cliente fiscal</small><strong>${b.invoice_nif ? `${esc(b.invoice_name)} · NIF ${esc(b.invoice_nif)}` : 'Consumidor Final'}</strong></div>
        ${b.vero_pdf_url && !data.invoicesSandbox ? `<div><small>Documento</small><strong><a class="link-btn" href="${esc(b.vero_pdf_url)}" target="_blank" rel="noopener">${icon('download', 14)} PDF</a></strong></div>` : ''}</div>
        ${b.vero_error ? `<div class="notice error" style="margin-top:12px">${icon('alert', 18)}<div>Último erro: <span class="mono">${esc(b.vero_error)}</span>. A venda mantém-se; podes reemitir.</div></div>` : ''}</div>
      <div class="admin-card"><h2>${hIcon('ticket')} Bilhete</h2>${b.ticket_pnr ? `<div class="kv"><div><small>PNR</small><strong class="mono">${esc(b.ticket_pnr)}</strong></div><div><small>Números do bilhete</small><strong>${esc(b.ticket_numbers || '—')}</strong></div>${b.ticket_notes ? `<div><small>Notas para o cliente</small><strong>${esc(b.ticket_notes)}</strong></div>` : ''}</div>` : `<p class="card-sub">${b.status === 'ticketed' ? 'Bilhete emitido sem código da reserva registado. Usa Editar bilhete para o registar (podes não enviar SMS).' : paid ? 'Compra paga. Emite o bilhete na companhia ou no consolidador e regista aqui o PNR para o cliente receber o SMS.' : 'O bilhete só é emitido depois do pagamento.'}</p>`}
        ${b.cancel_reason ? `<div class="notice" style="margin-top:12px">${icon('info', 18)}<div>Cancelada: ${esc(b.cancel_reason)}</div></div>` : ''}</div>
      <div class="admin-card"><h2>${hIcon('message')} SMS desta reserva</h2>${table('<th>Quando</th><th>Mensagem</th><th>Estado</th>', data.sms.map(sms => `<tr><td>${esc(formatDateTime(sms.created_at))}</td><td>${esc(SMS_PURPOSE[sms.purpose] || sms.purpose || sms.category)}<small>remetente ${esc(sms.sender || '—')}</small></td><td>${esc(SMS_STATUS[sms.status] || sms.status || '—')}${sms.error ? `<small>${esc(sms.error)}</small>` : ''}</td></tr>`).join(''), 'Nenhum SMS enviado.')}</div>
      <div class="admin-card"><h2>${hIcon('message')} E-mails desta reserva</h2>${table('<th>Quando</th><th>Mensagem</th><th>Estado</th>', (data.emails || []).map(mail => `<tr><td>${esc(formatDateTime(mail.created_at))}</td><td>${esc(EMAIL_PURPOSE[mail.purpose] || mail.purpose || '—')}<small>${esc(mail.to_address)}${mail.with_invoice ? ' · com factura' : ''}</small></td><td>${mail.status === 'sent' ? 'Enviado' : 'Falhou'}${mail.error ? `<small>${esc(mail.error)}</small>` : ''}</td></tr>`).join(''), 'Nenhum e-mail enviado.')}</div>
      <div class="admin-card"><h2>${hIcon('file')} Notas internas</h2><p class="card-sub" style="white-space:pre-wrap">${esc(b.admin_notes || 'Sem notas.')}</p></div>
      <div class="admin-card"><h2>${hIcon('list')} Auditoria</h2>${table('<th>Quando</th><th>Quem</th><th>Acção</th>', data.audit.map(row => `<tr><td>${esc(formatDateTime(row.created_at))}</td><td>${esc(row.admin?.name || '—')}</td><td>${esc(AUDIT[row.action] || row.action)}</td></tr>`).join(''), 'Sem alterações registadas.')}</div>
    </div></div>`;

  view().querySelectorAll('[data-copy]').forEach(element => {
    element.onclick = async () => {
      await navigator.clipboard?.writeText(element.dataset.copy).catch(() => {});
      toast(`Copiado: ${element.dataset.copy}`);
    };
  });
  const send = async payload => {
    const result = await api(`/api/admin/bookings/${encodeURIComponent(b.reference)}/action`, { method: 'POST', body: payload, timeout: 60000 });
    renderBooking(result);
    if (result.smsError) toast(`Guardado, mas o SMS falhou: ${result.smsError}`, 'error');
    else if (result.invoiceError) toast(result.invoiceError, 'error');
    else toast('Reserva actualizada.');
    return result;
  };
  view().querySelectorAll('[data-action]').forEach(element => {
    element.onclick = async () => {
      const action = element.dataset.action;
      if (['recheck', 'invoice', 'clear_review'].includes(action)) {
        element.disabled = true;
        try {
          await send({ action });
        } catch (error) {
          toast(error.message, 'error');
          element.disabled = false;
        }
        return;
      }
      const forms = {
        confirm_manual: {
          title: 'Confirmar pagamento à mão',
          text: b.payment_method === 'manual'
            ? 'Pagamento manual combinado no WhatsApp. Usa depois de confirmares que o valor entrou na conta da DOT. O cliente recebe o SMS de pagamento e a factura é emitida.'
            : 'Usa apenas depois de confirmares o pagamento no painel da Wiza (por exemplo, uma referência paga cujo callback não foi validado). O cliente recebe o SMS de pagamento e a factura é emitida.',
          fields: `<label class="form-field"><span>Justificação</span><textarea name="note" required maxlength="300" placeholder="${b.payment_method === 'manual' ? 'Ex.: transferência recebida às 14:32, comprovativo no WhatsApp' : 'Ex.: pagamento confirmado no painel da Wiza às 14:32'}"></textarea></label>`,
          confirm: 'Confirmar pagamento',
          body: form => ({ action, note: form.get('note') }),
        },
        ticket: {
          title: b.status === 'ticketed' ? 'Editar bilhete' : 'Emitir bilhete',
          text: 'Regista o código da reserva da companhia (PNR) e os números dos bilhetes. O cliente recebe um SMS e vê os dados em Minhas viagens.',
          fields: `<label class="form-field"><span>Código da reserva (PNR)</span><input name="pnr" required maxlength="8" value="${esc(b.ticket_pnr || '')}" style="text-transform:uppercase"></label>
            <label class="form-field"><span>Números dos bilhetes <small>(um por passageiro)</small></span><input name="ticketNumbers" maxlength="300" value="${esc(b.ticket_numbers || '')}" placeholder="Ex.: 118-1234567890, 118-1234567891"></label>
            <label class="form-field"><span>Notas para o cliente <small>(opcional)</small></span><textarea name="notes" maxlength="500">${esc(b.ticket_notes || '')}</textarea></label>
            <label class="check-row"><input type="checkbox" name="notify" checked><span>Enviar SMS ao cliente (só quando o PNR é novo)</span></label>`,
          confirm: 'Guardar bilhete',
          body: form => ({ action, pnr: form.get('pnr'), ticketNumbers: form.get('ticketNumbers'), notes: form.get('notes'), notify: form.get('notify') === 'on' }),
        },
        cancel: {
          title: 'Cancelar reserva',
          text: paid ? 'A reserva já foi paga: regista o reembolso depois de o fazer.' : 'A reserva deixa de aceitar pagamentos.',
          fields: `<label class="form-field"><span>Motivo</span><textarea name="reason" required maxlength="300"></textarea></label>${paid ? '<label class="check-row"><input type="checkbox" name="notify" checked><span>Avisar o cliente por SMS</span></label>' : ''}`,
          confirm: 'Cancelar reserva',
          body: form => ({ action, reason: form.get('reason'), notify: form.get('notify') === 'on' }),
        },
        refund: {
          title: 'Marcar como reembolsado',
          text: 'O reembolso é feito fora do sistema. Regista como foi feito.',
          fields: '<label class="form-field"><span>Como foi reembolsado</span><textarea name="note" required maxlength="300" placeholder="Ex.: transferência IBAN em 12/11, comprovativo 4581"></textarea></label>',
          confirm: 'Registar reembolso',
          body: form => ({ action, note: form.get('note') }),
        },
        profit: {
          title: hasProfit(b) ? 'Editar lucro' : 'Inserir lucro',
          text: `Quanto a DOT ganhou nesta venda: o total pago pelo cliente (${formatKz(b.amount_aoa)}) menos o custo do bilhete. Este valor conta como lucro no painel.`,
          fields: `<label class="form-field"><span>Lucro em kwanzas</span><input name="profit" inputmode="numeric" autocomplete="off" required maxlength="16" placeholder="Ex.: 270 000" value="${hasProfit(b) ? esc(fmtNumber(b.profit_aoa)) : ''}"></label>`,
          confirm: 'Guardar lucro',
          body: form => ({ action, profitAoa: String(form.get('profit') || '') }),
        },
        note: {
          title: 'Notas internas',
          text: 'Visíveis apenas para a equipa.',
          fields: `<label class="form-field"><span>Notas</span><textarea name="text" maxlength="4000" style="min-height:160px">${esc(b.admin_notes || '')}</textarea></label>`,
          confirm: 'Guardar notas',
          body: form => ({ action, text: form.get('text') }),
        },
      };
      const spec = forms[action];
      if (!spec) return;
      ask({ title: spec.title, text: esc(spec.text), fields: spec.fields, confirm: spec.confirm, onSubmit: form => send(spec.body(form)) });
    };
  });
}

// ── Customers ────────────────────────────────────────────────────────────────
async function customersView(params, ctx) {
  const term = params.get('q') || '';
  const role = params.get('role') || '';
  const offset = Number(params.get('offset')) || 0;
  const limit = 25;
  setTitle('Utilizadores');
  const query = new URLSearchParams({ limit, offset });
  if (term) query.set('q', term);
  if (role) query.set('role', role);
  const data = await api(`/api/admin/customers?${query}`);
  if (stale(ctx)) return;
  const base = `customers?${new URLSearchParams({ ...(term ? { q: term } : {}), ...(role ? { role } : {}) })}`;
  view().innerHTML = `<div class="toolbar"><form class="search-input" id="search">${icon('search', 16)}<input name="q" value="${esc(term)}" placeholder="Telefone, nome ou e-mail" aria-label="Pesquisar utilizadores"></form>
      <div class="chips"><a class="chip ${role ? '' : 'selected'}" href="#customers">Todos</a><a class="chip ${role === 'admin' ? 'selected' : ''}" href="#customers?role=admin">Administradores</a></div></div>
    ${table('<th>Nome</th><th>Telemóvel</th><th>E-mail</th><th>Papel</th><th class="num">Compras</th><th>Registo</th><th>Último acesso</th><th></th>', data.rows.map(row => `<tr>
      <td><strong>${esc(row.name || '—')}</strong>${row.blocked ? '<small class="no-dot">Bloqueado</small>' : ''}</td><td>${esc(formatPhone(row.phone))}</td><td>${esc(row.email || '—')}</td>
      <td>${row.role === 'admin' ? '<span class="badge ticketed">Admin</span>' : 'Cliente'}</td><td class="num">${fmtNumber(row.bookings?.[0]?.count)}</td>
      <td>${esc(formatDateTime(row.created_at))}</td><td>${esc(formatDateTime(row.last_login_at) || '—')}</td>
      <td><div class="action-bar">${row.bookings?.[0]?.count ? `<a class="btn-sm" href="#bookings?q=${encodeURIComponent(row.phone)}">${icon('ticket', 14)} Compras</a>` : ''}
        <button class="btn-sm" type="button" data-id="${esc(row.id)}" data-role="${row.role === 'admin' ? 'customer' : 'admin'}">${row.role === 'admin' ? 'Retirar admin' : 'Tornar admin'}</button>
        <button class="btn-sm ${row.blocked ? '' : 'danger'}" type="button" data-id="${esc(row.id)}" data-blocked="${row.blocked ? 'false' : 'true'}">${row.blocked ? 'Desbloquear' : 'Bloquear'}</button></div></td></tr>`).join(''), 'Nenhum utilizador encontrado.')}
    ${pager(data.total, offset, limit, base)}`;
  $('#search').onsubmit = event => {
    event.preventDefault();
    const value = $('#search [name=q]').value.trim();
    document.activeElement?.blur();
    location.hash = `#customers?${new URLSearchParams({ ...(value ? { q: value } : {}), ...(role ? { role } : {}) })}`;
  };
  view().querySelectorAll('[data-id]').forEach(element => {
    element.onclick = () => {
      const payload = element.dataset.role ? { role: element.dataset.role } : { blocked: element.dataset.blocked === 'true' };
      const text = payload.role === 'admin' ? 'Este número passa a entrar no painel com controlo total.'
        : payload.role === 'customer' ? 'Este número deixa de entrar no painel.'
          : payload.blocked ? 'O utilizador perde o acesso e as sessões abertas terminam.' : 'O utilizador volta a poder entrar.';
      ask({
        title: element.textContent.trim(),
        text: esc(text),
        confirm: 'Confirmar',
        onSubmit: async () => {
          await api(`/api/admin/customers/${element.dataset.id}`, { method: 'POST', body: payload });
          toast('Utilizador actualizado.');
          route();
        },
      });
    };
  });
}

// ── Price alerts ─────────────────────────────────────────────────────────────
const alertBadge = status => {
  const [label, tone] = ALERT_STATUS[status] || [status, ''];
  return `<span class="badge ${esc(tone)}">${esc(label)}</span>`;
};
const yymmdd = iso => String(iso || '').slice(2, 10).replace(/-/g, '');
// Same short link as the SMS: /resultados?v=NBJLIS2612182612281.
const alertLink = row => `/resultados?v=${row.origin}${row.destination}${yymmdd(row.departure_date)}${row.return_date ? yymmdd(row.return_date) : ''}${row.passengers}`;

function alertRow(row, today) {
  const who = row.customer
    ? `<strong>${esc(row.customer.name || 'Cliente')}</strong><small>${esc(formatPhone(row.customer.phone))}</small>`
    : '—';
  const drop = Number(row.baseline_kz) - Number(row.lowest_price_kz ?? row.baseline_kz);
  const last = row.checks
    ? `<strong>${formatKz(row.last_price_kz)}</strong><small>${plural(row.checks, 'pesquisa', 'pesquisas')} · <span data-ago="${esc(row.last_seen_at)}">${esc(ago(row.last_seen_at))}</span></small>${drop > 0 ? `<small>mínimo ${formatKz(row.lowest_price_kz)} (−${formatKz(drop)})</small>` : ''}`
    : '<span class="muted">Sem pesquisas novas</span>';
  const sent = [
    row.first_alert_kz ? `1.º ${formatKz(row.first_alert_kz)} · ${formatDateTime(row.first_alert_at)}` : '',
    row.second_alert_kz ? `2.º ${formatKz(row.second_alert_kz)} · ${formatDateTime(row.second_alert_at)}` : '',
  ].filter(Boolean);
  const action = row.status === 'active'
    ? `<button class="btn-sm danger" type="button" data-alert="${esc(row.id)}" data-action="cancel">Desactivar</button>`
    : row.status === 'cancelled' && String(row.departure_date) >= today
      ? `<button class="btn-sm" type="button" data-alert="${esc(row.id)}" data-action="reactivate">Reactivar</button>`
      : '';
  return `<tr><td>${who}</td>
    <td><strong>${esc(cityName(row.origin))} → ${esc(cityName(row.destination))}</strong><small>${esc(row.origin)} · ${esc(row.destination)} · ${plural(row.passengers, 'adulto', 'adultos')}</small></td>
    <td>${esc(shortDay(row.departure_date))}${row.return_date ? ` — ${esc(shortDay(row.return_date))}` : '<small>só ida</small>'}</td>
    <td class="num"><strong>${formatKz(row.baseline_kz)}</strong><small data-ago="${esc(row.created_at)}">${esc(ago(row.created_at))}</small></td>
    <td class="num">${last}</td>
    <td><strong>${fmtNumber(row.alerts_sent)} de 2</strong>${sent.map(text => `<small>${esc(text)}</small>`).join('')}</td>
    <td>${alertBadge(row.status)}</td>
    <td><div class="action-bar"><a class="btn-sm" href="${esc(alertLink(row))}" target="_blank" rel="noopener">${icon('external', 14)} Voos</a>${action}</div></td></tr>`;
}

async function alertsView(params, ctx) {
  const status = params.get('status') || '';
  const offset = Number(params.get('offset')) || 0;
  const limit = 30;
  setTitle('Avisos de preço');
  const query = new URLSearchParams({ limit, offset });
  if (status) query.set('status', status);
  const data = await api(`/api/admin/alerts?${query}`);
  if (stale(ctx)) return;
  const stats = data.stats || {};
  const rules = data.rules || {};
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' }).format(new Date());
  view().innerHTML = `<div class="kpi-grid">
      ${kpi('bell', 'Avisos activos', stats.active == null ? '—' : fmtNumber(stats.active), 'À espera de uma descida de preço', '#alerts?status=active', stats.active ? 'good' : '')}
      ${kpi('message', 'Com SMS enviado', stats.notified == null ? '—' : fmtNumber(stats.notified), 'Receberam pelo menos 1 aviso', '#alerts?status=notified')}
      ${kpi('checkCircle', 'Concluídos', stats.done == null ? '—' : fmtNumber(stats.done), 'Já receberam os 2 avisos', '#alerts?status=done')}</div>
    <div class="chips spaced">${ALERT_FILTERS.map(([key, label]) => `<a class="chip ${status === key ? 'selected' : ''}" href="#alerts${key ? `?status=${key}` : ''}">${esc(label)}</a>`).join('')}</div>
    ${table('<th>Cliente</th><th>Viagem</th><th>Datas</th><th class="num">Preço visto</th><th class="num">Último preço</th><th>SMS</th><th>Estado</th><th></th>', data.rows.map(row => alertRow(row, today)).join(''), status ? 'Nenhum aviso neste estado.' : 'Ainda não há avisos de preço.')}
    ${pager(data.total, offset, limit, `alerts${status ? `?status=${status}` : ''}`)}
    <div class="admin-card"><h2>${hIcon('trendDown')} Como funcionam</h2><p>Nos resultados, o cliente indica o nome e confirma o telemóvel com um código por SMS (fica nos Utilizadores). O preço é seguido com as pesquisas que outros visitantes fazem para a mesma viagem (rota, datas e adultos), sem pesquisas extra ao fornecedor.</p>
      <ol class="formula">
        <li><b>1.º SMS</b><span>Quando o preço baixa mais de ${formatKz(rules.firstDropKz ?? 50000)} face ao preço que o cliente viu.</span></li>
        <li><b>2.º SMS, o último</b><span>Quando baixa pelo menos mais ${formatKz(rules.secondDropKz ?? 100000)} face ao preço do 1.º SMS.</span></li>
        <li><b>Fim do aviso</b><span>Depois do 2.º SMS ou quando a data da viagem passa.</span></li></ol></div>`;
  view().querySelectorAll('[data-alert]').forEach(element => {
    element.onclick = () => {
      const cancel = element.dataset.action === 'cancel';
      ask({
        title: cancel ? 'Desactivar este aviso?' : 'Reactivar este aviso?',
        text: esc(cancel ? 'O cliente deixa de receber SMS sobre esta viagem.' : 'O aviso volta a seguir o preço desta viagem.'),
        confirm: cancel ? 'Desactivar' : 'Reactivar',
        onSubmit: async () => {
          await api(`/api/admin/alerts/${element.dataset.alert}`, { method: 'POST', body: { action: element.dataset.action } });
          toast(cancel ? 'Aviso desactivado.' : 'Aviso reactivado.');
          route();
        },
      });
    };
  });
}

// ── SMS ──────────────────────────────────────────────────────────────────────
async function smsView(params, ctx) {
  const category = params.get('category') || '';
  const offset = Number(params.get('offset')) || 0;
  const limit = 30;
  setTitle('SMS', `<button class="btn-sm" id="refresh" type="button">${icon('refresh', 14)} Actualizar</button>`);
  $('#refresh').onclick = route;
  const query = new URLSearchParams({ limit, offset });
  if (category) query.set('category', category);
  const data = await api(`/api/admin/sms?${query}`);
  if (stale(ctx)) return;
  view().innerHTML = `<div class="kpi-grid">${kpi('message', 'Saldo Nsangu', data.balance ? fmtNumber(data.balance.availableSms) : '—', data.balance ? `${fmtNumber(data.balance.reservedSms)} reservados` : 'Chave por configurar')}
      ${kpi('info', 'Rede Movicel', '46554', 'Remetente numérico usado por agora')}</div>
    <div class="chips spaced"><a class="chip ${category ? '' : 'selected'}" href="#sms">Todas</a><a class="chip ${category === 'OTP' ? 'selected' : ''}" href="#sms?category=OTP">Códigos (OTP)</a><a class="chip ${category === 'TRANSACTIONAL' ? 'selected' : ''}" href="#sms?category=TRANSACTIONAL">Avisos</a></div>
    ${table('<th>Quando</th><th>Telemóvel</th><th>Tipo</th><th>Estado</th><th>Remetente</th><th>Reserva</th><th></th>', data.rows.map(row => `<tr data-row="${esc(row.id)}">
      <td>${esc(formatDateTime(row.created_at))}</td><td>${esc(formatPhone(row.phone))}</td>
      <td>${esc(SMS_PURPOSE[row.purpose] || row.purpose || '—')}<small>${esc(row.category)} · ${esc(row.segments ?? '—')} SMS</small></td>
      <td>${esc(SMS_STATUS[row.status] || row.status || '—')}${row.failure_code || row.error ? `<small>${esc(row.failure_code || row.error)}</small>` : ''}</td>
      <td>${esc(row.sender || '—')}</td><td>${row.booking?.reference ? `<a class="link-btn" href="#booking/${encodeURIComponent(row.booking.reference)}">${esc(row.booking.reference)}</a>` : '—'}</td>
      <td>${row.provider_id ? `<button class="btn-sm" type="button" data-refresh="${esc(row.id)}">${icon('refresh', 14)} Estado</button>` : ''}</td></tr>`).join(''), 'Nenhum SMS enviado ainda.')}
    ${pager(data.total, offset, limit, `sms${category ? `?category=${category}` : ''}`)}`;
  view().querySelectorAll('[data-refresh]').forEach(element => {
    element.onclick = async () => {
      element.disabled = true;
      try {
        const { sms } = await api(`/api/admin/sms/${element.dataset.refresh}/refresh`, { method: 'POST', body: {} });
        toast(`Estado: ${SMS_STATUS[sms.status] || sms.status}`);
        route();
      } catch (error) {
        toast(error.message, 'error');
        element.disabled = false;
      }
    };
  });
}

// ── Audit ────────────────────────────────────────────────────────────────────
async function auditView(params, ctx) {
  const offset = Number(params.get('offset')) || 0;
  const limit = 40;
  setTitle('Auditoria');
  const data = await api(`/api/admin/audit?limit=${limit}&offset=${offset}`);
  if (stale(ctx)) return;
  view().innerHTML = `<div class="admin-card"><h2>${hIcon('list')} Alterações feitas no painel</h2><p>Câmbios, bilhetes, reembolsos, acessos e verificações, com o autor.</p>
    ${table('<th>Quando</th><th>Quem</th><th>Acção</th><th>Alvo</th><th>Detalhes</th>', data.rows.map(row => `<tr><td>${esc(formatDateTime(row.created_at))}</td>
      <td>${esc(row.admin?.name || '—')}<small>${esc(formatPhone(row.admin?.phone))}</small></td><td>${esc(AUDIT[row.action] || row.action)}</td>
      <td class="mono">${row.target && /^DOT-/.test(row.target) ? `<a class="link-btn" href="#booking/${encodeURIComponent(row.target)}">${esc(row.target)}</a>` : esc(row.target || '—')}</td>
      <td>${row.details ? `<div class="code-box">${esc(JSON.stringify(row.details, null, 1))}</div>` : ''}</td></tr>`).join(''), 'Ainda não há alterações registadas.')}
    ${pager(data.total, offset, limit, 'audit')}</div>`;
}

// ── System ───────────────────────────────────────────────────────────────────
async function systemView(params, ctx) {
  setTitle('Sistema');
  const data = await api('/api/admin/overview');
  if (stale(ctx)) return;
  markupBp = data.pricing?.markupBp ?? markupBp;
  const env = data.integrations;
  searchProvider = env?.searchProvider || searchProvider;
  const row = (ok, name, variables, note) => `<tr><td><strong>${esc(name)}</strong><small>${esc(note)}</small></td><td class="mono">${esc(variables)}</td><td><span class="${ok ? 'ok-dot' : 'no-dot'}">${ok ? 'Configurado' : 'Em falta'}</span></td></tr>`;
  view().innerHTML = `<div class="admin-grid"><div class="admin-card"><h2>${hIcon('settings')} Configuração do Worker</h2><p>Os segredos vivem só no ambiente do servidor (em desenvolvimento, no ficheiro .dev.vars). Este painel nunca os mostra.</p>
      ${table('<th>Serviço</th><th>Variáveis</th><th>Estado</th>', [
        row(env.supabase, 'Supabase', 'SUPABASE_URL, SUPABASE_SECRET_KEY', 'Base de dados de clientes, compras e pesquisas'),
        row(env.search, env.searchProvider || 'SerpApi', env.searchProvider === 'SearchApi' ? 'SEARCHAPI_KEY' : 'SERPAPI_KEY', env.searchProvider === 'SearchApi' ? 'Pesquisa de voos e calendário de preços (Google Flights). FLIGHTS_PROVIDER=serpapi volta à SerpApi' : 'Pesquisa de voos e calendário de preços (Google Flights)'),
        row(env.sms, 'Nsangu', 'NSANGU_API_KEY', 'SMS de códigos e avisos'),
        row(env.email, 'Resend', 'RESEND_API_KEY (RESEND_FROM, ADMIN_EMAIL opcionais)', 'E-mail da compra ao cliente (com a factura) e à equipa'),
        row(env.payments, 'Wiza', 'WIPAY_CLIENT_ID, WIPAY_CLIENT_SECRET, WIPAY_WEBHOOK_SECRET', 'Multicaixa Express e referência'),
        row(env.invoices, 'Vero', 'VERO_API_KEY, VERO_ORG_ID', env.invoicesSandbox ? 'Chave de teste: as facturas não chegam à AGT' : 'Factura-recibo certificada'),
        row(env.auth, 'Sessões e OTP', 'AUTH_SECRET', 'Assina códigos e sessões'),
        row(env.offerSigning, 'Preços assinados', 'OFFER_SECRET', 'Impede alterar preços entre pesquisa e pagamento'),
        row(env.cron, 'Verificação automática', 'CRON_SECRET', 'Protege /api/internal/sweep'),
        row(Boolean(env.publicBaseUrl), 'Endereço público', 'PUBLIC_BASE_URL', env.publicBaseUrl || 'Usado nos callbacks da Wiza; sem ele usa-se o endereço do pedido'),
        row(env.bootstrapAdmins > 0, 'Administradores iniciais', 'ADMIN_PHONES', `${env.bootstrapAdmins} número(s) com acesso garantido`),
      ].join(''), '')}</div>
    <div>${pauseNotice(Date.parse(data.provider?.pausedUntil || '') || 0)}<div class="admin-card"><h2>${hIcon('coins')} Preço ao cliente</h2><p>Câmbio do dia mais a taxa DOT de <b>${pct(markupBp)}</b> sobre o valor convertido. A taxa muda-se no painel, em Câmbio e preço (de 0% a ${MAX_MARKUP_PERCENT}%), e nunca aparece à parte para o cliente.</p><a class="btn-sm" href="#rates">${icon('coins', 14)} Câmbio e taxa DOT</a></div>
      ${env.search ? serpCard(data.serp) : ''}
      <div class="admin-card"><h2>${hIcon('refresh')} Verificar pagamentos agora</h2><p>Consulta na Wiza as cobranças dos últimos 7 minutos e tenta reemitir facturas em falta. Corre também quando o cliente está na página de pagamento e quando chega um callback.</p>
      <button class="primary" type="button" id="sweep">${icon('refresh', 16)} Verificar agora</button></div>
      <div class="admin-card"><h2>${hIcon('clock')} Tarefas automáticas (pg_cron)</h2><div class="status-list">
        <div><span><strong>Limpeza de pesquisas</strong><small>Apaga pesquisas com mais de 7 dias, de hora a hora</small></span><span class="ok-dot">Supabase</span></div>
        <div><span><strong>Códigos e sessões</strong><small>Remove OTP antigos e sessões terminadas</small></span><span class="ok-dot">Supabase</span></div>
        <div><span><strong>Reservas por pagar</strong><small>Passam a expiradas após 72 horas</small></span><span class="ok-dot">Supabase</span></div>
        <div><span><strong>Pesquisas partilhadas</strong><small>Apaga de hora a hora as pesquisas guardadas que já expiraram (valem 25 minutos)</small></span><span class="ok-dot">Supabase</span></div>
        <div><span><strong>Avisos de preço</strong><small>Terminam quando a data da viagem passa</small></span><span class="ok-dot">Supabase</span></div></div></div></div></div>`;
  bindResume();
  $('#sweep').onclick = async () => {
    const button = $('#sweep');
    button.disabled = true;
    try {
      const result = await api('/api/admin/sweep', { method: 'POST', body: {}, timeout: 60000 });
      toast(`${plural(result.checked, 'pagamento verificado', 'pagamentos verificados')}, ${plural(result.confirmed, 'confirmado', 'confirmados')}.`);
    } catch (error) {
      toast(error.message, 'error');
    }
    button.disabled = false;
  };
}

// ── Start ────────────────────────────────────────────────────────────────────
const airportsReady = loadAirports().then(list => {
  cities = Object.fromEntries(list.map(airport => [airport.code, airport.city]));
  cities.CMN = 'Casablanca';
}).catch(() => {});

await Promise.race([airportsReady, new Promise(resolve => setTimeout(resolve, 4000))]);
me = await auth.me();
if (me?.role === 'admin') shell();
else loginScreen(me ? 'Esta conta não tem acesso de administrador. Entra com um número autorizado.' : '');
