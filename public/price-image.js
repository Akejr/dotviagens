// Admin "Imagem de preços" (public/admin.js, server/price-image.mjs): the cheapest days of a month
// drawn on a canvas, 1080 px wide, to send to a customer: header with the route, the month's calendar
// with the price of each day, the cheapest days with their airline and the DOT footer.

import { formatKz } from './api.js';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const fmtNumber = value => new Intl.NumberFormat('pt-AO').format(Number(value) || 0);
const plural = (n, one, many) => `${fmtNumber(n)} ${Number(n) === 1 ? one : many}`;
const hourLuanda = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Luanda' });
const IMAGE_WEEK = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const IMAGE_WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const IMAGE_MONTH = new Intl.DateTimeFormat('pt-PT', { month: 'long', timeZone: 'UTC' });
export const IMAGE_CABIN = { economy: 'Económica', premium_economy: 'Económica premium', business: 'Executiva', first: 'Primeira' };
const IMAGE_BRAND = [[0, '#ffad00'], [0.38, '#ff8500'], [0.76, '#ff5900'], [1, '#ed4600']];

const imageDay = iso => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${IMAGE_WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const stopsText = (stops, roundTrip) => {
  if (stops == null) return '';
  if (!stops) return roundTrip ? 'ida directa' : 'directo';
  const text = plural(stops, 'escala', 'escalas');
  return roundTrip ? `ida com ${text}` : text;
};
const loadImage = src => new Promise(resolve => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => resolve(null);
  image.src = src;
});
const brandFill = (g, x, y, w, h) => {
  const gradient = g.createLinearGradient(x, y, x + w, y + h);
  IMAGE_BRAND.forEach(([stop, colour]) => gradient.addColorStop(stop, colour));
  return gradient;
};
// Largest font size (down to 12 px) at which the text fits the width.
function fitFont(g, text, width, size, weight, family) {
  let px = size;
  for (; px > 12; px -= 1) {
    g.font = `${weight} ${px}px ${family}`;
    if (g.measureText(text).width <= width) break;
  }
  return px;
}

export async function drawPriceImage({ query, days, best, generatedAt }, cityName = code => code) {
  await Promise.all(['800 64px Manrope', '700 26px Manrope', '600 22px "DM Sans"', '500 22px "DM Sans"'].map(font => document.fonts.load(font).catch(() => null)));
  const roundTrip = query.type === 'return';
  const W = 1080;
  const PAD = 56;
  const [year, month] = query.month.split('-').map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((lead + count) / 7);
  const listed = best.filter(b => b.exact);
  const cellH = 112;
  const gap = 10;
  const calTop = 290;
  const gridTop = calTop + 92;
  const calH = 92 + weeks * (cellH + gap) - gap + 92;
  const listTop = calTop + calH + 40;
  const rowH = 108;
  const listH = listed.length ? 70 + listed.length * (rowH + 12) : 0;
  const H = listTop + listH + 150;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const MANROPE = 'Manrope, sans-serif';
  const DM = '"DM Sans", sans-serif';

  g.fillStyle = '#faf9f6';
  g.fillRect(0, 0, W, H);
  g.fillStyle = brandFill(g, 0, 0, W, 14);
  g.fillRect(0, 0, W, 14);
  const logo = await loadImage('/assets/logo-dot-320.png');
  if (logo) g.drawImage(logo, PAD, 60, 168, 168 * logo.height / logo.width);

  // Month pill (top right).
  const monthName = IMAGE_MONTH.format(new Date(Date.UTC(year, month - 1, 15)));
  const pill = `${monthName[0].toUpperCase()}${monthName.slice(1)} ${year}`;
  g.font = `750 26px ${MANROPE}`;
  const pillW = g.measureText(pill).width + 48;
  g.beginPath();
  g.roundRect(W - PAD - pillW, 62, pillW, 54, 27);
  g.fillStyle = '#fff1d9';
  g.fill();
  g.strokeStyle = '#ffc58e';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#ad4100';
  g.textAlign = 'center';
  g.fillText(pill, W - PAD - pillW / 2, 98);

  // Route and trip.
  g.textAlign = 'left';
  g.fillStyle = '#262820';
  const route = `${cityName(query.origin)} → ${cityName(query.destination)}`;
  fitFont(g, route, W - 2 * PAD, 66, 800, MANROPE);
  g.fillText(route, PAD, 200);
  const trip = [
    roundTrip ? `Ida e volta de ${query.minDays === query.maxDays ? `${query.minDays} dias` : `${query.minDays} a ${query.maxDays} dias`}` : 'Só ida',
    IMAGE_CABIN[query.cabin] || 'Económica',
    query.passengers === 1 ? 'preço por pessoa' : `preço total para ${query.passengers} adultos`,
  ].join(' · ');
  g.fillStyle = '#777b73';
  fitFont(g, trip, W - 2 * PAD, 28, 500, DM);
  g.fillText(trip, PAD, 248);

  // Calendar card.
  g.save();
  g.shadowColor = 'rgba(43, 36, 26, 0.08)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 8;
  g.beginPath();
  g.roundRect(40, calTop, W - 80, calH, 32);
  g.fillStyle = '#fff';
  g.fill();
  g.restore();
  const x0 = 68;
  const cellW = (W - 136 - 6 * gap) / 7;
  g.font = `650 22px ${DM}`;
  g.fillStyle = '#9a9f92';
  g.textAlign = 'center';
  IMAGE_WEEK.forEach((name, col) => g.fillText(name, x0 + col * (cellW + gap) + cellW / 2, calTop + 62));
  const byDate = new Map(days.map(d => [d.date, d]));
  const listedDates = new Set(listed.map(b => b.date));
  const cheapest = listed[0]?.date || [...days].sort((a, b) => a.priceKz - b.priceKz)[0]?.date;
  const varied = roundTrip && query.minDays !== query.maxDays;
  for (let i = 0; i < count; i++) {
    const index = lead + i;
    const x = x0 + (index % 7) * (cellW + gap);
    const y = gridTop + Math.floor(index / 7) * (cellH + gap);
    const iso = `${query.month}-${String(i + 1).padStart(2, '0')}`;
    const day = byDate.get(iso);
    const top = iso === cheapest;
    const marked = !top && listedDates.has(iso);
    g.beginPath();
    g.roundRect(x, y, cellW, cellH, 18);
    g.fillStyle = top ? brandFill(g, x, y, cellW, cellH) : marked ? '#fff1e3' : day ? '#faf9f6' : '#f6f5f1';
    g.fill();
    if (!top) {
      g.strokeStyle = marked ? '#ffc58e' : '#ecebe5';
      g.lineWidth = marked ? 2 : 1;
      g.stroke();
    }
    g.textAlign = 'left';
    g.font = `650 22px ${DM}`;
    g.fillStyle = top ? '#fff' : day ? '#262820' : '#c3c5bd';
    g.fillText(String(i + 1), x + 14, y + 32);
    if (day && varied && day.nights) {
      g.textAlign = 'right';
      g.font = `500 16px ${DM}`;
      g.fillStyle = top ? 'rgba(255,255,255,.9)' : '#9a9f92';
      g.fillText(`${day.nights} dias`, x + cellW - 12, y + 31);
    }
    g.textAlign = 'center';
    if (day) {
      const text = fmtNumber(day.priceKz);
      fitFont(g, text, cellW - 20, 24, 800, MANROPE);
      g.fillStyle = top ? '#fff' : marked ? '#ad4100' : '#262820';
      g.fillText(text, x + cellW / 2, y + cellH - 24);
    } else if (iso >= query.start) {
      g.font = `500 20px ${DM}`;
      g.fillStyle = '#c3c5bd';
      g.fillText('sem preço', x + cellW / 2, y + cellH - 26);
    }
  }
  // Legend.
  const legendY = gridTop + weeks * (cellH + gap) - gap + 50;
  let lx = x0;
  const swatch = (fill, stroke, label) => {
    g.beginPath();
    g.roundRect(lx, legendY - 19, 24, 24, 7);
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = 2;
      g.stroke();
    }
    g.textAlign = 'left';
    g.font = `500 20px ${DM}`;
    g.fillStyle = '#5f6457';
    g.fillText(label, lx + 34, legendY);
    lx += 34 + g.measureText(label).width + 30;
  };
  swatch(brandFill(g, lx, legendY - 19, 24, 24), null, 'Mais barato');
  if (listed.length > 1) swatch('#fff1e3', '#ffc58e', 'Mais baratos a seguir');
  g.textAlign = 'right';
  g.font = `500 20px ${DM}`;
  g.fillStyle = '#9a9f92';
  g.fillText('Valores em Kz', W - 68, legendY);

  // Cheapest days with the airline.
  if (listed.length) {
    g.textAlign = 'left';
    g.fillStyle = '#262820';
    g.font = `800 36px ${MANROPE}`;
    g.fillText(listed.length === 1 ? 'O dia mais barato' : 'Os dias mais baratos', PAD, listTop + 40);
    for (const [index, item] of listed.entries()) {
      const y = listTop + 70 + index * (rowH + 12);
      g.beginPath();
      g.roundRect(40, y, W - 80, rowH, 24);
      g.fillStyle = '#fff';
      g.fill();
      g.strokeStyle = index === 0 ? '#ffb877' : '#ecebe5';
      g.lineWidth = index === 0 ? 2.5 : 1;
      g.stroke();
      const cy = y + rowH / 2;
      const images = (await Promise.all((item.logos || []).slice(0, 2).map(loadImage))).filter(Boolean);
      const circles = Math.max(1, images.length);
      for (let c = circles - 1; c >= 0; c--) {
        const cx = 98 + c * 38;
        g.save();
        g.beginPath();
        g.arc(cx, cy, 32, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.strokeStyle = '#ecebe5';
        g.lineWidth = 2;
        g.stroke();
        g.clip();
        if (images[c]) g.drawImage(images[c], cx - 23, cy - 23, 46, 46);
        else {
          g.fillStyle = '#ef5900';
          g.font = `800 22px ${MANROPE}`;
          g.textAlign = 'center';
          g.fillText((item.airlines?.[0] || 'DOT').slice(0, 2).toUpperCase(), cx, cy + 8);
        }
        g.restore();
      }
      const textX = 98 + (circles - 1) * 38 + 56;
      const price = formatKz(item.priceKz);
      g.font = `800 34px ${MANROPE}`;
      const priceW = g.measureText(price).width;
      g.textAlign = 'right';
      g.fillStyle = '#ef5900';
      g.fillText(price, W - 68, cy + 12);
      const room = W - 68 - priceW - 28 - textX;
      g.textAlign = 'left';
      g.fillStyle = '#262820';
      const names = (item.airlines || []).length > 1 ? `${item.airlines.slice(0, -1).join(', ')} e ${item.airlines.at(-1)}` : item.airlines?.[0] || 'Companhia por confirmar';
      fitFont(g, names, room, 27, 750, MANROPE);
      g.fillText(names, textX, cy - 6);
      const facts = [roundTrip && item.returnDate ? `${imageDay(item.date)} → ${imageDay(item.returnDate)}` : imageDay(item.date), roundTrip && item.nights ? `${item.nights} dias` : '', stopsText(item.stops, roundTrip)].filter(Boolean).join(' · ');
      g.fillStyle = '#777b73';
      fitFont(g, facts, room, 21, 500, DM);
      g.fillText(facts, textX, cy + 28);
    }
  }

  // Footer band.
  g.fillStyle = brandFill(g, 0, H - 120, W, 120);
  g.fillRect(0, H - 120, W, 120);
  g.fillStyle = '#fff';
  g.textAlign = 'left';
  g.font = `800 32px ${MANROPE}`;
  g.fillText('Compra em dotviagens.com', PAD, H - 66);
  g.font = `500 19px ${DM}`;
  g.fillStyle = 'rgba(255,255,255,.92)';
  const at = new Date(generatedAt);
  const atDay = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeZone: 'Africa/Luanda' }).format(at);
  g.fillText(`Preços consultados a ${atDay} às ${hourLuanda.format(at)}. Podem mudar até à compra.`, PAD, H - 32);
  g.textAlign = 'right';
  g.font = `700 24px ${DM}`;
  g.fillStyle = '#fff';
  g.fillText('WhatsApp +244 931 343 433', W - PAD, H - 66);
  return canvas;
}
