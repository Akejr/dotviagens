import {isPlace,placeId,isCountry,mainAirports} from './places.mjs';
import {safeLogo,signResult,signedQuery,signOffer} from './offers.mjs';
import {searchApiOn,searchApiFlightsUrl,adaptFlights} from './searchapi.mjs';
const memo=new Map(), pending=new Map();
// Memory cache of this instance (10 min) inside the 25 min window of the shared cache (hooks.cacheGet):
// a result is never reused after 25 min, so its offers can still be bought (30 min limit).
const MEMO_MS=600000,SHARE_MS=25*60*1000;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function remember(key,data){if(memo.size>=100)memo.delete(memo.keys().next().value);const searched=Date.parse(data.searchedAt)||Date.now();memo.set(key,{data,until:Math.min(Date.now()+MEMO_MS,searched+SHARE_MS)})}
// age: how old the result already is, so the browser keeps it only for the rest of the 25 minutes.
const reused=data=>({...data,cached:true,age:Math.max(0,Date.now()-(Date.parse(data.searchedAt)||Date.now()))});
const PAUSED='As pesquisas de voos estão em pausa por alguns minutos. Tenta novamente mais tarde ou fala connosco no WhatsApp.';
export function validate(q){
 const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 const today=new Date().toISOString().slice(0,10);
 // Origin and destination: airports of the list or whole countries ("Brasil (todos os aeroportos)").
 if(!q||!isPlace(q.origin)||!isPlace(q.destination)||q.origin===q.destination)throw Error('Escolhe aeroportos diferentes da lista.');
 if(!date(q.departureDate)||q.departureDate<today||q.departureDate>new Date(Date.now()+330*86400000).toISOString().slice(0,10))throw Error('Escolhe uma data nos próximos 330 dias.');
 if(q.returnDate&&(!date(q.returnDate)||q.returnDate<q.departureDate||q.returnDate>new Date(Date.now()+330*86400000).toISOString().slice(0,10)))throw Error('Confirma a data de regresso.');
 if(q.stops!==undefined&&q.stops!==0&&q.stops!==1)throw Error('Filtro de escalas inválido.');
 if(!Number.isInteger(q.passengers)||q.passengers<1||q.passengers>4||q.cabin!=='economy')throw Error('Pesquisa disponível para 1 a 4 adultos em económica.');
 if(q.departureToken&&(!q.returnDate||typeof q.departureToken!=='string'||q.departureToken.length>12000||!/^[-_a-zA-Z0-9=+/]+$/.test(q.departureToken)))throw Error('Selecção de ida inválida. Pesquisa novamente.');
 return {departureToken:q.departureToken||null,origin:q.origin,destination:q.destination,departureDate:q.departureDate,returnDate:q.returnDate||null,passengers:q.passengers,cabin:'economy',stops:q.stops??0};
}
export function normalize(data){
 const rows=[...(data.best_flights||[]),...(data.other_flights||[])];const seen=new Set();
 return rows.filter(o=>Array.isArray(o.flights)&&o.flights.length&&Number.isFinite(o.price)).map((o,i)=>({id:String(i),departureToken:o.departure_token||null,bookingToken:o.booking_token||null,logo:safeLogo(o.airline_logo||o.flights[0]?.airline_logo),airline:[...new Set(o.flights.map(f=>f.airline).filter(Boolean))].join(' / '),segments:o.flights.map(f=>({airline:f.airline||'',logo:safeLogo(f.airline_logo),number:f.flight_number||'',from:f.departure_airport?.id||'',to:f.arrival_airport?.id||'',departure:f.departure_airport?.time||'',arrival:f.arrival_airport?.time||'',duration:f.duration||0})),layovers:(o.layovers||[]).map(l=>({airport:l.id||'',name:l.name||'',duration:l.duration||0,overnight:!!l.overnight})),duration:o.total_duration||0,amount:o.price,currency:'BRL',stops:o.flights.length-1,cabin:'Económica'})).filter(o=>{const k=JSON.stringify([o.segments,o.amount]);if(seen.has(k))return false;seen.add(k);return true});
}
// SerpApi answers "Success" plus an error string when Google has no flights: that is an empty result, not a failure.
// SerpApi: "hasn't returned any results"; SearchApi: "didn't return any results".
export const noResults=d=>typeof d?.error==='string'&&/(hasn.t returned|didn.t return) any results/i.test(d.error);
// sid: browser session; jid: one results-page search (all its dates and returns share it).
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(v)?v:null;
const metaOf=b=>({kind:typeof b?.kind==='string'?b.kind.slice(0,24):null,sid:safeId(b?.sid),jid:safeId(b?.jid)});
// A whole country: its main airports (up to 3; 2 x 2 when both ends are countries) are searched one by
// one, like any airport search (caches, records, alerts), and merged. Google answers multi-airport
// searches slowly and SearchApi then returns a short or empty list (11/11/2026, Luanda -> Portugal on
// 1/2/2027: 3 TAAG flights to Lisbon, while Google showed 11, Porto cheaper). Each offer keeps the
// airport search it came from (query, searchedAt), re-signed with its new id: checkout and the
// return of a round trip use that search. Null when the country has no main airports.
async function searchCountry(request,raw,q,env,fetcher,hooks){
 const both=isCountry(q.origin)&&isCountry(q.destination),take=both?2:3;
 const ends=code=>isCountry(code)?mainAirports(code).slice(0,take):[code];
 const pairs=[];for(const origin of ends(q.origin))for(const destination of ends(q.destination))if(origin!==destination)pairs.push([origin,destination]);
 if(!pairs.length)return null;
 const answers=await Promise.all(pairs.map(async([origin,destination])=>{try{const response=await handleSearch(new Request(request.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...raw,origin,destination})}),env,fetcher,hooks);return {status:response.status,data:await response.json()}}catch{return {status:502,data:null}}}));
 const found=answers.filter(a=>a.status===200&&Array.isArray(a.data?.offers));
 if(!found.length){const failed=answers.find(a=>a.data?.error)||{status:502,data:{error:'Não foi possível contactar o fornecedor de voos. Tenta novamente dentro de momentos.',code:'PROVIDER_UNAVAILABLE'}};return json(failed.data,failed.status)}
 const offers=(await Promise.all(found.map(({data},index)=>Promise.all(data.offers.map(async offer=>{const merged={...offer,id:`${index}-${offer.id}`};return {...merged,sig:env.OFFER_SECRET?await signOffer(env.OFFER_SECRET,data.query,merged,data.searchedAt):offer.sig,query:data.query,searchedAt:data.searchedAt}}))))).flat().sort((a,b)=>a.amount-b.amount);
 return json({demo:false,offers,currency:'BRL',passengers:q.passengers,roundTrip:!!q.returnDate,searchedAt:found.map(a=>a.data.searchedAt).sort()[0],cached:found.every(a=>a.data.cached),query:signedQuery(q),places:found.map(a=>[a.data.query.origin,a.data.query.destination]),age:Math.max(...found.map(a=>Number(a.data.age)||0))});
}
export async function handleSearch(request,env,fetcher=fetch,hooks={}){
 if(request.method!=='POST')return json({error:'Método não permitido.'},405);
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return json({error:'Pedido não permitido.'},403);
 let q,meta,raw;try{const body=await request.text();if(body.length>16000)return json({error:'Pedido demasiado grande.'},413);raw=JSON.parse(body);q=validate(raw);meta=metaOf(raw)}catch(e){return json({error:e instanceof SyntaxError?'Pedido inválido.':e.message},400)}
 // SearchApi when SEARCHAPI_KEY is set (see searchapi.mjs), otherwise SerpApi. Its cache keys are apart.
 const viaSearchApi=searchApiOn(env);
 if(!viaSearchApi&&!env.SERPAPI_KEY)return json({error:'A pesquisa ainda não está configurada.'},503);
 if(!q.departureToken&&(isCountry(q.origin)||isCountry(q.destination))){const merged=await searchCountry(request,raw,q,env,fetcher,hooks);if(merged)return merged}
 const started=Date.now();const report=(result,status,errorCode=null)=>{try{hooks.onSearch?.({q,meta,status,errorCode,cached:!!result?.cached,offers:result?.offers||[],durationMs:Date.now()-started})}catch{}};
 const key=(viaSearchApi?'searchapi|':'')+JSON.stringify(q);const saved=memo.get(key);if(saved&&saved.until>Date.now()){const result=reused(saved.data);report(result,result.offers.length?'ok':'empty');return json(result)}
 if(pending.has(key))return pending.get(key).then(r=>r.clone());
 const task=(async()=>{try{
 // Shared cache: the same search made in the last 25 minutes by any visitor, on any server instance.
 const shared=await Promise.resolve(hooks.cacheGet?.(key)).catch(()=>null);
 if(Array.isArray(shared?.offers)&&Date.parse(shared.searchedAt)+SHARE_MS>Date.now()){remember(key,shared);const result=reused(shared);report(result,result.offers.length?'ok':'empty');return json(result)}
 // After a quota error SerpApi is paused for a few minutes on every instance: no call is made.
 const paused=Number(await Promise.resolve(hooks.pausedUntil?.()).catch(()=>0))||0;
 if(paused>Date.now())return json({error:hooks.pauseMessage?.(paused)||PAUSED,code:'PROVIDER_PAUSED',retryAt:new Date(paused).toISOString()},503);
 let url;if(viaSearchApi)url=searchApiFlightsUrl(env,q);else{url=new URL('https://serpapi.com/search.json');url.search=new URLSearchParams({engine:'google_flights',api_key:env.SERPAPI_KEY,departure_id:placeId(q.origin),arrival_id:placeId(q.destination),outbound_date:q.departureDate,...(q.returnDate?{return_date:q.returnDate}:{}),type:q.returnDate?'1':'2',...(q.departureToken?{departure_token:q.departureToken}:{}),adults:String(q.passengers),travel_class:'1',stops:String(q.stops),currency:'BRL',hl:'pt',gl:'pt'}).toString()}
 const response=await fetcher(url,{signal:AbortSignal.timeout(45000)});const raw=await response.json();const data=viaSearchApi?adaptFlights(raw):raw;
 if(response.status===401||response.status===403){report(null,'error','PROVIDER_AUTH');return json({error:`A ${viaSearchApi?'SearchApi':'SerpApi'} recusou a chave de acesso. Confirma a chave no painel do fornecedor.`,code:'PROVIDER_AUTH'},502)}
 if(response.status===429){const until=hooks.onLimit?.();report(null,'error','PROVIDER_LIMIT');return json({error:until&&hooks.pauseMessage?hooks.pauseMessage(until):PAUSED,code:'PROVIDER_LIMIT'},429)}
 if(!response.ok||(data.error&&!noResults(data))){report(null,'error','PROVIDER_ERROR');return json({error:'O fornecedor não conseguiu concluir esta pesquisa. Tenta outras datas ou tenta novamente.',code:'PROVIDER_ERROR'},502)}
 let result={demo:false,offers:normalize(data),currency:'BRL',passengers:q.passengers,roundTrip:!!q.returnDate,searchedAt:new Date().toISOString(),cached:false};
 // Signed offers let checkout trust the price without a new paid search.
 result=env.OFFER_SECRET?await signResult(env.OFFER_SECRET,result,q):{...result,query:signedQuery(q)};
 remember(key,result);report(result,result.offers.length?'ok':'empty');
 // Fresh provider result: shared with the other instances and checked against price alerts.
 try{hooks.onFresh?.(q,result,key)}catch{}
 return json({...result,age:0});
 }catch{report(null,'error','PROVIDER_UNAVAILABLE');return json({error:'Não foi possível contactar o fornecedor de voos. Tenta novamente dentro de momentos.',code:'PROVIDER_UNAVAILABLE'},502)}})();pending.set(key,task);try{return (await task).clone()}finally{pending.delete(key)}
}
