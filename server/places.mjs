// Search places: an airport (IATA code) or a whole country (ISO code, "todos os aeroportos").
import { airports, countryPlaces } from './airport-codes.mjs';

export const isCountry = code => countryPlaces.has(code);
export const isPlace = code => airports.has(code) || countryPlaces.has(code);
// What the flight provider receives: the airport code or the country's Google location id (kgmid).
export const placeId = code => countryPlaces.get(code) || code;
