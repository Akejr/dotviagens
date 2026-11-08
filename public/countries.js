// ISO 3166-1 alpha-2 codes, names in Angolan Portuguese through Intl.DisplayNames.
const CODES = 'AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT PR QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW'.split(' ');

let cached;
export function countries() {
  if (cached) return cached;
  const names = new Intl.DisplayNames(['pt-AO', 'pt-PT', 'pt'], { type: 'region' });
  const collator = new Intl.Collator('pt');
  cached = CODES.map(code => ({ code, name: names.of(code) || code })).sort((a, b) => collator.compare(a.name, b.name));
  return cached;
}

export const countryName = code => countries().find(country => country.code === code)?.name || code;

// Angola first, then the rest alphabetically.
export function countryOptions(selected = 'AO') {
  const list = countries();
  const first = list.filter(country => country.code === 'AO');
  return [...first, ...list.filter(country => country.code !== 'AO')]
    .map(country => `<option value="${country.code}" ${country.code === selected ? 'selected' : ''}>${country.name}</option>`)
    .join('');
}
