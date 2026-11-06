export const money=v=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v);
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
 return search({...query,departureToken:matched.departureToken});
}
