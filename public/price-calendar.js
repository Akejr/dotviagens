// Date picker with the cheapest indicative price under each day (home search and results).
// Prices come from /api/flights/calendar (one request per month view) in BRL and are shown
// like every other price on the site: câmbio do dia + DOT fee, in kwanzas.

import { totalKz, totalBrl } from './flight-model.js';

// Indicative prices: kept 3 hours in this browser (the server keeps a shared copy for 6 hours).
const CACHE_KEY = 'dot-calendar-v2';
const TTL = 3 * 60 * 60 * 1000;
// Default DOT fee of the server (DEFAULT_MARKUP_BP; the panel can change it): only used if /api/rate cannot be read.
const FALLBACK_MARKUP_BP = 1100;
const memory = new Map();
const pending = new Map();
let pricingTask = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pad = n => String(n).padStart(2, '0');
export const isoOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = iso => new Date(`${iso}T12:00:00`);
export const addDaysIso = (iso, days) => {
  const date = parse(iso);
  date.setDate(date.getDate() + days);
  return isoOf(date);
};
export const daysBetweenIso = (from, to) => Math.round((parse(to) - parse(from)) / 86400000);
const monthText = new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric' });
const longDay = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'full' });
const oneDecimal = new Intl.NumberFormat('pt-AO', { maximumFractionDigits: 1 });
const kzFull = new Intl.NumberFormat('pt-AO', { style: 'currency', currency: 'AOA', maximumFractionDigits: 0 });
const brlFull = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

try {
  localStorage.removeItem('dot-calendar-v1');
  sessionStorage.removeItem('dot-calendar-v1');
  for (const [key, value] of JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')) if (value.until > Date.now()) memory.set(key, value);
} catch {
  // Private mode or corrupted cache: start empty.
}

function persist() {
  while (memory.size > 60) memory.delete(memory.keys().next().value);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...memory].filter(([, value]) => value.until > Date.now())));
  } catch {
    // Storage full or blocked: memory cache still works.
  }
}

export function loadPricing() {
  pricingTask ||= fetch('/api/rate', { headers: { Accept: 'application/json' } })
    .then(response => (response.ok ? response.json() : null))
    .catch(() => null)
    .then(data => ({
      rate: Number(data?.rate) > 0 ? Number(data.rate) : null,
      markupBp: Number.isInteger(data?.markupBp) ? data.markupBp : FALLBACK_MARKUP_BP,
    }));
  return pricingTask;
}

// Round-trip prices are asked for a standard trip length (the closest one): one cached month then
// serves every visitor with a similar trip. The prices are indicative anyway.
export const TRIP_LENGTHS = [3, 5, 7, 10, 14, 21, 30, 45, 60];
export const standardTripDays = days => TRIP_LENGTHS.reduce((best, n) => (Math.abs(n - days) < Math.abs(best - days) ? n : best), TRIP_LENGTHS[0]);

// Prices are always asked for 1 adult (one cache for 1 to 4 adults) and multiplied by the adults
// when shown. The final price comes from the flight search.
const requestBody = (query, month) => {
  const body = { origin: query.origin, destination: query.destination, passengers: 1, type: query.type, month };
  if (query.fixedOutbound) body.fixedOutbound = query.fixedOutbound;
  else if (query.type === 'return') body.tripDays = query.tripDays || 7;
  return body;
};
export const adultsOf = query => Math.min(4, Math.max(1, Number(query?.passengers) || 1));

export function hasMonth(query, month) {
  const saved = memory.get(JSON.stringify(requestBody(query, month)));
  return Boolean(saved && saved.until > Date.now());
}

const postCalendar = body => fetch('/api/flights/calendar', {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  // The server gives each provider request up to 50 s (server/searchapi.mjs, CALENDAR_TIMEOUT_MS).
  signal: AbortSignal.timeout(58000),
}).then(async response => {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Preços indisponíveis.');
  return data;
});

// Prices this visitor already got from real searches (kept by the results page in sessionStorage),
// per adult: a searched day shows its real price when it is below the calendar (the server does the
// same with every visitor's searches of the last 6 hours).
function knownPrices(query, month) {
  const found = new Map();
  let saved = [];
  try {
    saved = JSON.parse(sessionStorage.getItem('dot-flight-cache-v3') || '[]');
  } catch {
    return found;
  }
  for (const [key, value] of Array.isArray(saved) ? saved : []) {
    let q;
    try {
      q = JSON.parse(key);
    } catch {
      continue;
    }
    const offers = value?.data?.offers;
    if (!q || q.selectedOutbound || q.departureToken || q.stops || !Array.isArray(offers) || !offers.length) continue;
    if (q.origin !== query.origin || q.destination !== query.destination || Boolean(q.returnDate) !== (query.type === 'return')) continue;
    let date = q.departureDate;
    if (query.fixedOutbound) {
      if (q.departureDate !== query.fixedOutbound) continue;
      date = q.returnDate;
    } else if (query.type === 'return' && standardTripDays(daysBetweenIso(q.departureDate, q.returnDate)) !== (query.tripDays || 7)) {
      continue;
    }
    if (!String(date).startsWith(month)) continue;
    const amount = Math.min(...offers.map(offer => Number(offer.amount)).filter(amount => amount > 0)) / Math.max(1, Number(q.passengers) || 1);
    if (Number.isFinite(amount) && !(found.get(date) <= amount)) found.set(date, amount);
  }
  return found;
}

function withKnown(query, month, prices) {
  const known = knownPrices(query, month);
  for (const [date, amount] of known) {
    const current = prices.get(date);
    if (!current || amount < current.amount) prices.set(date, { ...(current || { low: false }), date, amount });
  }
  return prices;
}

// Map of 'YYYY-MM-DD' -> { amount (BRL for 1 adult), ... } for one month of one query.
// When the server answers with `parts` (slow providers), every part is asked at once and
// onPartial(map) receives the days found so far as each part arrives.
export function monthPrices(query, month, onPartial) {
  const body = requestBody(query, month);
  const key = JSON.stringify(body);
  const saved = memory.get(key);
  if (saved && saved.until > Date.now()) return Promise.resolve(withKnown(query, month, new Map(saved.prices)));
  let job = pending.get(key);
  if (!job) {
    const listeners = new Set();
    const task = (async () => {
      const first = await postCalendar(body);
      let prices = (first?.prices || []).map(price => [price.date, price]);
      let complete = true;
      if (Number.isInteger(first?.parts) && first.parts > 1) {
        const found = new Map();
        const results = await Promise.allSettled(Array.from({ length: first.parts }, (_, part) => postCalendar({ ...body, part }).then(data => {
          for (const price of data?.prices || []) found.set(price.date, price);
          for (const listener of listeners) {
            try {
              listener(new Map(found));
            } catch {
              // A calendar that was closed or re-rendered never stops the other parts.
            }
          }
        })));
        const failed = results.filter(result => result.status === 'rejected');
        if (failed.length === first.parts) throw failed[0].reason;
        complete = !failed.length;
        prices = [...found];
      }
      // A month with a missing part is not kept, so the next opening asks it again.
      if (complete) {
        memory.set(key, { prices, until: Date.now() + TTL });
        persist();
      }
      return new Map(prices);
    })().finally(() => pending.delete(key));
    job = { task, listeners };
    pending.set(key, job);
  }
  if (onPartial) job.listeners.add(partial => onPartial(withKnown(query, month, partial)));
  return job.task.then(prices => withKnown(query, month, new Map(prices)));
}

// Starts loading a month in the background. Not used on hover or on route choice any more:
// each month costs paid searches, so prices load only when a calendar or the date strip shows them.
export function prefetchMonth(query, month) {
  if (!query || !/^\d{4}-\d{2}$/.test(month || '')) return;
  monthPrices(query, month).catch(() => {});
  loadPricing();
}

// Compact price for the calendar cells: "953 mil", "2,6 M" (kwanzas) or "R$ 4,5 mil".
export function shortPrice(brl, pricing) {
  if (pricing?.rate) {
    const kz = totalKz(brl, pricing.rate, pricing.markupBp);
    if (Math.round(kz / 1000) >= 1000) return `${oneDecimal.format(kz / 1e6)} M`;
    if (kz >= 1000) return `${Math.round(kz / 1000)} mil`;
    return String(kz);
  }
  const value = totalBrl(brl, pricing?.markupBp ?? FALLBACK_MARKUP_BP);
  return value >= 1000 ? `R$ ${oneDecimal.format(value / 1000)} mil` : `R$ ${Math.round(value)}`;
}

const fullPrice = (brl, pricing) => (pricing?.rate
  ? kzFull.format(totalKz(brl, pricing.rate, pricing.markupBp))
  : brlFull.format(totalBrl(brl, pricing?.markupBp ?? FALLBACK_MARKUP_BP)));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the number under each day means, for the legend.
export function priceMeaning(query) {
  if (!query) return '';
  const adults = plural(adultsOf(query), 'adulto', 'adultos');
  if (query.type === 'oneway') return `Só ida · ${adults}`;
  if (query.fixedOutbound) return `Total ida e volta, com partida a ${query.fixedOutbound.split('-').reverse().slice(0, 2).join('/')} · ${adults}`;
  return `Ida e volta de ~${plural(query.tripDays || 7, 'dia', 'dias')} · ${adults}`;
}

/**
 * Renders a month calendar into `root`.
 * opts: value, min, max (ISO dates), heading, foot (trusted HTML), outboundDay,
 * priceQuery ({origin, destination, passengers, type, fixedOutbound?, tripDays?} or null),
 * emptyNote, onSelect(iso), onRender().
 */
export function mountCalendar(root, opts) {
  const { min, max } = opts;
  const start = opts.value && opts.value >= min ? opts.value : min;
  let month = parse(start);
  month.setDate(1);

  function dayButton(date) {
    const iso = isoOf(date);
    const disabled = iso < min || iso > max;
    const classes = ['day', iso === opts.value ? 'chosen' : '', iso === isoOf(new Date()) ? 'today' : '', iso === opts.outboundDay ? 'outbound-day' : ''].filter(Boolean).join(' ');
    const label = `${longDay.format(date)}${iso === opts.outboundDay ? ' · dia da ida' : ''}`;
    return `<button type="button" class="${classes}" data-date="${iso}" data-label="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${iso === opts.value}" ${disabled ? 'disabled' : ''}><span class="day-num">${date.getDate()}</span><span class="day-price">${opts.priceQuery && !disabled ? '<i class="price-dot"></i>' : ''}</span></button>`;
  }

  function legend(state, extra = '') {
    const box = root.querySelector('.calendar-legend');
    if (!box) return;
    if (!opts.priceQuery) {
      box.innerHTML = opts.emptyNote ? `<span>${esc(opts.emptyNote)}</span>` : '';
      return;
    }
    const meaning = esc(priceMeaning(opts.priceQuery));
    box.innerHTML = {
      loading: `<span class="legend-loading">A carregar os preços deste mês…</span>`,
      ready: `<span class="legend-cheap"><i></i><b>Mais baratos</b></span><span>${meaning}${extra}</span>`,
      empty: `<span>Sem preços indicativos para este mês.</span>`,
      error: `<span>Preços indicativos indisponíveis de momento.</span>`,
    }[state];
  }

  // The calendar may have been closed while waiting (a closed popover keeps its content).
  const shown = () => root.isConnected && (!root.closest('[popover]') || root.closest('[popover]').matches(':popover-open'));

  async function fillPrices(current) {
    if (!opts.priceQuery) return legend('none');
    const enabled = [...root.querySelectorAll('.day:not(:disabled)')];
    if (!enabled.length) return legend('empty');
    if (!shown()) return;
    legend('loading');
    const adults = adultsOf(opts.priceQuery);
    let pricing = null;
    // Paints the prices known so far; days still loading keep their dot until the end (done).
    const paint = (prices, done) => {
      if (current !== month || !pricing) return;
      const totalOf = date => {
        const amount = prices.get(date)?.amount;
        return Number.isFinite(amount) ? amount * adults : undefined;
      };
      const amounts = enabled.map(button => totalOf(button.dataset.date)).filter(Number.isFinite).sort((a, b) => a - b);
      // Cheapest fifth of the month, only when prices actually differ.
      const threshold = amounts.length >= 3 && amounts.at(-1) > amounts[0] ? amounts[Math.floor((amounts.length - 1) * 0.2)] : -1;
      for (const button of enabled) {
        const amount = totalOf(button.dataset.date);
        const slot = button.querySelector('.day-price');
        if (!Number.isFinite(amount)) {
          if (done) slot.textContent = '';
          continue;
        }
        slot.textContent = shortPrice(amount, pricing);
        button.classList.toggle('cheap', done && amount <= threshold);
        button.setAttribute('aria-label', `${button.dataset.label} · desde ${fullPrice(amount, pricing)}`);
      }
      if (!done) return;
      if (!amounts.length) legend('empty');
      else legend('ready', ` · desde <b class="legend-min">${esc(fullPrice(amounts[0], pricing))}</b>`);
    };
    try {
      const prices = monthPrices(opts.priceQuery, isoOf(current).slice(0, 7), partial => paint(partial, false));
      prices.catch(() => {});
      pricing = await loadPricing();
      const all = await prices;
      if (current !== month) return;
      paint(all, true);
    } catch {
      if (current !== month) return;
      enabled.forEach(button => { button.querySelector('.day-price').textContent = ''; });
      legend('error');
    }
    opts.onRender?.();
  }

  let fillTimer = null;

  function render(focus, wait = 0) {
    const current = month;
    const first = (current.getDay() + 6) % 7;
    const count = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
    const previousEnd = isoOf(new Date(current.getFullYear(), current.getMonth(), 0));
    const nextStart = isoOf(new Date(current.getFullYear(), current.getMonth() + 1, 1));
    root.innerHTML = `<div class="picker-heading">${esc(opts.heading)}</div>
      <div class="calendar-nav"><button type="button" class="prev-month" aria-label="Mês anterior" ${previousEnd < min ? 'disabled' : ''}>‹</button><strong>${monthText.format(current)}</strong><button type="button" class="next-month" aria-label="Mês seguinte" ${nextStart > max ? 'disabled' : ''}>›</button></div>
      <div class="calendar-grid${opts.priceQuery ? ' priced' : ''}">${['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map(day => `<div class="weekday">${day}</div>`).join('')}${'<span></span>'.repeat(first)}${Array.from({ length: count }, (_, i) => dayButton(new Date(current.getFullYear(), current.getMonth(), i + 1))).join('')}</div>
      <div class="calendar-legend" aria-live="polite"></div>
      ${opts.foot ? `<div class="picker-foot">${opts.foot}</div>` : ''}`;
    // Paging through months waits until the customer stops (each new month is a paid search).
    const move = step => {
      month = new Date(current.getFullYear(), current.getMonth() + step, 1);
      render(step < 0 ? '.prev-month' : '.next-month', 450);
    };
    root.querySelector('.prev-month').onclick = () => move(-1);
    root.querySelector('.next-month').onclick = () => move(1);
    root.querySelectorAll('[data-date]').forEach(button => {
      button.onclick = () => opts.onSelect(button.dataset.date);
    });
    opts.onRender?.();
    const target = (focus && root.querySelector(`${focus}:not(:disabled)`)) || root.querySelector('.day.chosen:not(:disabled)') || root.querySelector('.day:not(:disabled)');
    target?.focus();
    clearTimeout(fillTimer);
    if (wait && opts.priceQuery && !hasMonth(opts.priceQuery, isoOf(current).slice(0, 7))) {
      legend('loading');
      fillTimer = setTimeout(() => fillPrices(current), wait);
    } else {
      fillPrices(current);
    }
  }

  render();
}

// Stand-alone popover (results page). The home page reuses its own picker panel.
let popover = null;
let popoverTrigger = null;

function place() {
  if (!popover || !popoverTrigger) return;
  const rect = popoverTrigger.getBoundingClientRect();
  const width = Math.min(380, innerWidth - 32);
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.min(innerHeight - 32, 600)}px`;
  popover.style.left = `${Math.max(16, Math.min(rect.right - width, innerWidth - width - 16))}px`;
  popover.style.top = '0px';
  const height = popover.getBoundingClientRect().height;
  const below = rect.bottom + 10;
  popover.style.top = `${Math.max(16, below + height <= innerHeight - 16 ? below : Math.min(rect.top - height - 10, innerHeight - height - 16))}px`;
}

export function closeCalendarPopover(restore = false) {
  if (!popoverTrigger) return;
  const trigger = popoverTrigger;
  popoverTrigger = null;
  trigger.setAttribute('aria-expanded', 'false');
  popover.hidePopover();
  if (restore) trigger.focus();
}

function ensurePopover() {
  if (popover) return popover;
  popover = document.createElement('div');
  popover.className = 'travel-picker calendar-popover';
  popover.setAttribute('popover', 'manual');
  document.body.append(popover);
  document.addEventListener('pointerdown', event => {
    if (popoverTrigger && !popover.contains(event.target) && !popoverTrigger.contains(event.target)) closeCalendarPopover();
  });
  document.addEventListener('keydown', event => {
    if (popoverTrigger && event.key === 'Escape') {
      event.preventDefault();
      closeCalendarPopover(true);
    }
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, { passive: true });
  return popover;
}

export function openCalendarPopover(trigger, opts) {
  if (popoverTrigger === trigger) return closeCalendarPopover(true);
  closeCalendarPopover();
  const panel = ensurePopover();
  popoverTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  panel.innerHTML = '<div role="dialog" aria-label="Escolher data"><div class="calendar-content"></div></div>';
  panel.showPopover();
  mountCalendar(panel.querySelector('.calendar-content'), {
    ...opts,
    onRender: place,
    onSelect: iso => {
      closeCalendarPopover(true);
      opts.onSelect(iso);
    },
  });
  place();
}
