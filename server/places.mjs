// Search places: an airport (IATA code) or a whole country (ISO code, "todos os aeroportos").
import { airports, countryPlaces } from './airport-codes.mjs';
import { mainAirports as MAIN } from './main-airports.mjs';

export const isCountry = code => countryPlaces.has(code);
export const isPlace = code => airports.has(code) || countryPlaces.has(code);
// The country's Google location id (kgmid), or the airport code. Only for a country without main
// airports (none today): with the kgmid, Google answered short lists of flights and empty calendars.
export const placeId = code => countryPlaces.get(code) || code;
// Main airports of a country (Google's first suggestions, scripts/build-main-airports.mjs), [] if none.
export const mainAirports = code => MAIN.get(code) || [];
// Main airports used per side: 3, or 2 when both ends are countries (2 x 2).
export const airportsPerSide = (origin, destination) => (isCountry(origin) && isCountry(destination) ? 2 : 3);
// A search that covers several airports on one side (a country).
export const severalAirports = q => isCountry(q.origin) || isCountry(q.destination);
// What the calendar asks for: a country's main airports separated by commas ("LIS,OPO,FAO"). One
// request gives the lowest price of each day over all of them (checked against each airport's own
// calendar, 11/11/2026); the country's kgmid answered nothing after 34 to 43 s.
export function calendarId(code, take = 3) {
  const main = isCountry(code) ? mainAirports(code).slice(0, take) : [];
  return main.length ? main.join(',') : placeId(code);
}
