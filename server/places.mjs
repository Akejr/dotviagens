// Search places: an airport (IATA code) or a whole country (ISO code, "todos os aeroportos").
import { airports, countryPlaces } from './airport-codes.mjs';
import { mainAirports as MAIN } from './main-airports.mjs';

export const isCountry = code => countryPlaces.has(code);
export const isPlace = code => airports.has(code) || countryPlaces.has(code);
// What the flight provider receives: the airport code or the country's Google location id (kgmid).
// The calendar uses the kgmid; the flight search uses the main airports (below) when the country has them.
export const placeId = code => countryPlaces.get(code) || code;
// Main airports of a country (Google's first suggestions, scripts/build-main-airports.mjs), [] if none.
export const mainAirports = code => MAIN.get(code) || [];
