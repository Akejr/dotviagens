// Purchase by AI: header button, floating button on the left (with a teaser once per visit) and the
// chat panel. The server (server/ai.mjs) talks with the model and returns text plus cards (flights,
// dates, final price, payment). Only shown when /api/ai/status says it is on.
import { api, esc, formatKz } from './api.js';
import { icon } from './icons.js';
import { airlineMark } from './itinerary-ui.js';
import { bookingLink, whatsappLink } from './whatsapp.js';

const STORE = 'dot-ai-chat';
const TEASER = 'dot-ai-teaser';
const GREETING = 'Olá! Sou a assistente da DOT Viagens. Diz-me para onde queres viajar, as datas e quantas pessoas vão, e eu procuro os melhores voos para ti.';
const WAITING = ['A pensar…', 'A procurar voos…', 'A comparar preços…', 'Quase pronto…'];
const clock = value => String(value || '').slice(11, 16);
const shortDate = new Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
const fullDate = value => String(value || '').slice(0, 10).split('-').reverse().join('/');
const dayLabel = iso => shortDate.format(new Date(`${iso}T12:00:00Z`)).replace('.', '');
const durationText = minutes => `${Math.floor((minutes || 0) / 60)}h ${String((minutes || 0) % 60).padStart(2, '0')}min`;
const stopsText = n => (n ? `${n} ${n === 1 ? 'escala' : 'escalas'}` : 'Directo');

function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && Array.isArray(saved.items)) return saved;
  } catch {
    /* empty */
  }
  return { token: null, items: [] };
}
let chat = load();
const save = () => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ token: chat.token, items: chat.items.slice(-60) }));
  } catch {
    /* full or blocked */
  }
};

// Text from the model: escaped, **bold** and line breaks.
const richText = text => esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

function flightsCard(card) {
  return `<div class="ai-card"><p class="ai-card-title">${esc(card.title || 'Voos')}</p>${card.items.map(f => `
    <div class="ai-flight">
      <div class="ai-flight-air">${airlineMark({ airline: f.airline, segments: (f.logos || []).map(l => ({ airline: l.name, logo: l.logo })) })}<span>${esc(f.airline)}</span></div>
      <div class="ai-flight-times"><strong>${esc(clock(f.departure))}</strong> ${esc(f.from)} <span class="ai-arrow">${icon('arrowRight', 14)}</span> <strong>${esc(clock(f.arrival))}${f.plusDays ? `<sup>+${f.plusDays}</sup>` : ''}</strong> ${esc(f.to)}</div>
      <div class="ai-flight-meta">${esc(fullDate(f.departure))} · ${esc(stopsText(f.stops))} · ${esc(durationText(f.duration))}</div>
      <div class="ai-flight-foot"><strong>${esc(formatKz(f.priceKz))}</strong><button type="button" class="ai-pick" data-say="Quero o voo ${esc(f.ref)}">Escolher <span>${esc(f.ref)}</span></button></div>
    </div>`).join('')}</div>`;
}

function datesCard(card) {
  return `<div class="ai-card"><p class="ai-card-title">${esc(card.title || 'Preços indicativos')}</p><div class="ai-dates">${card.items.map(d => {
    const chosen = d.date === card.chosen;
    const cheapest = d.date === card.cheapest && !chosen;
    const label = `<span>${esc(dayLabel(d.date))}</span><strong>${d.priceKz ? esc(formatKz(d.priceKz)) : 'sem preço'}</strong>${cheapest ? '<em>Mais barato</em>' : chosen ? '<em>Pedido</em>' : ''}`;
    return chosen || !d.priceKz
      ? `<div class="ai-day${chosen ? ' chosen' : ''}">${label}</div>`
      : `<button type="button" class="ai-day${cheapest ? ' cheapest' : ''}" data-say="Quero ver os voos do dia ${esc(fullDate(d.date))}">${label}</button>`;
  }).join('')}</div><p class="ai-note">Preços por pessoa e indicativos. O preço exacto aparece na pesquisa do dia.</p></div>`;
}

function legLine(leg, label) {
  const first = leg?.segments?.[0];
  const last = leg?.segments?.at(-1);
  if (!first || !last) return '';
  return `<div class="ai-quote-leg"><span>${label}</span><div><strong>${esc(first.from)} ${icon('arrowRight', 13)} ${esc(last.to)}</strong><small>${esc(fullDate(first.departure))} · ${esc(clock(first.departure))} a ${esc(clock(last.arrival))} · ${esc(leg.airline || first.airline || '')}</small></div></div>`;
}

function quoteCard(card) {
  return `<div class="ai-card ai-quote">${legLine(card.outbound, 'Ida')}${card.inbound ? legLine(card.inbound, 'Volta') : ''}
    <div class="ai-total"><span>Total final</span><strong>${esc(formatKz(card.amountKz))}</strong></div>
    <p class="ai-note">Inclui taxas, para todos os passageiros.</p></div>`;
}

function paymentCard(card) {
  if (card.method === 'manual') {
    return `<div class="ai-card ai-pay"><p class="ai-card-title">Reserva ${esc(card.reference)}</p><div class="ai-total"><span>Total</span><strong>${esc(formatKz(card.amountKz))}</strong></div>
      <a class="ai-btn ai-wa" data-booking="${esc(card.reference)}" href="${esc(whatsappLink(`Olá, DOT Viagens! Quero pagar a minha reserva ${card.reference} com pagamento manual.`))}" target="_blank" rel="noopener"><img src="/assets/whatsapp-white.svg" width="18" height="18" alt="">Enviar para o WhatsApp</a>
      <a class="ai-link" href="/minhas-viagens?ref=${encodeURIComponent(card.reference)}">Ver em Minhas viagens</a></div>`;
  }
  return `<div class="ai-card ai-pay"><p class="ai-card-title">Reserva ${esc(card.reference)}</p><div class="ai-total"><span>Total</span><strong>${esc(formatKz(card.amountKz))}</strong></div>
    ${card.hostedUrl ? `<a class="ai-btn" href="${esc(card.hostedUrl)}" target="_blank" rel="noopener">${icon('lock', 16)} Pagar agora</a><p class="ai-note">Multicaixa Express ou referência, na página segura da Wiza.</p>` : `<p class="ai-note">${esc(card.paymentError || 'O pagamento não abriu.')} Tenta de novo em Minhas viagens.</p>`}
    <a class="ai-link" href="/minhas-viagens?ref=${encodeURIComponent(card.reference)}">Ver em Minhas viagens</a></div>`;
}

const whatsappCard = () => `<div class="ai-card"><a class="ai-btn ai-wa" href="${esc(whatsappLink('Olá, DOT Viagens! Preciso de ajuda com uma viagem.'))}" target="_blank" rel="noopener"><img src="/assets/whatsapp-white.svg" width="18" height="18" alt="">Falar no WhatsApp</a></div>`;

function cardHtml(card) {
  if (card.type === 'flights' && card.items?.length) return flightsCard(card);
  if (card.type === 'dates' && card.items?.length) return datesCard(card);
  if (card.type === 'quote') return quoteCard(card);
  if (card.type === 'payment') return paymentCard(card);
  if (card.type === 'whatsapp') return whatsappCard();
  return '';
}

function itemHtml(item) {
  if (item.role === 'user') return `<div class="ai-msg user"><p>${esc(item.text)}</p></div>`;
  return `<div class="ai-msg bot">${item.text ? `<p>${richText(item.text)}</p>` : ''}${(item.cards || []).map(cardHtml).join('')}</div>`;
}

let panel;
let list;
let input;
let sendButton;
let busy = false;

function render() {
  list.innerHTML = itemHtml({ role: 'bot', text: GREETING }) + chat.items.map(itemHtml).join('');
  list.querySelectorAll('[data-booking]').forEach(fillWhatsapp);
  list.scrollTop = list.scrollHeight;
}

// Manual payment: the WhatsApp message carries the whole booking (as in the checkout).
async function fillWhatsapp(link) {
  try {
    const { booking } = await api(`/api/bookings/${encodeURIComponent(link.dataset.booking)}`);
    if (booking) link.href = booking.whatsappUrl || bookingLink(booking);
  } catch {
    /* keeps the short message */
  }
}

async function send(text) {
  const message = String(text || '').trim().slice(0, 800);
  if (!message || busy) return;
  busy = true;
  chat.items.push({ role: 'user', text: message });
  save();
  render();
  input.value = '';
  resize();
  sendButton.disabled = true;
  const typing = document.createElement('div');
  typing.className = 'ai-msg bot typing';
  typing.innerHTML = `<p><span class="ai-dots"><i></i><i></i><i></i></span> <span class="ai-wait">${WAITING[0]}</span></p>`;
  list.append(typing);
  list.scrollTop = list.scrollHeight;
  let step = 0;
  const timer = setInterval(() => {
    step = Math.min(step + 1, WAITING.length - 1);
    typing.querySelector('.ai-wait').textContent = WAITING[step];
  }, 4500);
  try {
    const data = await api('/api/ai/chat', { method: 'POST', body: { token: chat.token, message }, timeout: 58000 });
    if (data.token) chat.token = data.token;
    chat.items.push({ role: 'bot', text: data.reply?.text || '', cards: data.reply?.cards || [] });
  } catch (error) {
    chat.items.push({ role: 'bot', text: error.message || 'Não foi possível responder agora. Tenta de novo.', cards: error.status === 503 ? [{ type: 'whatsapp' }] : [] });
  } finally {
    clearInterval(timer);
    busy = false;
    sendButton.disabled = false;
    save();
    render();
    input.focus({ preventScroll: true });
  }
}

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

function restart() {
  if (busy) return;
  chat = { token: null, items: [] };
  save();
  render();
}

function build() {
  panel = document.createElement('section');
  panel.className = 'ai-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Comprar com IA');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="ai-head"><span class="ai-avatar">${icon('sparkles', 20)}</span><div><strong>Assistente DOT</strong><small>Compra as tuas passagens aqui no chat</small></div>
      <button type="button" class="ai-icon-btn" data-restart aria-label="Nova conversa" title="Nova conversa">${icon('refresh', 18)}</button>
      <button type="button" class="ai-icon-btn" data-close aria-label="Fechar">${icon('x', 20)}</button></header>
    <div class="ai-list" aria-live="polite"></div>
    <form class="ai-form"><textarea rows="1" maxlength="800" placeholder="Para onde queres viajar?" aria-label="Mensagem"></textarea><button type="submit" aria-label="Enviar">${icon('send', 18)}</button></form>
    <p class="ai-foot">A assistente pode errar: a equipa DOT confirma os dados antes de emitir o bilhete.</p>`;
  document.body.append(panel);
  list = panel.querySelector('.ai-list');
  input = panel.querySelector('textarea');
  sendButton = panel.querySelector('.ai-form button');
  panel.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    send(input.value);
  });
  input.addEventListener('input', resize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });
  panel.querySelector('[data-close]').addEventListener('click', close);
  panel.querySelector('[data-restart]').addEventListener('click', restart);
  list.addEventListener('click', event => {
    const target = event.target.closest('[data-say]');
    if (target) send(target.dataset.say);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });
}

let float;
function open() {
  if (!panel) build();
  panel.hidden = false;
  document.body.classList.add('ai-open');
  render();
  if (matchMedia('(min-width: 761px)').matches) input.focus({ preventScroll: true });
}
function close() {
  panel.hidden = true;
  document.body.classList.remove('ai-open');
}

function mount() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/ai-chat.css';
  document.head.append(link);

  // Header: before "Minhas viagens".
  const account = document.querySelector('header .account, header .account-link');
  if (account) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-header-btn';
    button.innerHTML = `${icon('sparkles', 16)}<span>Comprar com IA</span>`;
    button.addEventListener('click', open);
    account.before(button);
  }

  float = document.createElement('button');
  float.type = 'button';
  float.className = 'ai-float';
  float.setAttribute('aria-label', 'Compra as tuas passagens com IA');
  float.innerHTML = `<span class="ai-float-icon">${icon('sparkles', 24)}</span><span class="ai-float-text">Compra as tuas passagens com IA</span>`;
  float.addEventListener('click', () => {
    float.classList.remove('teaser');
    open();
  });
  document.body.append(float);

  // Teaser: once per visit, a few seconds after the page opens, then only the icon.
  let seen = '1';
  try {
    seen = sessionStorage.getItem(TEASER);
  } catch {
    /* blocked: no teaser */
  }
  if (!seen) {
    setTimeout(() => {
      if (document.body.classList.contains('ai-open')) return;
      try {
        sessionStorage.setItem(TEASER, '1');
      } catch {
        /* blocked */
      }
      float.classList.add('teaser');
      setTimeout(() => float.classList.remove('teaser'), 9000);
    }, 6000);
  }
  if (new URLSearchParams(location.search).get('ia') === '1') open();
}

api('/api/ai/status', { timeout: 8000 })
  .then(status => {
    if (status?.enabled) mount();
  })
  .catch(() => {});
