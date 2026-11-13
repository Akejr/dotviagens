// Purchase by AI: a chat (public/ai-chat.js) where a language model (OpenRouter) talks with the
// customer and uses the site's own functions as tools: airport search, price calendar (the ±3 days
// around the chosen date, 1 request per month, shared 6 hours), flight search, choice of the
// flights, quote, SMS code, passengers, booking and payment (manual on WhatsApp, or Multicaixa
// Express and reference on the Wiza page). Prices and flights come only from those tools: the model
// never writes a price of its own. Bookings made here have channel = 'ai'.
// Abuse and cost: limits per conversation, per visitor and per day (see LIMITS), short answers.

import { HttpError, json, readJson, assertSameOrigin, cleanText, parseCookies } from './http.mjs';
import { db, hasSupabase } from './supabase.mjs';
import { sha256Hex } from './crypto.mjs';
import { requestOtp, verifyOtp, getSession, requireAdmin, SESSION_COOKIE } from './auth.mjs';
import { quote, createBooking } from './bookings.mjs';
import { validatePassengers } from './passengers.mjs';
import { currentRate, currentMarkup, priceAoa, luandaToday } from './rates.mjs';
import { isPlace } from './places.mjs';
import { countryPlaces } from './airport-codes.mjs';
import { cityGroups } from './city-airports.mjs';
import { airportInfo, airportCity } from './airport-names.mjs';
import { CABINS } from './flights.mjs';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const hasAi = env => Boolean(env.OPENROUTER_API_KEY) && hasSupabase(env);
const modelOf = env => env.AI_MODEL || DEFAULT_MODEL;
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export const LIMITS = {
  messageChars: 800, // longest customer message
  userMessages: 40, // per conversation
  searches: 8, // flight searches per conversation (outbound, returns)
  calendar: 6, // price calendar lookups per conversation
  conversationsPerVisitor: 6, // per visitor and day
  messagesPerVisitor: 80, // per visitor and day
  history: 40, // messages sent to the model
  steps: 6, // model calls per customer message
  maxTokens: 900,
  deadlineMs: 50000, // the function may run 60 s
};
const dailyUsd = env => num(env.AI_DAILY_USD, 5);
const dailySearches = env => num(env.AI_DAILY_SEARCHES, 300);

// ── Text helpers ─────────────────────────────────────────────────────────────
const groupDigits = value => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const kzText = value => `${groupDigits(value)} Kz`;
const dayOf = value => String(value || '').slice(0, 10);
const shift = (from, to) => Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${dayOf(from)}T00:00:00Z`)) / 86400000) || 0;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const durationText = minutes => `${Math.floor((minutes || 0) / 60)}h ${String((minutes || 0) % 60).padStart(2, '0')}min`;
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const regionNames = new Intl.DisplayNames(['pt'], { type: 'region' });

// ── Airport search (find_place) ──────────────────────────────────────────────
let placeIndex = null;
function places() {
  if (placeIndex) return placeIndex;
  const list = [];
  for (const [code, group] of cityGroups) list.push({ code, label: `${group.name} (todos os aeroportos: ${group.airports.join(', ')})`, words: ` ${normalize(`${group.name} ${group.airports.map(a => airportCity.get(a)).join(' ')}`)} `, rank: 0 });
  for (const code of countryPlaces.keys()) list.push({ code, label: `${regionNames.of(code)} (todos os aeroportos do país)`, words: ` ${normalize(`${regionNames.of(code)} ${new Intl.DisplayNames(['en'], { type: 'region' }).of(code)}`)} `, rank: 1 });
  for (const [code, city, country, name] of airportInfo) list.push({ code, label: `${city} (${code}), ${regionNames.of(country) || country} · ${name}`, words: ` ${normalize(`${city} ${name} ${regionNames.of(country) || ''} ${code}`)} `, rank: 2 });
  placeIndex = list;
  return list;
}
export function findPlaces(query) {
  const q = normalize(query);
  if (q.length < 2) return [];
  const exact = q.toUpperCase();
  return places()
    .filter(p => p.code === exact || p.words.includes(` ${q}`))
    .sort((a, b) => (b.code === exact) - (a.code === exact) || a.rank - b.rank)
    .slice(0, 8)
    .map(({ code, label }) => ({ code, label }));
}

// ── Calls to the site's own routes (same validation, caches, logs and limits) ──
const FORWARD = ['user-agent', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-vercel-ip-country', 'x-vercel-ip-city', 'x-vercel-forwarded-for'];
function inner(request, path, body, cookieHeader) {
  const url = new URL(path, request.url);
  const headers = { 'content-type': 'application/json', origin: url.origin };
  for (const name of FORWARD) if (request.headers.get(name)) headers[name] = request.headers.get(name);
  if (cookieHeader) headers.cookie = cookieHeader;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
// Handlers either return a Response or throw an HttpError: both become {ok, status, data}.
async function call(handler, req, env, ctx, deps) {
  try {
    const response = await handler(req, env, ctx, deps);
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data, setCookie: response.headers.get('set-cookie') };
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, status: error.status, data: { error: error.message, code: error.code } };
    return { ok: false, status: 500, data: { error: 'Erro interno.', code: 'INTERNAL' } };
  }
}

// ── Tools (OpenAI function format) ───────────────────────────────────────────
const travellersSchema = {
  passengers: { type: 'integer', description: 'Adultos (12 anos ou mais), 1 a 4.' },
  children: { type: 'integer', description: 'Crianças de 2 a 11 anos, 0 a 3.' },
  cabin: { type: 'string', enum: Object.keys(CABINS), description: 'economy (Económica), premium_economy (Económica premium), business (Executiva), first (Primeira).' },
};
const tripSchema = {
  origin: { type: 'string', description: 'Código devolvido por find_place (ex.: NBJ, LIS, PT, SVO,DME,VKO,ZIA).' },
  destination: { type: 'string', description: 'Código devolvido por find_place.' },
  departureDate: { type: 'string', description: 'Data da ida, AAAA-MM-DD.' },
  returnDate: { type: 'string', description: 'Data da volta, AAAA-MM-DD. Omitir em só ida.' },
  ...travellersSchema,
};
export const TOOLS = [
  { name: 'find_place', description: 'Procura o código de uma cidade, aeroporto ou país. Usa sempre antes de pesquisar voos.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'price_calendar', description: 'Usa logo que tiveres a viagem completa. Devolve os voos reais do dia pedido (preço exacto, em cartão) e os preços indicativos dos 3 dias antes e 3 dias depois (calendário).', parameters: { type: 'object', properties: tripSchema, required: ['origin', 'destination', 'departureDate', 'passengers', 'cabin'] } },
  { name: 'search_flights', description: 'Pesquisa os voos reais de OUTRO dia que o cliente escolheu depois de ver o calendário (preço exacto, gasta 1 pesquisa). Mostra os voos num cartão.', parameters: { type: 'object', properties: tripSchema, required: ['origin', 'destination', 'departureDate', 'passengers', 'cabin'] } },
  { name: 'choose_flight', description: 'Escolhe um voo pelo código do cartão (I1, I2... na ida; V1, V2... na volta). Na ida e volta, escolher a ida mostra as voltas; escolher a volta prepara o preço final.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
  { name: 'send_phone_code', description: 'Envia o código por SMS para confirmar o telemóvel do cliente. Pede antes o nome completo e o e-mail.', parameters: { type: 'object', properties: { phone: { type: 'string', description: 'Telemóvel angolano, 9 dígitos começados por 9.' }, name: { type: 'string' }, email: { type: 'string' } }, required: ['phone', 'name', 'email'] } },
  { name: 'confirm_phone_code', description: 'Confirma o código de 6 dígitos que o cliente recebeu por SMS.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  {
    name: 'save_passengers',
    description: 'Guarda os dados de todos os passageiros, tal como no passaporte: primeiro os adultos, depois as crianças.',
    parameters: {
      type: 'object',
      properties: {
        passengers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', enum: ['MR', 'MS'], description: 'MR = Sr., MS = Sra.' },
              givenNames: { type: 'string' },
              surname: { type: 'string' },
              birthDate: { type: 'string', description: 'AAAA-MM-DD' },
              nationality: { type: 'string', description: 'País ISO de 2 letras, ex.: AO' },
              documentNumber: { type: 'string' },
              documentCountry: { type: 'string', description: 'País emissor do passaporte, ISO de 2 letras' },
              documentExpiry: { type: 'string', description: 'Validade do passaporte, AAAA-MM-DD' },
            },
            required: ['title', 'givenNames', 'surname', 'birthDate', 'nationality', 'documentNumber', 'documentCountry', 'documentExpiry'],
          },
        },
      },
      required: ['passengers'],
    },
  },
  { name: 'create_booking', description: 'Cria a reserva depois de o cliente confirmar que os dados estão correctos e escolher o pagamento: manual (WhatsApp) ou wiza (Multicaixa Express ou referência).', parameters: { type: 'object', properties: { paymentMethod: { type: 'string', enum: ['manual', 'wiza'] }, confirmed: { type: 'boolean', description: 'true só depois de o cliente confirmar os dados.' }, invoiceNif: { type: 'string' }, invoiceName: { type: 'string' } }, required: ['paymentMethod', 'confirmed'] } },
].map(fn => ({ type: 'function', function: fn }));

// ── System prompt ────────────────────────────────────────────────────────────
function systemPrompt(state) {
  const today = luandaToday();
  return [
    'És a assistente de compras da DOT Viagens, uma agência angolana que vende passagens aéreas pagas em kwanzas.',
    `Hoje é ${today} (hora de Luanda). Escreve em português de Angola, tratando o cliente por tu, com a grafia de Angola (seleccionar, directo, actual, factura, contacto, telemóvel, Económica). Nunca uses travessões.`,
    'Respostas curtas: 1 a 3 frases. Uma pergunta de cada vez. Não repitas a lista de voos: os voos e datas aparecem em cartões no ecrã.',
    'Destaca em **negrito** só o essencial: preços, datas, a referência da reserva e o que pedes ao cliente (ex.: "diz-me o teu **nome completo** e o teu **e-mail**"). No máximo 3 destaques por mensagem.',
    'Regras: nunca inventes voos, horários nem preços. Os preços vêm só das ferramentas. price_calendar dá preços indicativos; search_flights dá o preço exacto. Fala só de viagens e da compra na DOT; recusa com simpatia outros assuntos.',
    'Passos:',
    '1. Pergunta origem, destino, datas, se é só ida ou ida e volta, quantos adultos (12+) e crianças (2 a 11 anos) e a classe (Económica, Económica premium, Executiva ou Primeira). Se o cliente der tudo de uma vez, não perguntes de novo. Por defeito a origem é Luanda (NBJ) se o cliente não disser.',
    '2. Usa find_place para os códigos. Se houver dúvida (cidade com vários aeroportos), usa o código da cidade inteira.',
    '3. Com a viagem completa, chama price_calendar: traz os voos reais do dia pedido (cartão I1, I2...) e os preços indicativos dos 3 dias antes e depois. Diz o preço do voo mais barato do dia pedido (cheapestExact) e, se o calendário mostrar um dia mais barato, algo como: "O preço ficou em X, mas encontrei um valor melhor no dia D (cerca de Y, indicativo). Queres ver os voos desse dia?". Se o cliente quiser outro dia, chama search_flights para esse dia. Se não, pede para escolher um voo do cartão.',
    '4. Quando o cliente escolher um voo, chama choose_flight. Na ida e volta, depois escolhe a volta.',
    '5. Com o preço final, pede o nome completo e o e-mail, depois o telemóvel e chama send_phone_code; pede o código de 6 dígitos e chama confirm_phone_code.',
    '6. Pede os dados de cada passageiro como no passaporte: tratamento (Sr. ou Sra.), nome(s) próprio(s), apelido(s), data de nascimento, nacionalidade, número do passaporte, país emissor e validade. Depois chama save_passengers.',
    '7. Pergunta como quer pagar: pagamento manual pelo WhatsApp da DOT, ou Multicaixa Express e referência (página segura da Wiza). Cartões Visa e Mastercard estão indisponíveis. Pergunta se quer factura com NIF (opcional).',
    '8. Resume a viagem, os passageiros e o total, pede confirmação de que os nomes estão exactamente como no passaporte e chama create_booking com confirmed true.',
    'Depois do pagamento confirmado, a equipa DOT emite o bilhete com a companhia e envia o código da reserva por SMS: a emissão não é imediata. Bebés (menos de 2 anos), grupos grandes ou viagens sem voos: sugere falar com a equipa no WhatsApp +244 931 343 433.',
    'Se uma ferramenta devolver erro, explica ao cliente em linguagem simples e propõe o passo seguinte.',
    state?.summary ? `Estado actual da compra: ${state.summary}` : '',
  ].filter(Boolean).join('\n');
}

function summaryOf(state) {
  const parts = [];
  if (state.trip) parts.push(`viagem ${state.trip.origin} → ${state.trip.destination} ${state.trip.departureDate}${state.trip.returnDate ? ` a ${state.trip.returnDate}` : ''}, ${state.trip.passengers} adulto(s), ${state.trip.children || 0} criança(s), ${CABINS[state.trip.cabin]?.label}`);
  if (state.outbound) parts.push('ida escolhida');
  if (state.inbound) parts.push('volta escolhida');
  if (state.quote) parts.push(`total ${kzText(state.quote.amountAoa)}`);
  if (state.contact) parts.push(`contacto ${state.contact.name}, ${state.contact.email}, ${state.contact.phone}${state.verified ? ' (telemóvel confirmado)' : ' (código por confirmar)'}`);
  if (state.passengers?.length) parts.push(`${state.passengers.length} passageiro(s) guardado(s)`);
  if (state.booking) parts.push(`reserva ${state.booking.reference} criada (${state.booking.paymentMethod})`);
  return parts.join('; ');
}

// ── Tool execution ───────────────────────────────────────────────────────────
async function pricing(env, deps) {
  const [rate, markup] = await Promise.all([currentRate(env, deps).catch(() => null), currentMarkup(env, deps)]);
  return rate?.rate ? { rate: rate.rate, markupBp: markup.markupBp } : null;
}
const kzOf = (brl, prices) => priceAoa(brl, prices.rate, prices.markupBp).amountAoa;

function tripOf(args) {
  const trip = {
    origin: String(args.origin || '').toUpperCase().replace(/\s+/g, ''),
    destination: String(args.destination || '').toUpperCase().replace(/\s+/g, ''),
    departureDate: args.departureDate,
    returnDate: args.returnDate || null,
    passengers: Number(args.passengers) || 1,
    children: Number(args.children) || 0,
    cabin: Object.hasOwn(CABINS, args.cabin) ? args.cabin : 'economy',
  };
  if (!isPlace(trip.origin) || !isPlace(trip.destination)) return { error: 'Código de origem ou destino desconhecido: usa find_place primeiro.' };
  if (trip.origin === trip.destination) return { error: 'A origem e o destino são iguais.' };
  if (!isoDate(trip.departureDate) || (trip.returnDate && !isoDate(trip.returnDate))) return { error: 'Datas em formato AAAA-MM-DD.' };
  return { trip };
}

function flightCard(offers, prices, prefix, title) {
  return {
    type: 'flights',
    title,
    items: offers.map((o, i) => {
      const first = o.segments[0];
      const last = o.segments.at(-1);
      return {
        ref: `${prefix}${i + 1}`,
        airline: o.airline,
        logos: [...new Map(o.segments.map(s => [s.airline, s.logo])).entries()].map(([name, logo]) => ({ name, logo })),
        from: first.from,
        to: last.to,
        departure: first.departure,
        arrival: last.arrival,
        plusDays: shift(first.departure, last.arrival),
        stops: o.stops,
        duration: o.duration,
        cabin: o.cabin,
        priceKz: kzOf(o.amount, prices),
      };
    }),
  };
}
const compactFlights = card => card.items.map(item => ({
  ref: item.ref,
  airline: item.airline,
  route: `${item.from} → ${item.to}`,
  departure: item.departure,
  arrival: `${item.arrival}${item.plusDays ? ` (+${item.plusDays})` : ''}`,
  stops: item.stops,
  duration: durationText(item.duration),
  price: kzText(item.priceKz),
}));

// Real search of one day (1 provider search): flights card I1, I2... and the state for choose_flight.
async function searchDay(ctx, trip, prices) {
  const { env, deps, request, state, conversation, cards } = ctx;
  if (conversation.provider_searches >= LIMITS.searches) return { error: 'Limite de pesquisas desta conversa atingido. Sugere continuar no site ou no WhatsApp.' };
  conversation.provider_searches += 1;
  const body = { ...trip, children: trip.children || undefined, stops: 0, kind: 'ai' };
  const result = await call(deps.search, inner(request, '/api/flights/search', body), env, deps.ctx, deps);
  if (!result.ok) return { error: result.data?.error || 'A pesquisa falhou.' };
  const offers = [...result.data.offers].sort((a, b) => a.amount - b.amount).slice(0, 6);
  Object.assign(state, { trip, search: { data: { ...result.data, offers }, at: Date.now() }, outbound: null, returns: null, inbound: null, quote: null });
  if (!offers.length) return { date: trip.departureDate, flights: [], note: 'Não há voos neste dia. Propõe outro dia ou o WhatsApp da DOT.' };
  const card = flightCard(offers, prices, 'I', trip.returnDate ? `Voos de ${trip.departureDate.split('-').reverse().join('/')}: escolhe a ida (preço da ida e volta)` : `Voos de ${trip.departureDate.split('-').reverse().join('/')}`);
  cards.push(card);
  return {
    date: trip.departureDate,
    cheapestExact: kzText(card.items[0].priceKz),
    flights: compactFlights(card),
    note: `${trip.returnDate ? 'Preços da viagem completa de ida e volta. Depois da ida, mostram-se as voltas.' : 'Preço total só ida para todos os passageiros.'} Os voos já estão num cartão no ecrã: o cliente toca em Escolher ou diz o código (I1, I2...).`,
  };
}

async function runTool(name, args, ctx) {
  const { env, deps, request, state, conversation, cards, jar } = ctx;
  const prices = await pricing(env, deps);
  if (!prices && ['price_calendar', 'search_flights', 'choose_flight'].includes(name)) return { error: 'As compras estão indisponíveis agora: o câmbio do dia ainda não foi definido. Sugere o WhatsApp da DOT.' };

  if (name === 'find_place') {
    const found = findPlaces(args.query);
    return found.length ? { places: found } : { places: [], note: 'Nada encontrado. Pede outro nome ou o código do aeroporto.' };
  }

  if (name === 'price_calendar') {
    const { trip, error } = tripOf(args);
    if (error) return { error };
    if (conversation.calendar_lookups >= LIMITS.calendar) return { error: 'Limite de consultas ao calendário desta conversa atingido.' };
    conversation.calendar_lookups += 1;
    const today = luandaToday();
    const days = Array.from({ length: 7 }, (_, i) => addDays(trip.departureDate, i - 3)).filter(d => d >= today);
    const nights = trip.returnDate ? Math.max(1, shift(trip.departureDate, trip.returnDate)) : null;
    const STANDARD = [3, 5, 7, 10, 14, 21, 30, 45, 60];
    const tripDays = nights ? STANDARD.reduce((best, n) => (Math.abs(n - nights) < Math.abs(best - nights) ? n : best), STANDARD[0]) : null;
    const found = new Map();
    for (const month of new Set(days.map(d => d.slice(0, 7)))) {
      const body = { origin: trip.origin, destination: trip.destination, passengers: 1, type: nights ? 'return' : 'oneway', month, ...(tripDays ? { tripDays } : {}), ...(trip.cabin !== 'economy' ? { cabin: trip.cabin } : {}) };
      const first = await call(deps.calendar, inner(request, '/api/flights/calendar', body), env, deps.ctx, deps);
      const answers = first.data?.parts ? await Promise.all(Array.from({ length: first.data.parts }, (_, part) => call(deps.calendar, inner(request, '/api/flights/calendar', { ...body, part }), env, deps.ctx, deps))) : [first];
      for (const answer of answers) for (const p of answer.data?.prices || []) if (!found.has(p.date) || p.amount < found.get(p.date)) found.set(p.date, p.amount);
    }
    const travellers = trip.passengers + trip.children;
    const list = days.map(date => ({ date, priceKz: found.has(date) ? kzOf(found.get(date), prices) * travellers : null }));
    const priced = list.filter(d => d.priceKz);
    const cheapest = priced.sort((a, b) => a.priceKz - b.priceKz)[0] || null;
    cards.push({ type: 'dates', title: `Preços indicativos ${nights ? `(ida e volta de ~${tripDays} dias)` : '(só ida)'}`, chosen: trip.departureDate, cheapest: cheapest?.date || null, items: list });
    const requestedDay = await searchDay(ctx, trip, prices);
    return {
      requestedDayFlights: requestedDay,
      indicative: true,
      days: list.map(d => ({ date: d.date, price: d.priceKz ? kzText(d.priceKz) : 'sem preço' })),
      chosenDay: { date: trip.departureDate, price: found.has(trip.departureDate) ? kzText(kzOf(found.get(trip.departureDate), prices) * travellers) : 'sem preço' },
      cheapestDay: cheapest ? { date: cheapest.date, price: kzText(cheapest.priceKz) } : null,
    };
  }

  if (name === 'search_flights') {
    const { trip, error } = tripOf(args);
    if (error) return { error };
    return searchDay(ctx, trip, prices);
  }

  if (name === 'choose_flight') {
    const ref = String(args.ref || '').toUpperCase().trim();
    const index = Number(ref.slice(1)) - 1;
    if (ref.startsWith('I')) {
      const offer = state.search?.data?.offers?.[index];
      if (!offer) return { error: 'Esse voo não está na lista. Usa um código do cartão (I1, I2...).' };
      const data = state.search.data;
      state.outbound = { offer, query: offer.query || data.query, searchedAt: offer.searchedAt || data.searchedAt };
      state.inbound = null;
      state.quote = null;
      if (!state.trip.returnDate) return prepareQuote(ctx, { outbound: state.outbound, inbound: null });
      if (!offer.departureToken) return { error: 'Este voo não permite escolher a volta. Escolhe outro.' };
      if (conversation.provider_searches >= LIMITS.searches) return { error: 'Limite de pesquisas desta conversa atingido.' };
      conversation.provider_searches += 1;
      const back = await call(deps.search, inner(request, '/api/flights/search', { ...state.outbound.query, departureToken: offer.departureToken, kind: 'ai' }), env, deps.ctx, deps);
      if (!back.ok) return { error: back.data?.error || 'Não foi possível ver as voltas.' };
      const returns = [...back.data.offers].sort((a, b) => a.amount - b.amount).slice(0, 6);
      state.returns = { data: { ...back.data, offers: returns } };
      if (!returns.length) return { returns: [], note: 'Não há voltas para esta ida. Escolhe outra ida.' };
      const card = flightCard(returns, prices, 'V', 'Escolhe a volta (total ida e volta)');
      cards.push(card);
      return { returns: compactFlights(card), note: 'Cada preço é o total da viagem de ida e volta.' };
    }
    if (ref.startsWith('V')) {
      const offer = state.returns?.data?.offers?.[index];
      if (!offer || !state.outbound) return { error: 'Escolhe primeiro a ida e depois uma volta da lista (V1, V2...).' };
      state.inbound = { offer, query: state.returns.data.query, searchedAt: state.returns.data.searchedAt };
      return prepareQuote(ctx, { outbound: state.outbound, inbound: state.inbound });
    }
    return { error: 'Código de voo inválido.' };
  }

  if (name === 'send_phone_code') {
    if (!state.quote) return { error: 'Escolhe primeiro os voos.' };
    const contact = { name: cleanText(args.name, 80), email: String(args.email || '').trim().slice(0, 160), phone: String(args.phone || '').replace(/\D/g, '').slice(-9) };
    if (contact.name.length < 3) return { error: 'Pede o nome completo.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact.email)) return { error: 'E-mail inválido.' };
    state.contact = contact;
    const session = await getSession(inner(request, '/api/auth/me', {}, jar.cookie), env, deps).catch(() => null);
    if (session?.customer?.phone === contact.phone) {
      state.verified = true;
      return { alreadyVerified: true, note: 'O telemóvel já está confirmado nesta sessão. Passa aos passageiros.' };
    }
    const sent = await call(requestOtp, inner(request, '/api/auth/otp/request', { phone: contact.phone, purpose: 'checkout' }), env, deps.ctx, deps);
    if (!sent.ok) return { error: sent.data?.error || 'Não foi possível enviar o SMS.' };
    state.verified = false;
    return { sent: true, to: sent.data.maskedPhone, sender: sent.data.sender || null, note: sent.data.sender ? `Na Movicel o SMS chega do número ${sent.data.sender}.` : 'Pede o código de 6 dígitos.' };
  }

  if (name === 'confirm_phone_code') {
    if (!state.contact) return { error: 'Envia primeiro o código (send_phone_code).' };
    const result = await call(verifyOtp, inner(request, '/api/auth/otp/verify', { phone: state.contact.phone, code: String(args.code || ''), purpose: 'checkout', name: state.contact.name, email: state.contact.email }), env, deps.ctx, deps);
    if (!result.ok) return { error: result.data?.error || 'Código incorrecto.' };
    const token = String(result.setCookie || '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (token) {
      jar.cookie = `${SESSION_COOKIE}=${token}`;
      jar.setCookie = result.setCookie;
    }
    state.verified = true;
    conversation.customer_id = result.data?.customer?.id || conversation.customer_id;
    return { verified: true };
  }

  if (name === 'save_passengers') {
    if (!state.quote) return { error: 'Escolhe primeiro os voos.' };
    const q = state.quote.query;
    try {
      const list = validatePassengers(args.passengers, { count: q.passengers, children: q.children || 0, departureDate: q.departureDate, lastTravelDate: state.quote.lastTravelDate });
      state.passengers = list.map(p => Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'type')));
      return { saved: list.length, passengers: list.map(p => `${p.type === 'child' ? 'Criança' : 'Adulto'}: ${p.title === 'MR' ? 'Sr.' : 'Sra.'} ${p.givenNames} ${p.surname}, nascido(a) ${p.birthDate}, passaporte ${p.documentNumber} válido até ${p.documentExpiry}`) };
    } catch (error) {
      return { error: error.message, expected: `${q.passengers} adulto(s) e ${q.children || 0} criança(s), adultos primeiro` };
    }
  }

  if (name === 'create_booking') {
    if (!state.quote || !state.passengers?.length || !state.contact) return { error: 'Faltam passos: voos, contacto e passageiros.' };
    if (!state.verified) return { error: 'O telemóvel ainda não foi confirmado.' };
    if (args.confirmed !== true) return { error: 'Pede ao cliente para confirmar os dados antes de criar a reserva.' };
    if (state.booking) return { reference: state.booking.reference, note: 'A reserva já foi criada.' };
    // A quote lasts 15 minutes: ask a new one (same signed offers, up to 30 minutes old).
    if (Date.parse(state.quote.expiresAt) - Date.now() < 60000) {
      const again = await prepareQuote(ctx, state.quote.itinerary, { silent: true });
      if (again.error) return again;
    }
    const body = {
      itinerary: state.quote.itinerary,
      quoteToken: state.quote.token,
      contact: { name: state.contact.name, email: state.contact.email },
      passengers: state.passengers,
      accept: true,
      paymentMethod: args.paymentMethod === 'manual' ? 'manual' : 'wiza',
      ...(args.invoiceNif ? { invoice: { nif: String(args.invoiceNif), name: cleanText(args.invoiceName, 120) } } : {}),
    };
    const result = await call(createBooking, inner(request, '/api/bookings', body, jar.cookie), env, deps.ctx, { ...deps, channel: 'ai' });
    if (!result.ok) return { error: result.data?.error || 'Não foi possível criar a reserva.' };
    state.booking = { reference: result.data.reference, paymentMethod: body.paymentMethod, amountAoa: result.data.amountAoa };
    conversation.status = 'booked';
    conversation.booking_reference = result.data.reference;
    cards.push({ type: 'payment', method: body.paymentMethod, reference: result.data.reference, amountKz: result.data.amountAoa, hostedUrl: result.data.hostedUrl || null, paymentError: result.data.paymentError || null });
    return {
      reference: result.data.reference,
      total: kzText(result.data.amountAoa),
      payment: body.paymentMethod === 'manual'
        ? 'Diz ao cliente para tocar agora no botão "Enviar para o WhatsApp" no cartão abaixo: a mensagem já leva a reserva e é assim que combina o pagamento com a equipa (a reserva fica 72 horas à espera). Não digas que a equipa vai contactar primeiro.'
        : result.data.hostedUrl ? 'O cliente toca em "Pagar" no cartão e autoriza no Multicaixa Express ou paga a referência.' : `O pagamento não abriu: ${result.data.paymentError || 'tenta de novo no cartão'}.`,
    };
  }
  return { error: `Ferramenta desconhecida: ${name}` };
}

async function prepareQuote(ctx, itinerary, { silent = false } = {}) {
  const { env, deps, request, state, cards } = ctx;
  const result = await call(quote, inner(request, '/api/checkout/quote', { itinerary }), env, deps.ctx, deps);
  if (!result.ok) return { error: result.data?.code === 'OFFER_EXPIRED' ? 'Os preços expiraram: pesquisa os voos de novo.' : result.data?.error || 'Não foi possível calcular o preço.' };
  state.quote = { token: result.data.quoteToken, amountAoa: result.data.amountAoa, expiresAt: result.data.expiresAt, lastTravelDate: result.data.lastTravelDate, query: result.data.query, itinerary };
  if (!silent) cards.push({ type: 'quote', amountKz: result.data.amountAoa, outbound: result.data.outbound, inbound: result.data.inbound, query: result.data.query, expiresAt: result.data.expiresAt });
  return { total: kzText(result.data.amountAoa), note: 'Preço final com taxas, para todos os passageiros. Passa ao contacto (nome, e-mail, telemóvel).' };
}

// ── The model ────────────────────────────────────────────────────────────────
async function complete(env, deps, messages) {
  const response = await (deps.fetcher || fetch)(OPENROUTER, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': env.PUBLIC_BASE_URL || 'https://www.dotviagens.com', 'X-Title': 'DOT Viagens' },
    body: JSON.stringify({ model: modelOf(env), messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.3, max_tokens: LIMITS.maxTokens, usage: { include: true } }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.choices?.[0]) throw new HttpError(502, 'A assistente não respondeu agora. Tenta de novo dentro de momentos.', `AI_${response.status}`);
  return data;
}

// History kept for the model: the last LIMITS.history messages, starting at a customer message.
function trimHistory(messages) {
  let list = messages.slice(-LIMITS.history);
  const start = list.findIndex(m => m.role === 'user');
  list = start > 0 ? list.slice(start) : list;
  return list;
}

// ── Limits ───────────────────────────────────────────────────────────────────
const luandaMidnight = () => new Date(`${luandaToday()}T00:00:00+01:00`).toISOString();
let dayCache = { until: 0, value: null };
async function dayTotals(store) {
  if (dayCache.until > Date.now()) return dayCache.value;
  const rows = await store.select('ai_conversations', { select: 'cost_usd,provider_searches', created_at: `gte.${luandaMidnight()}`, limit: 5000 }).catch(() => []);
  const value = { usd: rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0), searches: rows.reduce((s, r) => s + Number(r.provider_searches || 0), 0) };
  dayCache = { until: Date.now() + 20000, value };
  return value;
}
const busy = text => ({ text, cards: [{ type: 'whatsapp' }] });

// ── Routes ───────────────────────────────────────────────────────────────────
export function aiStatus(request, env) {
  return json({ enabled: hasAi(env) }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// POST /api/ai/chat {token?, message} -> {token, reply: {text, cards}}
export async function aiChat(request, env, ctx, deps) {
  assertSameOrigin(request);
  if (!hasAi(env)) throw new HttpError(503, 'A compra com IA não está disponível agora. Fala connosco no WhatsApp.', 'AI_DISABLED');
  const started = Date.now();
  const body = await readJson(request, 6000);
  const message = cleanText(body.message, LIMITS.messageChars);
  if (!message) throw new HttpError(400, 'Escreve a tua mensagem.', 'EMPTY');
  const store = db(env, deps.fetcher);
  const visitor = await deps.visitor(request);

  let conversation = null;
  let token = typeof body.token === 'string' && /^[A-Za-z0-9_-]{30,80}$/.test(body.token) ? body.token : null;
  if (token) conversation = await store.one('ai_conversations', { select: '*', token_hash: `eq.${await sha256Hex(token)}` });
  const today = luandaMidnight();
  const mine = await store.select('ai_conversations', { select: 'id,user_messages', visitor: `eq.${visitor}`, created_at: `gte.${today}`, limit: 50 }).catch(() => []);
  if (!conversation) {
    if (mine.length >= LIMITS.conversationsPerVisitor) return json({ token: null, reply: busy('Já fizeste muitas conversas hoje. Para continuar, fala connosco no WhatsApp.') });
    token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    [conversation] = await store.insert('ai_conversations', { token_hash: await sha256Hex(token), visitor, country: deps.country(request), city: deps.city(request), model: modelOf(env), messages: [], state: {} });
  }
  if (conversation.status === 'blocked') return json({ token, reply: busy('Esta conversa foi encerrada. Fala connosco no WhatsApp.') });
  if (conversation.user_messages >= LIMITS.userMessages || mine.reduce((s, r) => s + Number(r.user_messages || 0), 0) >= LIMITS.messagesPerVisitor) {
    return json({ token, reply: busy('Esta conversa chegou ao limite de mensagens. Continua connosco no WhatsApp, a equipa ajuda-te a terminar a compra.') });
  }
  const totals = await dayTotals(store);
  if (totals.usd >= dailyUsd(env) || totals.searches >= dailySearches(env)) {
    return json({ token, reply: busy('A assistente está muito ocupada hoje. Pesquisa os voos no site ou fala connosco no WhatsApp.') });
  }

  const state = conversation.state || {};
  const history = [...(conversation.messages || []), { role: 'user', content: message }];
  const cards = [];
  const jar = { cookie: request.headers.get('cookie') || '', setCookie: null };
  if (parseCookies(request)[SESSION_COOKIE] && !state.verified && state.contact) {
    const session = await getSession(request, env, deps).catch(() => null);
    if (session?.customer?.phone === state.contact.phone) state.verified = true;
  }
  const counters = { calendar_lookups: conversation.calendar_lookups, provider_searches: conversation.provider_searches, customer_id: conversation.customer_id, status: conversation.status, booking_reference: null };
  const toolCtx = { env, deps, request, state, conversation: counters, cards, jar };
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let text = '';
  let failure = null;
  try {
    for (let step = 0; step < LIMITS.steps; step++) {
      state.summary = summaryOf(state);
      const data = await complete(env, deps, [{ role: 'system', content: systemPrompt(state) }, ...trimHistory(history)]);
      tokensIn += Number(data.usage?.prompt_tokens || 0);
      tokensOut += Number(data.usage?.completion_tokens || 0);
      cost += Number(data.usage?.cost || 0);
      const reply = data.choices[0].message || {};
      const calls = (reply.tool_calls || []).slice(0, 3);
      if (!calls.length) {
        text = String(reply.content || '').trim();
        history.push({ role: 'assistant', content: text });
        break;
      }
      history.push({ role: 'assistant', content: reply.content || '', tool_calls: calls });
      for (const toolCall of calls) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          args = {};
        }
        const result = await runTool(toolCall.function?.name, args, toolCtx).catch(error => ({ error: error.message || 'Erro na ferramenta.' }));
        history.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result).slice(0, 6000) });
      }
      if (Date.now() - started > LIMITS.deadlineMs - 8000) {
        text = 'Ainda estou a tratar disto. Escreve "continuar" para eu terminar.';
        history.push({ role: 'assistant', content: text });
        break;
      }
    }
    if (!text) {
      text = 'Desculpa, não consegui terminar. Podes repetir de outra forma?';
      history.push({ role: 'assistant', content: text });
    }
  } catch (error) {
    failure = error.code || error.message;
    text = error instanceof HttpError ? error.message : 'A assistente não respondeu agora. Tenta de novo dentro de momentos.';
    history.push({ role: 'assistant', content: text });
  }
  // Without the passports and the code in the saved transcript? They are needed for the admin to check
  // the booking with the customer; the transcript keeps what was said (conversations without a
  // booking are deleted after 90 days).
  const patch = {
    messages: history.slice(-120),
    state,
    user_messages: conversation.user_messages + 1,
    provider_searches: counters.provider_searches,
    calendar_lookups: counters.calendar_lookups,
    tokens_in: conversation.tokens_in + tokensIn,
    tokens_out: conversation.tokens_out + tokensOut,
    cost_usd: Number(conversation.cost_usd || 0) + cost,
    customer_id: counters.customer_id || null,
    status: counters.status,
    last_error: failure,
  };
  if (counters.booking_reference) {
    const booking = await store.one('bookings', { select: 'id', reference: `eq.${counters.booking_reference}` }).catch(() => null);
    if (booking) patch.booking_id = booking.id;
  }
  await store.update('ai_conversations', { id: `eq.${conversation.id}` }, patch).catch(error => console.error('ai conversation not saved:', error.message));
  dayCache.until = 0;
  return json({ token, reply: { text, cards } }, 200, jar.setCookie ? { 'Set-Cookie': jar.setCookie } : {});
}

// ── Admin ────────────────────────────────────────────────────────────────────
export async function adminAi(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  const store = db(env, deps.fetcher);
  const since = days => new Date(Date.now() - days * 86400000).toISOString();
  const rows = await store.select('ai_conversations', {
    select: 'id,created_at,updated_at,visitor,country,city,status,model,user_messages,provider_searches,calendar_lookups,tokens_in,tokens_out,cost_usd,last_error,customer:customers(name,phone),booking:bookings(reference,status,amount_aoa)',
    created_at: `gte.${since(30)}`,
    order: 'created_at.desc',
    limit: 2000,
  });
  const sum = (list, key) => list.reduce((s, r) => s + Number(r[key] || 0), 0);
  const period = days => {
    const list = rows.filter(r => r.created_at >= (days === 0 ? luandaMidnight() : since(days)));
    const booked = list.filter(r => r.booking);
    return {
      conversations: list.length,
      messages: sum(list, 'user_messages'),
      searches: sum(list, 'provider_searches'),
      calendar: sum(list, 'calendar_lookups'),
      tokens: sum(list, 'tokens_in') + sum(list, 'tokens_out'),
      costUsd: Math.round(sum(list, 'cost_usd') * 10000) / 10000,
      bookings: booked.length,
      paid: booked.filter(r => ['paid', 'ticketed'].includes(r.booking.status)).length,
      revenueAoa: booked.filter(r => ['paid', 'ticketed'].includes(r.booking.status)).reduce((s, r) => s + Number(r.booking.amount_aoa || 0), 0),
    };
  };
  return json({
    periods: { today: period(0), week: period(7), month: period(30) },
    limits: { ...LIMITS, dailyUsd: dailyUsd(env), dailySearches: dailySearches(env) },
    model: modelOf(env),
    enabled: hasAi(env),
    conversations: rows.slice(0, 50),
  });
}

export async function adminAiConversation(request, env, ctx, deps) {
  await requireAdmin(request, env, deps);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deps.params[0])) throw new HttpError(404, 'Conversa não encontrada.', 'NOT_FOUND');
  const row = await db(env, deps.fetcher).one('ai_conversations', { select: '*,customer:customers(name,phone),booking:bookings(reference,status,amount_aoa)', id: `eq.${deps.params[0]}` });
  if (!row) throw new HttpError(404, 'Conversa não encontrada.', 'NOT_FOUND');
  const transcript = (row.messages || []).flatMap(m => {
    if (m.role === 'user') return [{ role: 'user', text: String(m.content || '') }];
    if (m.role === 'assistant') return [...(m.tool_calls || []).map(call => ({ role: 'tool', text: call.function?.name || 'ferramenta' })), ...(m.content ? [{ role: 'assistant', text: String(m.content) }] : [])];
    return [];
  });
  const conversation = Object.fromEntries(Object.entries(row).filter(([key]) => !['messages', 'state', 'token_hash'].includes(key)));
  return json({ conversation, transcript });
}
