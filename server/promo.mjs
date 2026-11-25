// Black Friday campaign: a discount on the final price of every flight, by price band.
//
// TO END THE CAMPAIGN: set ENABLED to false below (or delete the `tiers`) and deploy. Nothing else
// needs to change: the server stops applying it, /api/rate stops announcing it and the pages stop
// showing the tag and the old price. Bookings already made keep their price.
//
// The band is chosen by the price before the discount (câmbio + DOT fee, in kwanzas, for the whole trip):
//   from 2 500 000 Kz: 8 %   from 1 000 000 Kz: 6 %   below 1 000 000 Kz: 5 %
// Rates are in basis points (500 = 5 %). The discount is rounded down to the kwanza.

export const ENABLED = true;
const LABEL = 'Black Friday';
const TIERS = [
  { from: 2500000, bp: 800 },
  { from: 1000000, bp: 600 },
  { from: 0, bp: 500 },
];

// What /api/rate tells the browser (null when the campaign is off).
export const promoInfo = () => (ENABLED ? { label: LABEL, tiers: TIERS } : null);

// Discount of one price in kwanzas: {fullAoa, discountAoa, amountAoa}.
export function discountOf(fullAoa) {
  const full = Math.round(Number(fullAoa));
  const tier = ENABLED ? TIERS.find(item => full >= item.from) : null;
  const discountAoa = tier && full > 0 ? Number((BigInt(full) * BigInt(tier.bp)) / 10000n) : 0;
  return { fullAoa: full, discountAoa, amountAoa: full - discountAoa };
}

// A price from priceAoa() {baseAoa, feeAoa, amountAoa, markupBp} with the campaign applied:
// amountAoa is what the customer pays; fullAoa and discountAoa keep the rest.
export function withPromo(price) {
  const { fullAoa, discountAoa, amountAoa } = discountOf(price.amountAoa);
  return { ...price, fullAoa, discountAoa, amountAoa };
}
