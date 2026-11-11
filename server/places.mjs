// Search places: an airport (IATA code), a whole country (ISO code, "Portugal (todos os aeroportos)")
// or a city with several airports (its airports joined by commas, "SVO,DME,VKO,ZIA" = Moscovo).
import { airports, countryPlaces } from './airport-codes.mjs';
import { mainAirports as MAIN } from './main-airports.mjs';
import { cityGroups } from './city-airports.mjs';

export const isCountry = code => countryPlaces.has(code);
export const isCity = code => cityGroups.has(code);
// A place that covers several airports (searched one by one, no price alert).
export const isGroup = code => isCountry(code) || isCity(code);
export const isPlace = code => airports.has(code) || isGroup(code);
export const cityName = code => cityGroups.get(code)?.name || null;
// The country's Google location id (kgmid), or the code. Only for a country without main airports
// (none today): with the kgmid, Google answered short lists of flights and empty calendars.
export const placeId = code => countryPlaces.get(code) || code;
// Main airports of a country (Google's first suggestions, scripts/build-main-airports.mjs), [] if none.
export const mainAirports = code => MAIN.get(code) || [];
// Airports searched per side: a city up to 4, a country 3, 2 each when both ends are groups (2 x 2).
export const airportsPerSide = (origin, destination) => (isGroup(origin) && isGroup(destination) ? 2 : 4);
export function airportsOf(code, take = 4) {
  if (isCity(code)) return cityGroups.get(code).airports.slice(0, take);
  if (isCountry(code)) return mainAirports(code).slice(0, Math.min(take, 3));
  return [code];
}
// A search that covers several airports on one side.
export const severalAirports = q => isGroup(q.origin) || isGroup(q.destination);
// What the calendar asks for: the airports separated by commas ("LIS,OPO,FAO"). One request gives the
// lowest price of each day over all of them (checked against each airport's own calendar,
// 11/11/2026); the country's kgmid answered nothing after 34 to 43 s.
export function calendarId(code, take = 4) {
  const list = isGroup(code) ? airportsOf(code, take) : [];
  return list.length ? list.join(',') : placeId(code);
}
