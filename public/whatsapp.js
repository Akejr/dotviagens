// Manual payment: WhatsApp link to the DOT team with the booking already written in the message.
// Used by the checkout (after saving the booking), the status page and Minhas viagens.
import { formatKz, formatPhone } from './api.js';

export const DOT_WHATSAPP = '244931343433';

export const whatsappLink = text => `https://wa.me/${DOT_WHATSAPP}?text=${encodeURIComponent(text)}`;

const longDay = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayOf = value => String(value || '').slice(0, 10);
const clock = value => String(value || '').slice(11, 16);
const dayShift = (from, to) => Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${dayOf(from)}T00:00:00Z`)) / 86400000) || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function legLines(leg, label) {
  const first = leg?.segments?.[0];
  const last = leg?.segments?.at(-1);
  if (!first || !last) return [];
  const shift = dayShift(first.departure, last.arrival);
  const stops = leg.stops ? plural(leg.stops, 'escala', 'escalas') : 'voo directo';
  const day = longDay.format(new Date(`${dayOf(first.departure)}T12:00:00Z`));
  return [
    `*${label}* · ${day}`,
    `${clock(first.departure)} ${first.from} → ${clock(last.arrival)}${shift > 0 ? ` (+${shift})` : ''} ${last.to} · ${stops}`,
    leg.segments.map(segment => `${segment.airline} ${segment.number}`.trim()).join(' · '),
  ];
}

// booking: { reference, origin, destination, outbound, inbound, passengers: [{ givenNames, surname }],
//            passengersCount, amountAoa, contact: { name, phone } }; city(code) gives the city name.
export function bookingMessage(booking, city = code => code) {
  const count = booking.passengersCount || booking.passengers?.length || 1;
  const route = `${city(booking.origin)} (${booking.origin}) → ${city(booking.destination)} (${booking.destination})`;
  const lines = [
    'Olá, DOT Viagens! Quero pagar a minha reserva com pagamento manual.',
    '',
    `*Reserva ${booking.reference}*`,
    `${route} · ${booking.inbound ? 'ida e volta' : 'só ida'} · ${plural(count, 'adulto', 'adultos')}`,
    '',
    ...legLines(booking.outbound, 'Ida'),
  ];
  if (booking.inbound) lines.push('', ...legLines(booking.inbound, 'Volta'));
  const names = (booking.passengers || []).map(p => `${p.givenNames || ''} ${p.surname || ''}`.trim()).filter(Boolean);
  if (names.length) lines.push('', '*Passageiros*', ...names.map((name, index) => `${index + 1}. ${name}`));
  lines.push('', `*Total:* ${formatKz(booking.amountAoa)}`);
  const contact = [booking.contact?.name, booking.contact?.phone ? formatPhone(booking.contact.phone) : ''].filter(Boolean).join(' · ');
  if (contact) lines.push(`Contacto: ${contact}`);
  return lines.join('\n');
}

// Same message from a booking returned by the API (status page, Minhas viagens).
export const bookingLink = (booking, city) => whatsappLink(bookingMessage({
  reference: booking.reference,
  origin: booking.origin,
  destination: booking.destination,
  outbound: booking.itinerary?.outbound,
  inbound: booking.itinerary?.inbound,
  passengers: booking.passengers,
  passengersCount: booking.passengersCount,
  amountAoa: booking.amountAoa,
  contact: booking.contact,
}, city));
