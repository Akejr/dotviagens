// Passenger data as an airline asks for it: names exactly as in the passport,
// birth date, nationality and passport. Adults (12+) first, then children (2 to 11 years on the
// departure date). Babies (under 2) are sold by the team.

import { HttpError, cleanText, isoDate } from './http.mjs';

const NAME = /^[\p{L}][\p{L}'’ -]*$/u;
const COUNTRY = /^[A-Z]{2}$/;
const TITLES = new Set(['MR', 'MS']);

export function ageOn(birthDate, date) {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const day = new Date(`${date}T00:00:00Z`);
  let age = day.getUTCFullYear() - birth.getUTCFullYear();
  const months = day.getUTCMonth() - birth.getUTCMonth();
  if (months < 0 || (months === 0 && day.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

export function validatePassengers(list, { count, children = 0, departureDate, lastTravelDate, today = new Date().toISOString().slice(0, 10) }) {
  if (!Array.isArray(list) || list.length !== count + children) {
    throw new HttpError(400, 'Preenche os dados de todos os passageiros.', 'PASSENGERS');
  }
  const documents = new Set();
  return list.map((passenger, index) => {
    const fail = message => {
      throw new HttpError(400, `Passageiro ${index + 1}: ${message}`, 'PASSENGER_INVALID', { passenger: index });
    };
    // The order is the search's: the first `count` are adults, the rest children.
    const type = index < count ? 'adult' : 'child';
    const title = String(passenger?.title || '').toUpperCase();
    if (!TITLES.has(title)) fail('escolhe o tratamento (Sr. ou Sra.).');
    const givenNames = cleanText(passenger?.givenNames, 60);
    const surname = cleanText(passenger?.surname, 60);
    if (givenNames.length < 2 || !NAME.test(givenNames)) fail('indica o(s) nome(s) próprio(s) tal como no passaporte.');
    if (surname.length < 2 || !NAME.test(surname)) fail('indica o(s) apelido(s) tal como no passaporte.');
    if (!isoDate(passenger?.birthDate) || passenger.birthDate >= today) fail('confirma a data de nascimento.');
    const age = ageOn(passenger.birthDate, departureDate);
    if (age > 120) fail('confirma a data de nascimento.');
    if (type === 'adult' && age < 12) fail('um adulto tem de ter 12 anos ou mais na data da viagem.');
    if (type === 'child' && (age < 2 || age > 11)) fail('uma criança tem de ter entre 2 e 11 anos na data da viagem.');
    const nationality = String(passenger?.nationality || '').toUpperCase();
    if (!COUNTRY.test(nationality)) fail('escolhe a nacionalidade.');
    const documentNumber = String(passenger?.documentNumber || '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{5,20}$/.test(documentNumber)) fail('confirma o número do passaporte.');
    if (documents.has(documentNumber)) fail('este número de passaporte já foi usado noutro passageiro.');
    documents.add(documentNumber);
    const documentCountry = String(passenger?.documentCountry || '').toUpperCase();
    if (!COUNTRY.test(documentCountry)) fail('escolhe o país emissor do passaporte.');
    if (!isoDate(passenger?.documentExpiry)) fail('confirma a validade do passaporte.');
    if (passenger.documentExpiry <= lastTravelDate) fail('o passaporte tem de estar válido para além da data da viagem.');
    return { type, title, givenNames, surname, birthDate: passenger.birthDate, nationality, documentNumber, documentCountry, documentExpiry: passenger.documentExpiry };
  });
}
