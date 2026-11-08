import {airports} from './airport-codes.mjs';
import {safeLogo,signResult,signedQuery} from './offers.mjs';
const memo=new Map(), pending=new Map();
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export function validate(q){
 const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 const today=new Date().toISOString().slice(0,10);
 if(!q||!airports.has(q.origin)||!airports.has(q.destination)||q.origin===q.destination)throw Error('Escolhe aeroportos diferentes da lista.');
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
export const noResults=d=>typeof d?.error==='string'&&/hasn.t returned any results/i.test(d.error);
// sid: browser session; jid: one results-page search (all its dates and returns share it).
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(v)?v:null;
const metaOf=b=>({kind:typeof b?.kind==='string'?b.kind.slice(0,24):null,sid:safeId(b?.sid),jid:safeId(b?.jid)});
export async function handleSearch(request,env,fetcher=fetch,hooks={}){
 if(request.method!=='POST')return json({error:'Método não permitido.'},405);
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return json({error:'Pedido não permitido.'},403);
 let q,meta;try{const body=await request.text();if(body.length>16000)return json({error:'Pedido demasiado grande.'},413);const raw=JSON.parse(body);q=validate(raw);meta=metaOf(raw)}catch(e){return json({error:e instanceof SyntaxError?'Pedido inválido.':e.message},400)}
 if(!env.SERPAPI_KEY)return json({error:'A pesquisa ainda não está configurada.'},503);
 const started=Date.now();const report=(result,status,errorCode=null)=>{try{hooks.onSearch?.({q,meta,status,errorCode,cached:!!result?.cached,offers:result?.offers||[],durationMs:Date.now()-started})}catch{}};
 const key=JSON.stringify(q);const saved=memo.get(key);if(saved&&saved.until>Date.now()){const result={...saved.data,cached:true};report(result,result.offers.length?'ok':'empty');return json(result)}
 if(pending.has(key))return pending.get(key).then(r=>r.clone());
 const task=(async()=>{try{
 const url=new URL('https://serpapi.com/search.json');url.search=new URLSearchParams({engine:'google_flights',api_key:env.SERPAPI_KEY,departure_id:q.origin,arrival_id:q.destination,outbound_date:q.departureDate,...(q.returnDate?{return_date:q.returnDate}:{}),type:q.returnDate?'1':'2',...(q.departureToken?{departure_token:q.departureToken}:{}),adults:String(q.passengers),travel_class:'1',stops:String(q.stops),currency:'BRL',hl:'pt',gl:'pt'}).toString();
 const response=await fetcher(url,{signal:AbortSignal.timeout(45000)});const data=await response.json();
 if(response.status===401||response.status===403){report(null,'error','PROVIDER_AUTH');return json({error:'A SerpApi recusou a chave de acesso. Confirma a chave no painel da SerpApi.',code:'PROVIDER_AUTH'},502)}
 if(response.status===429){report(null,'error','PROVIDER_LIMIT');return json({error:'O limite de pesquisas da SerpApi foi atingido. Verifica a quota da conta.',code:'PROVIDER_LIMIT'},429)}
 if(!response.ok||(data.error&&!noResults(data))){report(null,'error','PROVIDER_ERROR');return json({error:'O fornecedor não conseguiu concluir esta pesquisa. Tenta outras datas ou tenta novamente.',code:'PROVIDER_ERROR'},502)}
 let result={demo:false,offers:normalize(data),currency:'BRL',passengers:q.passengers,roundTrip:!!q.returnDate,searchedAt:new Date().toISOString(),cached:false};
 // Signed offers let checkout trust the price without a new paid search.
 result=env.OFFER_SECRET?await signResult(env.OFFER_SECRET,result,q):{...result,query:signedQuery(q)};
 if(memo.size>=100)memo.delete(memo.keys().next().value);memo.set(key,{data:result,until:Date.now()+600000});report(result,result.offers.length?'ok':'empty');return json(result);
 }catch{report(null,'error','PROVIDER_UNAVAILABLE');return json({error:'Não foi possível contactar o fornecedor de voos. Tenta novamente dentro de momentos.',code:'PROVIDER_UNAVAILABLE'},502)}})();pending.set(key,task);try{return (await task).clone()}finally{pending.delete(key)}
}
