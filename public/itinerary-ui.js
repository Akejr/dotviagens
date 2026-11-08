// Shared flight presentation: airline logos (paired when a trip mixes airlines)
// and the itinerary timeline used by the results page and the checkout.

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const LOGO_HOST = 'https://www.gstatic.com/flights/airline_logos/';
const safeLogo = url => (typeof url === 'string' && url.startsWith(LOGO_HOST) && !/\/multi\.png$/i.test(url) ? url : null);
const list = new Intl.ListFormat('pt-PT', { style: 'long', type: 'conjunction' });
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export const duration = minutes => `${Math.floor((minutes || 0) / 60)}h ${(minutes || 0) % 60}min`;
export function longDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} ${hours === 1 ? 'hora' : 'horas'}` : '', rest ? `${rest} ${rest === 1 ? 'minuto' : 'minutos'}` : ''].filter(Boolean).join(' e ') || '0 minutos';
}
const shortDay = value => {
  const [, month, day] = String(value || '').slice(0, 10).split('-').map(Number);
  return month ? `${day} ${MONTHS[month - 1]}` : '';
};
const clock = value => String(value || '').slice(11, 16);
const dayShift = (from, to) => Math.round((Date.parse(String(to).slice(0, 10)) - Date.parse(String(from).slice(0, 10))) / 86400000);

// Distinct airlines of a leg, in flight order, each with its own logo.
export function legAirlines(leg) {
  const seen = new Map();
  for (const segment of leg?.segments || []) if (segment.airline && !seen.has(segment.airline)) seen.set(segment.airline, safeLogo(segment.logo));
  if (!seen.size && leg?.airline) seen.set(leg.airline, safeLogo(leg.logo));
  if (seen.size === 1 && ![...seen.values()][0]) {
    const [name] = seen.keys();
    seen.set(name, safeLogo(leg?.logo));
  }
  return [...seen].map(([name, logo]) => ({ name, logo }));
}

export const airlineNames = leg => list.format(legAirlines(leg).map(airline => airline.name)) || leg?.airline || '';

function logoTag({ name, logo }) {
  return logo
    ? `<img class="airline-logo" src="${esc(logo)}" alt="${esc(name)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="logo-fallback" aria-label="${esc(name)}">${esc((name || 'AV').slice(0, 2).toUpperCase())}</span>`;
}

// One logo, or two overlapping logos (with "+N" when there are more airlines).
export function airlineMark(leg) {
  const airlines = legAirlines(leg);
  if (airlines.length <= 1) return logoTag(airlines[0] || { name: leg?.airline || 'AV', logo: null });
  const extra = airlines.length - 2;
  return `<span class="airline-pair" role="img" aria-label="${esc(list.format(airlines.map(a => a.name)))}" title="${esc(list.format(airlines.map(a => a.name)))}">${logoTag(airlines[0])}${logoTag(airlines[1])}${extra > 0 ? `<i class="pair-more">+${extra}</i>` : ''}</span>`;
}

// Vertical itinerary: departure and arrival of each flight, with the connections between them.
export function legTimeline(leg, { city = code => code, airport = () => '', cabin } = {}) {
  const segments = leg?.segments || [];
  const first = segments[0]?.departure;
  const rows = [];
  segments.forEach((segment, index) => {
    const shift = first ? dayShift(first, segment.arrival) : 0;
    const departShift = first ? dayShift(first, segment.departure) : 0;
    rows.push(`<li class="tl-stop"><span class="tl-time">${esc(clock(segment.departure))}${departShift > 0 ? `<sup>+${departShift}</sup>` : ''}</span><span class="tl-rail" aria-hidden="true"></span>
      <div class="tl-body"><strong>${esc(city(segment.from))} (${esc(segment.from)})</strong><small>${esc([airport(segment.from), shortDay(segment.departure)].filter(Boolean).join(' · '))}</small></div></li>`);
    rows.push(`<li class="tl-flight"><span class="tl-time"></span><span class="tl-rail" aria-hidden="true"></span>
      <div class="tl-body">${logoTag({ name: segment.airline, logo: safeLogo(segment.logo) })}<div><strong>${esc(segment.airline)} · ${esc(segment.number)}</strong><small>${duration(segment.duration)}${cabin || leg.cabin ? ` · ${esc(cabin || leg.cabin)}` : ''}</small></div></div></li>`);
    rows.push(`<li class="tl-stop"><span class="tl-time">${esc(clock(segment.arrival))}${shift > 0 ? `<sup>+${shift}</sup>` : ''}</span><span class="tl-rail" aria-hidden="true"></span>
      <div class="tl-body"><strong>${esc(city(segment.to))} (${esc(segment.to)})</strong><small>${esc([airport(segment.to), shortDay(segment.arrival)].filter(Boolean).join(' · '))}</small></div></li>`);
    const layover = leg.layovers?.[index];
    if (layover && index < segments.length - 1) {
      const name = layover.airport || segment.to;
      rows.push(`<li class="tl-layover"><span class="tl-time"></span><span class="tl-rail" aria-hidden="true"></span>
        <div class="tl-body"><span class="connection-icon" aria-hidden="true">◷</span><div>Conexão de <strong>${longDuration(layover.duration)}</strong> em <strong>${esc(city(name))}</strong><small>(${esc(airport(name) || layover.name || name)})${layover.overnight ? ' · Durante a noite' : ''}</small></div></div></li>`);
    }
  });
  return `<ol class="timeline">${rows.join('')}</ol>`;
}
