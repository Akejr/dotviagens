// Main airports of each country for the searches to a whole country ("Portugal (todos os aeroportos)").
// SearchApi answers Google's multi-airport searches with a short or empty list, so the server searches
// these airports one by one and merges them (server/flights.mjs). Up to 3 per country:
// 1. the first cities Google Flights suggests for the country name (google_flights_location_search:
//    Portugal -> Lisboa, Porto, Faro), the first airport Google lists for each city, or its
//    international gateway when the city has several (GATEWAYS: Istanbul -> IST, not SAW);
// 2. the busiest airport of the country (passengers per year, Wikidata P3872, CC0) comes first when
//    none of those cities has it (Alemanha: Frankfurt, then Berlim and Munique).
// Only airports of that country that are in airports.json.
// The Google suggestions cost 1 SearchApi search per country (~190); they are kept in
// node_modules/.cache/dot-country-suggestions.json and asked again only with --refresh.
// Run after build-airport-index.mjs: node scripts/build-main-airports.mjs [--refresh]
// (SEARCHAPI_KEY from the environment or from .dev.vars). Writes server/main-airports.mjs and
// public/main-airports.js.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PER_COUNTRY = 3;
const CACHE = join(ROOT, 'node_modules', '.cache', 'dot-country-suggestions.json');

const { countryPlaces } = await import(new URL('../server/airport-codes.mjs', import.meta.url));
const countryOf = new Map(JSON.parse(readFileSync(join(ROOT, 'public', 'airports.json'), 'utf8')).map(a => [a.code, a.countryCode]));
const countries = [...countryPlaces.keys()].sort();

// Passengers per year of each airport (the highest value Wikidata has).
const sparql = 'SELECT ?iata (MAX(?pax) AS ?p) WHERE { ?a wdt:P238 ?iata . ?a wdt:P3872 ?pax . } GROUP BY ?iata';
const wikidata = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
  headers: { 'User-Agent': 'DOT-Viagens-build/1.0 (https://www.dotviagens.com)', Accept: 'application/sparql-results+json' },
  signal: AbortSignal.timeout(120000),
});
if (!wikidata.ok) throw new Error(`Wikidata respondeu ${wikidata.status}`);
const passengers = new Map((await wikidata.json()).results.bindings.map(b => [b.iata.value, Number(b.p.value) || 0]));

// Google Flights suggestions for each country name (kept in the cache between runs).
let suggestions = {};
if (existsSync(CACHE) && !process.argv.includes('--refresh')) suggestions = JSON.parse(readFileSync(CACHE, 'utf8'));
const missingSuggestions = countries.filter(country => !(country in suggestions));
let calls = 0;
if (missingSuggestions.length) {
  const fromFile = () => {
    const file = join(ROOT, '.dev.vars');
    if (!existsSync(file)) return '';
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.startsWith('SEARCHAPI_KEY='));
    return line ? line.slice('SEARCHAPI_KEY='.length).trim() : '';
  };
  const key = process.env.SEARCHAPI_KEY || fromFile();
  if (!key) throw new Error('Falta SEARCHAPI_KEY (ambiente ou .dev.vars).');
  const ask = async (name, hl) => {
    const url = new URL('https://www.searchapi.io/api/v1/search');
    url.search = new URLSearchParams({ engine: 'google_flights_location_search', q: name, hl, gl: 'pt', api_key: key }).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        calls++;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) return ((await response.json()).locations || []).map(l => (l.airports || []).map(a => a.airport_code).filter(Boolean));
      } catch {
        // One more attempt below.
      }
    }
    return [];
  };
  const names = { pt: new Intl.DisplayNames(['pt'], { type: 'region' }), en: new Intl.DisplayNames(['en'], { type: 'region' }) };
  const inCountry = (cities, country) => cities.some(city => city.some(code => countryOf.get(code) === country));
  for (let i = 0; i < missingSuggestions.length; i += 4) {
    await Promise.all(missingSuggestions.slice(i, i + 4).map(async country => {
      let cities = await ask(names.pt.of(country), 'pt');
      // Some Portuguese names point elsewhere first (Geórgia, the US state): try the English name.
      if (!inCountry(cities, country)) cities = await ask(names.en.of(country), 'en');
      suggestions[country] = cities;
    }));
  }
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(suggestions));
}

// International gateway of cities with several airports, where Google lists another one first
// (or the passenger counts favour a domestic airport): Istanbul, Seoul, Buenos Aires, Rio, ...
const GATEWAYS = new Set(['IST', 'ICN', 'EZE', 'GIG', 'GRU', 'BKK', 'SVO', 'IKA', 'TPE', 'CGK', 'KUL', 'MXP', 'IAD']);
const busiest = codes => [...codes].sort((a, b) => (passengers.get(b) || 0) - (passengers.get(a) || 0))[0];
const result = new Map();
for (const country of countries) {
  const ours = code => countryOf.get(code) === country;
  const picked = [];
  const covered = new Set();
  for (const city of suggestions[country] || []) {
    const codes = city.filter(ours);
    const code = codes.find(c => GATEWAYS.has(c)) || codes[0];
    if (!code || picked.includes(code)) continue;
    picked.push(code);
    codes.forEach(c => covered.add(c));
    if (picked.length === PER_COUNTRY) break;
  }
  const all = [...countryOf.keys()].filter(ours);
  const hub = busiest(all);
  if (passengers.get(hub) && !covered.has(hub)) picked.unshift(hub);
  // Neither Google nor Wikidata helped (Catar): the country's airports, busiest first.
  if (!picked.length) picked.push(...[...all].sort((a, b) => (passengers.get(b) || 0) - (passengers.get(a) || 0)));
  if (picked.length) result.set(country, picked.slice(0, PER_COUNTRY));
}
const entries = [...result].sort(([a], [b]) => a.localeCompare(b));
const missing = countries.filter(c => !result.has(c));
writeFileSync(join(ROOT, 'server', 'main-airports.mjs'), `// Generated by scripts/build-main-airports.mjs. Do not edit by hand.
// Main airports of each country, searched one by one in a search to the whole country.
// A country missing here is searched with its Google location id (server/places.mjs).
export const mainAirports=new Map(${JSON.stringify(entries)});
`);
writeFileSync(join(ROOT, 'public', 'main-airports.js'), `// Generated by scripts/build-main-airports.mjs. Do not edit by hand.
// Airports compared in a search to the whole country (shown in the search box and in the results).
export const MAIN_AIRPORTS = new Map(${JSON.stringify(entries)});
`);
console.log(`main-airports: ${entries.length} países (${calls} pesquisas na SearchApi)${missing.length ? `; sem aeroportos principais: ${missing.join(' ')}` : ''}`);
