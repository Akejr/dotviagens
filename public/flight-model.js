export const money=v=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v);
export const moneyKz=v=>new Intl.NumberFormat('pt-AO',{style:'currency',currency:'AOA',maximumFractionDigits:0}).format(v);
// Same rule as the server: BRL x câmbio do dia, rounded up to the kwanza (integer maths).
export const toKz=(brl,rate)=>{const cents=BigInt(Math.round(Number(brl)*100)),scaled=BigInt(Math.round(Number(rate)*10000)),d=1000000n;return Number((cents*scaled+d-1n)/d)};
// DOT service fee in basis points (1100 = 11%), rounded up like on the server. Customers only see the total.
export const withMarkup=(value,bp)=>{const v=BigInt(Math.round(Number(value))),fee=(v*BigInt(Math.max(0,Math.round(Number(bp)||0)))+9999n)/10000n;return Number(v+fee)};
export const totalKz=(brl,rate,bp)=>withMarkup(toKz(brl,rate),bp);
// Without a câmbio the site shows reais: same fee, computed on cents.
export const totalBrl=(brl,bp)=>withMarkup(Math.round(Number(brl)*100),bp)/100;
export const duration=v=>`${Math.floor(v/60)}h ${v%60}min`;
export const dateText=s=>s.split('-').reverse().join('/');
export const airlineNames=o=>[...new Set(o.segments.map(s=>s.airline).filter(Boolean))];
export function availableAirlines(offers,direct=false){const names=new Map();for(const o of offers){if(direct&&o.stops)continue;for(const a of airlineNames(o))names.set(a,(names.get(a)||0)+1)}return names}
export function filterOffers(offers,{direct=false,airlines=new Set(),sort='price'}={}){return offers.filter(o=>(!direct||o.stops===0)&&(!airlines.size||airlineNames(o).some(a=>airlines.has(a)))).sort(sort==='duration'?(a,b)=>a.duration-b.duration||a.amount-b.amount:(a,b)=>a.amount-b.amount||a.duration-b.duration)}
export function itineraryTotal(outbound,inbound,roundTrip){if(!outbound||roundTrip&&!inbound)return null;return (roundTrip?inbound:outbound).amount}

export const signature=o=>JSON.stringify(o.segments.map(s=>[s.number,s.from,s.to,s.departure]));
export async function resolveReturns(query,chosen,search){
 const initial=await search(query);
 const matched=initial.offers.find(o=>signature(o)===signature(chosen)&&o.departureToken);
 if(!matched)return {offers:[],searchedAt:new Date().toISOString()};
 const returns=await search({...query,departureToken:matched.departureToken});
 // The matched outbound (with its signed query) is what checkout needs to pair with a return.
 return {...returns,outbound:{offer:matched,query:initial.query,searchedAt:initial.searchedAt}};
}
