// Cities with more than one airport ("Moscovo (todos os aeroportos)": SVO, DME, VKO e ZIA). A city is
// searched airport by airport, like a country (server/flights.mjs), and its code in the address is
// the list of its airports ("SVO,DME,VKO,ZIA"), up to 4, the busiest first.
// 1. METROS: the cities the catalogue splits under different names (OurAirports writes "Newark",
//    "Narita", "Ferno (VA)"...), with the IATA metropolitan area of each one, in Portuguese.
// 2. The other cities with 2 or more airports of the same name in airports.json, keeping only the
//    airports with at least 200 000 passengers a year (Wikidata P3872, CC0): no airfields.
// Run after build-airport-index.mjs: node scripts/build-city-airports.mjs
// Writes server/city-airports.mjs and public/city-airports.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_AIRPORTS = 4;
const MIN_PASSENGERS = 200000;
const METROS = [
  ['Londres', 'GB', ['LHR', 'LGW', 'STN', 'LTN', 'LCY']],
  ['Paris', 'FR', ['CDG', 'ORY', 'BVA']],
  ['Nova Iorque', 'US', ['JFK', 'EWR', 'LGA']],
  ['Moscovo', 'RU', ['SVO', 'DME', 'VKO', 'ZIA']],
  ['Tóquio', 'JP', ['HND', 'NRT']],
  ['Osaka', 'JP', ['KIX', 'ITM', 'UKB']],
  ['Milão', 'IT', ['MXP', 'BGY', 'LIN']],
  ['Roma', 'IT', ['FCO', 'CIA']],
  ['Veneza', 'IT', ['VCE', 'TSF']],
  ['São Paulo', 'BR', ['GRU', 'CGH', 'VCP']],
  ['Rio de Janeiro', 'BR', ['GIG', 'SDU']],
  ['Belo Horizonte', 'BR', ['CNF', 'PLU']],
  ['Istambul', 'TR', ['IST', 'SAW']],
  ['Dubai', 'AE', ['DXB', 'DWC']],
  ['Pequim', 'CN', ['PEK', 'PKX']],
  ['Xangai', 'CN', ['PVG', 'SHA']],
  ['Seul', 'KR', ['ICN', 'GMP']],
  ['Banguecoque', 'TH', ['BKK', 'DMK']],
  ['Jacarta', 'ID', ['CGK', 'HLP']],
  ['Kuala Lumpur', 'MY', ['KUL', 'SZB']],
  ['Taipé', 'TW', ['TPE', 'TSA']],
  ['Teerão', 'IR', ['IKA', 'THR']],
  ['Buenos Aires', 'AR', ['EZE', 'AEP']],
  ['Cidade do México', 'MX', ['MEX', 'NLU']],
  ['Estocolmo', 'SE', ['ARN', 'BMA', 'NYO']],
  ['Oslo', 'NO', ['OSL', 'TRF', 'RYG']],
  ['Bruxelas', 'BE', ['BRU', 'CRL']],
  ['Bucareste', 'RO', ['OTP', 'BBU']],
  ['Belfast', 'GB', ['BFS', 'BHD']],
  ['Washington', 'US', ['IAD', 'DCA', 'BWI']],
  ['Chicago', 'US', ['ORD', 'MDW']],
  ['Houston', 'US', ['IAH', 'HOU']],
  ['Dallas', 'US', ['DFW', 'DAL']],
  ['Los Angeles', 'US', ['LAX', 'BUR', 'LGB', 'SNA']],
  ['São Francisco', 'US', ['SFO', 'OAK', 'SJC']],
  ['Miami', 'US', ['MIA', 'FLL']],
  ['Toronto', 'CA', ['YYZ', 'YTZ']],
  ['Joanesburgo', 'ZA', ['JNB', 'HLA']],
  ['Melbourne', 'AU', ['MEL', 'AVV']],
];

const airports = JSON.parse(readFileSync(join(ROOT, 'public', 'airports.json'), 'utf8'));
const byCode = new Map(airports.map(a => [a.code, a]));
const sparql = 'SELECT ?iata (MAX(?pax) AS ?p) (SAMPLE(?coord) AS ?c) WHERE { ?a wdt:P238 ?iata . ?a wdt:P3872 ?pax . OPTIONAL { ?a wdt:P625 ?coord . } } GROUP BY ?iata';
const response = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
  headers: { 'User-Agent': 'DOT-Viagens-build/1.0 (https://www.dotviagens.com)', Accept: 'application/sparql-results+json' },
  signal: AbortSignal.timeout(120000),
});
if (!response.ok) throw new Error(`Wikidata respondeu ${response.status}`);
const bindings = (await response.json()).results.bindings;
const passengers = new Map(bindings.map(b => [b.iata.value, Number(b.p.value) || 0]));
const where = new Map(bindings.map(b => [b.iata.value, b.c?.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/)]).filter(([, m]) => m).map(([code, m]) => [code, { lon: Number(m[1]), lat: Number(m[2]) }]));
// Same name is not the same city (Portland, Oregon and Portland, Maine): at most 80 km apart.
const km = (a, b) => { const r = Math.PI / 180; const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
const near = (a, b) => where.has(a) && where.has(b) && km(where.get(a), where.get(b)) <= 80;

const groups = [];
const taken = new Set();
for (const [name, country, codes] of METROS) {
  const list = codes.filter(code => byCode.get(code)?.countryCode === country).slice(0, MAX_AIRPORTS);
  if (list.length < 2) continue;
  groups.push({ name, country, airports: list });
  list.forEach(code => taken.add(code));
}
const cityKey = a => `${a.countryCode}|${a.city.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*[(,].*$/, '').trim()}`;
const same = new Map();
for (const a of airports) {
  if (taken.has(a.code) || (passengers.get(a.code) || 0) < MIN_PASSENGERS) continue;
  same.set(cityKey(a), [...(same.get(cityKey(a)) || []), a]);
}
for (const list of same.values()) {
  if (list.length < 2) continue;
  const ranked = list.sort((a, b) => (passengers.get(b.code) || 0) - (passengers.get(a.code) || 0));
  const sorted = ranked.filter((a, index) => index === 0 || near(ranked[0].code, a.code)).slice(0, MAX_AIRPORTS);
  if (sorted.length < 2) continue;
  groups.push({ name: sorted[0].city.replace(/\s*[(,].*$/, '').trim(), country: sorted[0].countryCode, airports: sorted.map(a => a.code) });
}
groups.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
const rows = groups.map(g => ({ code: g.airports.join(','), ...g }));
writeFileSync(join(ROOT, 'server', 'city-airports.mjs'), `// Generated by scripts/build-city-airports.mjs. Do not edit by hand.
// Cities with more than one airport: code ("SVO,DME,VKO,ZIA") -> name, country and airports.
export const cityGroups=new Map(${JSON.stringify(rows.map(({ code, name, country, airports: list }) => [code, { name, country, airports: list }]))});
`);
writeFileSync(join(ROOT, 'public', 'city-airports.js'), `// Generated by scripts/build-city-airports.mjs. Do not edit by hand.
// Cities with more than one airport, offered as "Moscovo (todos os aeroportos)" in the search box.
export const CITY_GROUPS = ${JSON.stringify(rows)};
`);
// City of every airport, for the server's e-mails (the Portuguese names of the popular list win).
const { POPULAR } = await import(new URL('../public/airports-popular.js', import.meta.url));
const cityOf = new Map(airports.map(a => [a.code, a.city.replace(/\s*[(,].*$/, '').trim()]));
for (const a of POPULAR) cityOf.set(a.code, a.city.replace(/\s*[(,].*$/, '').trim());
// Also the country and the name of each airport, for the airport search of the AI chat (server/ai.mjs).
const infoOf = airports.map(a => [a.code, cityOf.get(a.code), a.countryCode, a.name]);
writeFileSync(join(ROOT, 'server', 'airport-names.mjs'), `// Generated by scripts/build-city-airports.mjs. Do not edit by hand.
// City of each airport (IATA code -> city), used in the e-mails.
export const airportCity=new Map(${JSON.stringify([...cityOf])});
// [code, city, country (ISO), airport name] of every airport, for the AI chat's airport search.
export const airportInfo=${JSON.stringify(infoOf)};
`);
console.log(`city-airports: ${rows.length} cidades (${groups.filter(g => METROS.some(m => m[0] === g.name)).length} da lista METROS)`);
console.log(rows.map(r => `${r.name}=${r.code}`).join('  '));
