import {searchFlights} from './services.js';
import {loadAirports} from './airports.js';
import {stickyHeader,api,auth,formatPhone} from './api.js';
import {icon} from './icons.js';
import {mountOtp} from './otp-widget.js';
import {money,moneyKz,totalKz,totalBrl,duration,dateText,availableAirlines,filterOffers,itineraryTotal,signature,resolveReturns} from './flight-model.js';
import {loadPricing,openCalendarPopover,daysBetweenIso,monthPrices,standardTripDays,adultsOf} from './price-calendar.js';
import {airlineMark,airlineNames,legAirlines,legTimeline} from './itinerary-ui.js';
import {MAIN_AIRPORTS} from './main-airports.js';
import {CITY_GROUPS} from './city-airports.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const add=(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)},today=new Date().toISOString().slice(0,10),maxDate=add(today,330);
const params=new URLSearchParams(location.search);
// Short link of the price-alert SMS: ?v=NBJLIS2612182612281 (route, dates as YYMMDD, adults).
const shortLink=(()=>{const m=(params.get('v')||'').toUpperCase().match(/^([A-Z]{3})([A-Z]{3})(\d{6})(\d{6})?([1-4])$/);if(!m)return false;const iso=s=>`20${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4)}`;params.set('origin',m[1]);params.set('destination',m[2]);params.set('departureDate',iso(m[3]));if(m[4])params.set('returnDate',iso(m[4]));else params.delete('returnDate');params.set('passengers',m[5]);params.delete('v');return true})();
// Travellers and class: adults (passengers), children (2 to 11, only when there are some) and cabin.
const CABIN_LABEL={economy:'Económica',premium_economy:'Económica premium',business:'Executiva',first:'Primeira'};
const kidsParam=Number(params.get('children'))||0,cabinParam=Object.hasOwn(CABIN_LABEL,params.get('cabin')||'')?params.get('cabin'):'economy';
let query={origin:params.get('origin'),destination:params.get('destination'),departureDate:params.get('departureDate'),returnDate:params.get('returnDate')||null,passengers:Number(params.get('passengers')||1),...(kidsParam?{children:kidsParam}:{}),cabin:cabinParam,stops:0};
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
const travellersText=()=>`${plural(query.passengers,'adulto','adultos')}${query.children?` e ${plural(query.children,'criança','crianças')}`:''}`;
const dayShift=(from,to)=>Math.round((Date.parse(String(to).slice(0,10))-Date.parse(String(from).slice(0,10)))/86400000)||0;
const plusDay=(from,to)=>{const n=dayShift(from,to);return n>0?`<sup>+${n}</sup>`:''};
// A whole country can be searched (2-letter ISO code, e.g. PT): the server compares its main airports
// (main-airports.js) and the calendar covers the whole country. No price alert (it follows one airport).
// Choosing a flight turns the search into that flight's airports (its return and calendar); going back
// to the outbound restores the country.
// A city with several airports works the same way: its code is the list of its airports ("SVO,DME,VKO,ZIA").
const CITY_BY_CODE=new Map(CITY_GROUPS.map(c=>[c.code,c]));
const isCountry=c=>/^[A-Z]{2}$/.test(c||''),regionNames=new Intl.DisplayNames(['pt'],{type:'region'});
const isGroup=c=>isCountry(c)||CITY_BY_CODE.has(c);
const countrySearch=()=>isGroup(query.origin)||isGroup(query.destination);
// The search as it was before a flight was chosen (its airports and class): restored on going back.
let countryPlace=null;
function choosePlace(o,cabin=query.cabin,airlines=null){const sameRoute=!o.query||(o.query.origin===query.origin&&o.query.destination===query.destination);if(sameRoute&&cabin===query.cabin&&!airlines)return;countryPlace??={origin:query.origin,destination:query.destination,cabin:query.cabin};if(!sameRoute){query.origin=o.query.origin;query.destination=o.query.destination}query.cabin=cabin;if(airlines)query.airlines=airlines;else delete query.airlines}
function restorePlace(){if(!countryPlace)return;query.origin=countryPlace.origin;query.destination=countryPlace.destination;query.cabin=countryPlace.cabin;delete query.airlines;countryPlace=null}
// Class chosen on each flight card of the outbound list (offer id -> cabin): the card shows that
// flight's price in the class, from one search of the day in that class (cached like any search).
// Each class's list is short (11/11/2026: 4 economy offers, without the Qatar flight shown in
// business): when the flight is not there, one more search with only its airlines finds it.
const cardCabin=new Map(),cabinLoading=new Set();
const classQuery=(cabin,airlines=null)=>{const {airlines:_,...base}=queryFor(selected);return {...base,cabin,...(airlines?{airlines}:{})}};
const airlinesOf=o=>[...new Set(o.segments.map(s=>String(s.number||'').split(' ')[0]).filter(code=>/^[A-Z0-9]{2}$/.test(code)))].slice(0,3).join(',')||null;
const sameFlight=o=>x=>signature(x)===signature(o)&&(!query.returnDate||!!x.departureToken);
async function loadCabin(o,cabin){const tag=`${o.id}|${cabin}`;if(cabinLoading.has(tag))return;cabinLoading.add(tag);renderOffers();try{const q=classQuery(cabin),k=key(q);if(!cache.get(k)?.data){cache.delete(k);await request(q,'cabin')}const listed=(cache.get(k)?.data?.offers||[]).some(sameFlight(o)),airlines=airlinesOf(o);if(!listed&&airlines){const fq=classQuery(cabin,airlines);if(!cache.get(key(fq))?.data){cache.delete(key(fq));await request(fq,'cabin')}}}catch(err){cache.set(key(classQuery(cabin)),{error:err.message,expires:Date.now()+30000})}finally{cabinLoading.delete(tag);if(stage==='outbound')renderOffers()}}
let selected=query.departureDate,windowStart,sort='price',airlines=new Set(),direct=params.get('stops')==='1',generation=0,visible=8,stage='outbound',outbound=null,inbound=null,returnData=null,returnError=null,names={},airportNames={},pricing=null,outboundMeta=null,inboundMeta=null;
// Prices arrive in BRL and are shown as the final price: câmbio do dia + DOT fee, in kwanzas
// (in reais + fee while no câmbio is set). The fee is never shown on its own.
const price=v=>pricing?.rate?moneyKz(totalKz(v,pricing.rate,pricing.markupBp)):money(totalBrl(v,pricing?.markupBp||0));
const sid=(()=>{try{let v=sessionStorage.getItem('dot-sid');if(!v){v=crypto.randomUUID();sessionStorage.setItem('dot-sid',v)}return v}catch{return null}})();
// One id per search on this page: the admin groups its dates and returns in one row.
const jid=(()=>{const k='dot-jid:'+[query.origin,query.destination,query.departureDate,query.returnDate||'',query.passengers,query.children||0,query.cabin].join('|');try{const saved=JSON.parse(sessionStorage.getItem(k)||'null');const id=saved?.id&&saved.at>Date.now()-1800000?saved.id:crypto.randomUUID();sessionStorage.setItem(k,JSON.stringify({id,at:Date.now()}));return id}catch{return null}})();
// A search stays in this tab for 25 minutes after it was made (the server says how old it already is):
// its offers can still be bought, which needs at most 30 minutes.
const cache=new Map(),pending=new Map(),TTL=25*60000;
const expiryOf=data=>Date.now()+Math.max(60000,TTL-(Number(data?.age)||0));
try{for(const [k,v]of JSON.parse(sessionStorage.getItem('dot-flight-cache-v3')||'[]'))if(v.expires>Date.now())cache.set(k,v)}catch{}
const activeDate=()=>stage==='return'?query.returnDate:selected;
// Round trips keep their length when the departure day changes (the return follows), like the home calendar.
const tripLength=()=>query.returnDate?Math.max(0,daysBetweenIso(selected,query.returnDate)):0;
const returnFor=d=>{if(!query.returnDate)return null;const r=add(d,tripLength());return r>maxDate?maxDate:r};
const key=q=>JSON.stringify(q),queryFor=d=>stage==='return'?{...query,returnDate:d,selectedOutbound:signature(outbound)}:{...query,departureDate:d,returnDate:returnFor(d)};
const datePending=new Map();
const firstDate=()=>stage==='return'?(outbound?.segments.at(-1)?.arrival.slice(0,10)||selected):today;
function centreDates(){windowStart=add(activeDate(),-2);if(windowStart<firstDate())windowStart=firstDate()}

function saveCache(){while(cache.size>35)cache.delete(cache.keys().next().value);try{sessionStorage.setItem('dot-flight-cache-v3',JSON.stringify([...cache]))}catch{}}
// Expired entries stay visible (and selectable); only fetch decisions use freshness.
function entry(d){return cache.get(key(queryFor(d)))||null}
const fresh=e=>!!e&&e.expires>Date.now();
async function request(q,kind=null){const k=key(q),saved=cache.get(k);if(saved?.data&&saved.expires>Date.now())return saved.data;if(pending.has(k))return pending.get(k);const task=searchFlights(q,{kind,sid,jid}).then(data=>{cache.set(k,{data,expires:expiryOf(data)});saveCache();return data}).finally(()=>pending.delete(k));pending.set(k,task);return task}
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const lastDate=()=>stage==='return'?maxDate:query.returnDate?add(maxDate,-tripLength()):maxDate;
const dates=()=>Array.from({length:5},(_,i)=>add(windowStart,i)).filter(d=>d>=firstDate()&&d<=lastDate());
const currentData=()=>stage==='return'?returnData:entry(selected)?.data;
const filtered=data=>filterOffers(data?.offers||[],{direct,airlines,sort});
function updateURL(){const p=new URLSearchParams(Object.fromEntries(Object.entries({...query,stops:direct?1:0}).filter(([,v])=>v!==null)));history.replaceState(null,'','/resultados?'+p)}

// Date strip: the indicative price of each day comes from the price calendar (one request per month,
// shared by every visitor for 6 hours, for 1 adult x adults). A flight search runs only for the day
// the customer picks: neighbour days are no longer searched in the background.
const calendarState=new Map();
function calendarQuery(){const base={origin:query.origin,destination:query.destination,passengers:query.passengers,children:query.children||0,cabin:query.cabin};if(!query.returnDate)return {...base,type:'oneway'};if(stage==='return')return {...base,type:'return',fixedOutbound:selected};return {...base,type:'return',tripDays:standardTripDays(Math.min(60,Math.max(1,tripLength())))}}
const calendarKey=(cq,month)=>JSON.stringify([cq.origin,cq.destination,cq.cabin,cq.type,cq.fixedOutbound||null,cq.tripDays||null,month]);
function loadCalendar(){if(stage==='summary'||!windowStart)return;const cq=calendarQuery();if(!cq)return;for(const month of new Set(dates().map(d=>d.slice(0,7)))){const k=calendarKey(cq,month);if(calendarState.has(k))continue;calendarState.set(k,'loading');monthPrices(cq,month,partial=>{const now=calendarState.get(k);if(now!=='loading'&&!now?.loading)return;partial.loading=true;calendarState.set(k,partial);if(stage!=='summary')renderDates()}).then(map=>calendarState.set(k,map),()=>calendarState.set(k,'error')).finally(()=>{if(stage!=='summary')renderDates()})}}
// Total for every adult (number), 'loading', 'error' or null when the calendar has no price for the day.
// A month that arrives in parts is a Map marked .loading until the last part: its missing days still load.
function calendarPrice(d){const cq=calendarQuery();if(!cq)return null;const state=calendarState.get(calendarKey(cq,d.slice(0,7)));if(!(state instanceof Map))return state||null;const amount=state.get(d)?.amount;return Number.isFinite(amount)?amount*adultsOf(cq):(state.loading?'loading':null)}

function renderHeader(){
 const cities=codes=>{const list=[...new Set(codes.map(placeName))];return list.length>1?`${list.slice(0,-1).join(', ')} e ${list.at(-1)}`:list[0]};
 $('#route-title').innerHTML=`${esc(placeName(query.origin))} <span>→</span> ${esc(placeName(query.destination))}`;
 const groupAirports=c=>CITY_BY_CODE.get(c)?.airports||MAIN_AIRPORTS.get(c);
 $('#route-meta').textContent=`${dateText(selected)}${query.returnDate?' — '+dateText(query.returnDate):''} · ${query.returnDate?'Ida e volta':'Só ida'} · ${travellersText()} · ${CABIN_LABEL[query.cabin]}${[query.origin,query.destination].filter(isGroup).map(c=>` · ${placeName(c)}: ${groupAirports(c)?(CITY_BY_CODE.has(c)?groupAirports(c).join(', '):cities(groupAirports(c))):'todos os aeroportos'}`).join('')}`;
 $('#date-help').textContent=stage==='return'?`Compara o regresso mantendo a ida de ${dateText(selected)}. Preços indicativos da viagem completa: o preço exacto aparece quando escolhes o dia.`:query.returnDate?`Compara a ida mantendo ${tripLength()} dias de viagem. Preços indicativos da viagem completa: o preço exacto aparece quando escolhes o dia.`:'Preços indicativos de cada dia: o preço exacto aparece quando escolhes o dia.';
 $('#journey-steps').innerHTML=`<button data-step="outbound" class="${stage==='outbound'?'current':'complete'}">1 <span>Escolher ida</span></button>${query.returnDate?`<button data-step="return" ${outbound?'':'disabled'} class="${stage==='return'?'current':inbound?'complete':''}">2 <span>Escolher volta</span></button>`:''}<span class="${stage==='summary'?'current':''}">${query.returnDate?'3':'2'} Rever viagem</span>`;
 $('.date-section').hidden=stage==='summary';$('.results-layout').hidden=stage==='summary';$('#trip-summary').hidden=stage!=='summary';
 $('#selection-banner').hidden=!outbound||stage==='outbound';
 if(outbound)$('#selection-banner').innerHTML=`${airlineMark(outbound)}<div><small>IDA SELECCIONADA</small><strong>${esc(airlineNames(outbound))} · ${esc(outbound.segments[0].departure.slice(11))} → ${esc(outbound.segments.at(-1).arrival.slice(11))}${plusDay(outbound.segments[0].departure,outbound.segments.at(-1).arrival)} · ${esc(outbound.cabin||CABIN_LABEL[query.cabin])}</strong><span>${dateText(selected)} · ${duration(outbound.duration)}</span></div><button class="secondary" data-step="outbound">Alterar ida</button>`;
 $('#stage-title').textContent=stage==='return'?`Escolhe a volta · ${dateText(query.returnDate)}`:'Escolhe o voo de ida';
}
function renderDates(){
 loadCalendar();
 $('#date-strip').innerHTML=dates().map(d=>{const e=entry(d),offers=filtered(e?.data),min=offers.length?Math.min(...offers.map(o=>o.amount)):null;const label=new Intl.DateTimeFormat('pt-PT',{weekday:'short',day:'2-digit',month:'short',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));let body,kind='';
  if(min!==null)body=`<small>a partir de</small> ${price(min)}`;
  else if(datePending.has(key(queryFor(d))))body='A consultar…';
  else if(e?.data)body='Sem voos';
  else if(e?.error&&d===activeDate())body='Tentar novamente';
  else{const c=calendarPrice(d);if(Number.isFinite(c)){body=`<small>indicativo</small> ≈ ${price(c)}`;kind=' indicative'}else{body=c==='loading'?'A carregar…':'Ver preço';kind=' ask'}}
  return `<button class="date-card${d===activeDate()?' active':''}${kind}" data-date="${d}" aria-pressed="${d===activeDate()}"><span>${esc(label)}</span><strong>${body}</strong></button>`}).join('');
 $('#previous-dates').disabled=windowStart<=firstDate();$('#next-dates').disabled=add(windowStart,5)>lastDate();$('#date-jump-value').textContent=dateText(activeDate());$('#date-jump-label').textContent=stage==='return'?'Data de volta':'Data de ida';
}
function renderAirlines(){const all=availableAirlines(currentData()?.offers||[],direct);for(const a of airlines)if(!all.has(a))airlines.delete(a);$('#airline-filters').innerHTML=all.size?[...all].sort(([a],[b])=>a.localeCompare(b)).map(([a,n])=>`<label class="filter-option"><input type="checkbox" data-airline="${esc(a)}" ${airlines.has(a)?'checked':''}><span>${esc(a)}</span><small class="airline-count">${n}</small></label>`).join(''):'<p class="muted">Nenhuma companhia disponível nesta pesquisa.</p>'}
const placeName=c=>names[c]||CITY_BY_CODE.get(c)?.name||(isCountry(c)?regionNames.of(c)||c:c),airportName=c=>airportNames[c]||'';
function segments(o){return legTimeline(o,{city:placeName,airport:airportName})}
// Trips that mix airlines show both logos together and every airline name.
function brand(o){const n=legAirlines(o).length;return `<div class="airline-brand${n>1?' multi':''}">${airlineMark(o)}<div><strong>${esc(airlineNames(o))}</strong><small>${n>1?`${n} companhias · `:''}${esc(o.cabin)}</small></div></div>`}
// The class of a card: the search's, or another one chosen on the card (outbound list only). With
// another class, the same flight (same flight numbers and times) is looked up in that class's search.
function cabinState(o){const cabin=stage==='outbound'?(cardCabin.get(o.id)||query.cabin):query.cabin;if(cabin===query.cabin)return {cabin,offer:o,source:''};const e=cache.get(key(classQuery(cabin)));const listed=e?.data?.offers.find(sameFlight(o));if(listed)return {cabin,offer:listed,source:''};const airlines=airlinesOf(o),f=airlines?cache.get(key(classQuery(cabin,airlines))):null,found=f?.data?.offers.find(sameFlight(o));if(found)return {cabin,offer:found,source:airlines};if(cabinLoading.has(`${o.id}|${cabin}`)||(!e?.data&&!e?.error))return {cabin,loading:true};if(e?.error&&!e?.data)return {cabin,error:e.error};return {cabin,offer:null,missing:true}}
function card(o,i){const first=o.segments[0],last=o.segments.at(-1),st=cabinState(o),shown=st.offer,canSelect=!!shown&&(stage!=='outbound'||!query.returnDate||!!shown.departureToken);
 const priceHtml=shown?`<div class="flight-price">${price(shown.amount)}</div>`:`<div class="flight-price muted-price">${st.loading?'A consultar…':'Indisponível'}</div>`;
 const note=st.loading?`A consultar ${CABIN_LABEL[st.cabin]}`:st.missing?`Sem ${CABIN_LABEL[st.cabin]} neste voo`:st.error?'Tenta novamente':`${query.returnDate?(stage==='outbound'?'Ida e volta · a partir de':'Total ida e volta'):'Total só ida'}<br>Para ${travellersText()}`;
 const cabins=stage==='outbound'?`<div class="offer-cabins" role="group" aria-label="Classe deste voo"><span>Classe</span>${Object.entries(CABIN_LABEL).map(([value,label])=>`<button type="button" data-card-cabin="${value}" data-offer="${esc(o.id)}" aria-pressed="${value===st.cabin}">${label}</button>`).join('')}</div>`:'';
 return `<article class="offer-card"><div class="offer-main">${brand(shown||o)}<div><div class="flight-times">${esc(first.departure.slice(11))} <span>→</span> <em>${esc(last.arrival.slice(11))}${plusDay(first.departure,last.arrival)}</em></div><div class="flight-dates">${esc(first.from)} → ${esc(last.to)} · ${dateText(first.departure.slice(0,10))}${first.departure.slice(0,10)!==last.arrival.slice(0,10)?' → '+dateText(last.arrival.slice(0,10)):''}</div><div class="flight-duration">${duration(o.duration)} · <b>${o.stops?o.stops+' escala(s)':'Directo'}</b> · Horários locais</div></div><div class="price-column">${priceHtml}<small>${note}</small><button class="primary select-flight" data-select="${esc(shown?.id||o.id)}" data-cabin="${st.cabin}" data-airlines="${esc(st.source||'')}" ${canSelect?'':'disabled'}>${canSelect?(stage==='return'?'Escolher volta':'Seleccionar'):st.loading?'A consultar…':'Indisponível'}</button></div></div>${cabins}<div class="offer-bottom"><span class="offer-badge">${stage==='return'?'Compatível com a ida seleccionada':'Tarifa sujeita a disponibilidade'}</span><button class="route-toggle" aria-expanded="false" aria-controls="route-${i}">Ver percurso <span>⌄</span></button></div><div class="route-details" id="route-${i}" hidden><h3>${stage==='return'?'Percurso de volta':'Percurso de ida'} · ${duration(o.duration)}</h3>${segments(shown||o)}<p class="route-disclaimer">Confirma as condições de bagagem e de alteração com a companhia antes de comprar.</p></div></article>`}
function renderOffers(){const e=stage==='return'?{data:returnData,error:returnError}:entry(selected);$('#search-time').textContent=e?.data?'Consultado às '+new Date(e.data.searchedAt).toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}):'';$('#cheapest-summary').textContent='—';$('#fastest-summary').textContent='—';$('#load-more').hidden=true;renderAlertBar();
 if(!e?.data){$('#result-count').textContent=e?.error?'Pesquisa indisponível':'A consultar voos…';$('#offers').innerHTML=e?.error?`<div class="state-card"><h3>Não foi possível consultar os voos</h3><p>${esc(e.error)}</p><button class="primary" id="retry-search">Tentar novamente</button></div>`:`<div class="state-card"><span class="spinner"></span><h3>${stage==='return'?'A encontrar regressos para a tua ida.':'A tua próxima viagem começa aqui.'}</h3><p>A consultar horários e preços disponíveis.</p></div>`;return}
 const offers=filtered(e.data);$('#result-count').textContent=`${offers.length} ${offers.length===1?'opção encontrada':'opções encontradas'} · ${Math.min(visible,offers.length)} visíveis`;
 if(offers.length){$('#cheapest-summary').textContent=price(Math.min(...offers.map(o=>o.amount)));$('#fastest-summary').textContent=duration(Math.min(...offers.map(o=>o.duration)))}
 $('#offers').innerHTML=offers.length?offers.slice(0,visible).map(card).join(''):'<div class="state-card"><h3>Não há voos para esta combinação.</h3><p>Experimenta outras datas ou limpa os filtros.</p><button class="primary" id="reset-empty">Limpar filtros</button></div>';
 $('#load-more').hidden=visible>=offers.length;$('#load-more').textContent=`Ver mais opções (${Math.max(0,offers.length-visible)} restantes)`;
}
function renderSummary(){if(stage!=='summary')return;const total=itineraryTotal(outbound,inbound,!!query.returnDate);$('#trip-summary').innerHTML=`<div class="summary-heading"><span class="eyebrow">A TUA PRÓXIMA VIAGEM</span><h2>Tudo pronto para rever.</h2><p>Confere os voos seleccionados e o preço do itinerário.</p></div><div class="summary-grid"><div>${[outbound,...(inbound?[inbound]:[])].map((o,i)=>`<article class="summary-leg"><div class="summary-leg-head"><h3>${i?'Volta':'Ida'} · ${dateText(i?query.returnDate:selected)}</h3><button class="secondary" data-step="${i?'return':'outbound'}">Alterar</button></div>${segments(o)}</article>`).join('')}</div><aside class="total-panel"><span>Total da viagem</span><strong>${price(total)}</strong><p>${query.returnDate?'Ida e volta':'Só ida'} · ${travellersText()} · ${CABIN_LABEL[query.cabin]}<br>${pricing?.rate?'Preço final em kwanzas para todos os passageiros, com taxas incluídas.':'Preço em reais para todos os passageiros, com taxas incluídas.'}</p><div class="total-divider"></div><p>O preço é confirmado antes do pagamento. A DOT emite o bilhete depois de o pagamento ser confirmado.</p><button class="primary" id="buy-trip" ${canBuy()?'':'disabled'}>Comprar esta viagem</button>${canBuy()?'':`<p class="buy-note">${pricing?.rate?'Actualiza a pesquisa para comprar esta viagem.':'A compra fica disponível quando o câmbio do dia for definido.'}</p>`}<button class="secondary" id="download-trip">Guardar itinerário</button><button class="secondary" data-step="${query.returnDate?'return':'outbound'}">Comparar outras opções</button></aside></div>`}
function render(){renderHeader();renderDates();renderAirlines();renderOffers();renderSummary()}
async function fetchDate(d){
 const q=queryFor(d),k=key(q),chosen=outbound,kind=stage==='return'?(d===query.returnDate?'return':'return-prefetch'):(d===selected?'view':'prefetch');
 const current=entry(d);if(current?.data&&fresh(current))return;
 if(datePending.has(k))return datePending.get(k);
 const task=(async()=>{try{
  if(q.selectedOutbound){const {selectedOutbound,...base}=q;const data=await resolveReturns(base,chosen,x=>request(x,kind));cache.set(k,{data,expires:expiryOf(data)});saveCache()}
  else await request(q,kind);
 }catch(e){cache.set(k,{error:e.message,expires:Date.now()+30000})}})();
 datePending.set(k,task);try{await task}finally{datePending.delete(k)}
}
async function loadSelected(){const gen=++generation;render();const p=fetchDate(selected);renderDates();await p;if(gen!==generation)return;render()}
async function loadReturn(){const gen=++generation;returnData=null;returnError=null;render();const p=fetchDate(query.returnDate);renderDates();await p;if(gen!==generation)return;const e=entry(query.returnDate);returnData=e?.data;returnError=e?.error;render()}
function selectDate(d){visible=8;airlines.clear();inbound=null;cardCabin.clear();if(stage==='return'){query.returnDate=d;updateURL();loadReturn()}else{restorePlace();const r=returnFor(d);selected=d;query.departureDate=d;query.returnDate=r;outbound=null;stage='outbound';updateURL();loadSelected()}}
function changeStep(step){if(step==='outbound'){++generation;restorePlace();cardCabin.clear();stage='outbound';outbound=null;inbound=null;returnData=null;visible=8;airlines.clear();centreDates();loadSelected()}else if(outbound){stage='return';inbound=null;visible=8;airlines.clear();centreDates();loadReturn()}}
$('#date-strip').onclick=e=>{const b=e.target.closest('[data-date]');if(b)selectDate(b.dataset.date)};
// The arrows only move the strip (indicative prices); a search runs when a day is chosen.
$('#previous-dates').onclick=()=>{windowStart=add(windowStart,-5);if(windowStart<firstDate())windowStart=firstDate();renderDates()};
$('#next-dates').onclick=()=>{windowStart=add(windowStart,5);renderDates()};
function jumpTo(d){if(!validDate(d)||d<firstDate()||d>lastDate())return;windowStart=add(d,-2);if(windowStart<firstDate())windowStart=firstDate();selectDate(d)}
$('#date-jump').onclick=e=>openCalendarPopover(e.currentTarget,{value:activeDate(),min:firstDate(),max:lastDate(),heading:stage==='return'?'Quando regressas?':'Quando começa a viagem?',outboundDay:stage==='return'?selected:null,priceQuery:calendarQuery(),foot:'Preços indicativos, com taxas incluídas. O valor final aparece nos resultados.',onSelect:jumpTo});
$('#nonstop').onchange=e=>{direct=e.target.checked;visible=8;airlines.clear();updateURL();render()};
$('#airline-filters').onchange=e=>{if(!e.target.matches('[data-airline]'))return;const a=e.target.dataset.airline;e.target.checked?airlines.add(a):airlines.delete(a);visible=8;renderDates();renderOffers()};
function resetFilters(){airlines.clear();direct=false;visible=8;$('#nonstop').checked=false;updateURL();render()}
$('#clear-filters').onclick=resetFilters;
for(const b of document.querySelectorAll('[data-sort]'))b.onclick=()=>{sort=b.dataset.sort;visible=8;document.querySelectorAll('[data-sort]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});renderOffers()};
$('#load-more').onclick=()=>{visible+=8;renderOffers()};
// Checkout receives the signed offers exactly as the server returned them.
function checkoutItinerary(){if(query.returnDate)return inbound&&inboundMeta?.outbound?.offer?{outbound:inboundMeta.outbound,inbound:{offer:inbound,query:inboundMeta.query,searchedAt:inboundMeta.searchedAt}}:null;return outbound&&outboundMeta?{outbound:{offer:outbound,query:outboundMeta.query,searchedAt:outboundMeta.searchedAt},inbound:null}:null}
function canBuy(){const it=checkoutItinerary();return !!pricing?.rate&&!!it&&!!it.outbound.offer.sig&&(!it.inbound||!!it.inbound.offer.sig)}
document.addEventListener('click',e=>{if(e.target.closest('#buy-trip')&&canBuy()){try{sessionStorage.setItem('dot-checkout-v1',JSON.stringify({itinerary:checkoutItinerary(),savedAt:Date.now()}))}catch{}location.href='/compra';return}});
document.addEventListener('click',e=>{const step=e.target.closest('[data-step]');if(step&&!step.disabled)changeStep(step.dataset.step);if(e.target.closest('#download-trip')){const text=`DOT VIAGENS — ITINERÁRIO CONSULTADO\n${travellersText()} · ${CABIN_LABEL[query.cabin]}\n\n`+[outbound,...(inbound?[inbound]:[])].map((o,i)=>`${i?'VOLTA':'IDA'}\n`+o.segments.map(s=>`${s.airline} ${s.number}: ${s.from} ${s.departure} → ${s.to} ${s.arrival}`).join('\n')).join('\n\n')+`\n\nTOTAL: ${price(itineraryTotal(outbound,inbound,!!query.returnDate))}\nNão é um bilhete ou reserva. Preço sujeito a alteração.`;const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='DOT-itinerario.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}});
// A tap anywhere on a flight card opens or closes its route, not only the small button
// (the "Seleccionar" button, links and the open route itself are left alone; selecting text too).
function toggleRoute(b){const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));document.getElementById(b.getAttribute('aria-controls')).hidden=open;b.innerHTML=`${open?'Ver percurso':'Ocultar percurso'} <span>⌄</span>`}
$('#offers').onclick=e=>{const cab=e.target.closest('[data-card-cabin]');if(cab){const c=cab.dataset.cardCabin,o=currentData()?.offers.find(x=>x.id===cab.dataset.offer);cardCabin.set(cab.dataset.offer,c);if(o&&c!==query.cabin&&!cabinState(o).offer)loadCabin(o,c);else renderOffers();return}const offer=e.target.closest('.offer-card');const b=e.target.closest('.route-toggle')||(offer&&!e.target.closest('[data-select],a,button,input,label,.route-details')&&!String(getSelection?.()||'')?offer.querySelector('.route-toggle'):null);if(b)toggleRoute(b);const pick=e.target.closest('[data-select]');if(pick&&!pick.disabled){const cabin=pick.dataset.cabin||query.cabin,only=pick.dataset.airlines||null,data=stage==='outbound'&&cabin!==query.cabin?cache.get(key(classQuery(cabin,only)))?.data:currentData(),o=data?.offers.find(o=>o.id===pick.dataset.select);if(!o)return;visible=8;airlines.clear();if(stage==='outbound'){outbound=o;outboundMeta={query:o.query||data.query,searchedAt:o.searchedAt||data.searchedAt};choosePlace(o,cabin,only);cardCabin.clear();if(query.returnDate){stage='return';centreDates();loadReturn()}else{stage='summary';render()}}else{inbound=o;inboundMeta={query:data.query,searchedAt:data.searchedAt,outbound:data.outbound};stage='summary';++generation;render()}$('#journey-steps').scrollIntoView({behavior:'smooth',block:'start'})}if(e.target.closest('#retry-search'))stage==='return'?loadReturn():loadSelected();if(e.target.closest('#reset-empty'))resetFilters()};
document.addEventListener('error',e=>{if(e.target.matches?.('.airline-logo')){const el=document.createElement('span');el.className='logo-fallback';el.textContent=(e.target.alt||'AV').slice(0,2);e.target.replaceWith(el)}},true);

// ── Price alert: SMS when the price of this search drops ─────────────────────
// The price is followed with the searches other visitors make for the same trip (no extra searches).
const alertKey=()=>'dot-alert:'+[query.origin,query.destination,selected,query.returnDate||'',query.passengers].join('|');
const alertDone=()=>{try{return sessionStorage.getItem(alertKey())==='1'}catch{return false}};
const cheapestSigned=data=>[...(data?.offers||[])].filter(o=>o.sig&&o.amount>0).sort((a,b)=>a.amount-b.amount)[0]||null;
function renderAlertBar(){const bar=$('#price-alert');if(!bar)return;const data=stage==='outbound'?entry(selected)?.data:null;const ok=!!(pricing?.rate&&cheapestSigned(data))&&!countrySearch()&&!query.children&&query.cabin==='economy';bar.hidden=!ok;if(!ok)return;const done=alertDone();bar.classList.toggle('done',done);const button=$('#alert-open');button.disabled=done;button.innerHTML=done?`${icon('check',15)} Aviso criado`:`${icon('bell',15)} Criar aviso`}
// The phone form uses the checkout styles: loaded only when someone opens the alert (the form waits for them).
let formCss=null;
function formStyles(){if(formCss)return formCss;const link=document.createElement('link');link.rel='stylesheet';link.href='/checkout.css';formCss=new Promise(done=>{link.onload=link.onerror=()=>done();setTimeout(done,4000)});document.head.append(link);return formCss}
async function openAlert(){
 const data=entry(selected)?.data,cheapest=cheapestSigned(data),dialog=$('#alert-dialog');if(!cheapest||!dialog)return;
 const styles=formStyles();
 const trip=`${placeName(query.origin)} → ${placeName(query.destination)} · ${dateText(selected)}${query.returnDate?` a ${dateText(query.returnDate)}`:''} · ${query.passengers} adulto(s)`;
 dialog.innerHTML=`<div class="alert-head"><span class="alert-icon">${icon('bell',22)}</span><button type="button" class="alert-close" aria-label="Fechar">×</button></div><h2 id="alert-title">Avisamos-te quando o preço baixar</h2><p class="alert-trip">${esc(trip)}<br>Hoje: desde <b>${price(cheapest.amount)}</b></p><p class="alert-rule">${icon('message',15)}<span>Vais receber um SMS quando o preço desta viagem baixar. No máximo 2 avisos: o primeiro quando baixar mais de 50&nbsp;000&nbsp;Kz e o segundo se baixar mais 100&nbsp;000&nbsp;Kz.</span></p><div id="alert-body" class="alert-body"><div class="alert-wait"><span class="spinner"></span></div></div>`;
 dialog.querySelector('.alert-close').onclick=()=>dialog.close();
 if(!dialog.open)dialog.showModal();
 const body=$('#alert-body');
 const create=async(who,name='')=>{body.innerHTML='<div class="alert-wait"><span class="spinner"></span> A criar o aviso…</div>';try{await api('/api/alerts',{method:'POST',body:{query:{origin:query.origin,destination:query.destination,departureDate:selected,returnDate:query.returnDate,passengers:query.passengers},offer:{offer:cheapest,query:data.query,searchedAt:data.searchedAt},names:{origin:placeName(query.origin),destination:placeName(query.destination)},name}});try{sessionStorage.setItem(alertKey(),'1')}catch{}renderAlertBar();body.innerHTML=`<div class="alert-done"><span class="alert-ok">${icon('checkCircle',28)}</span><h3>Aviso criado!</h3><p>Vais receber um SMS no <b>${esc(formatPhone(who.phone))}</b> quando o preço desta viagem baixar.</p><button type="button" class="primary" data-close>Combinado</button></div>`;body.querySelector('[data-close]').onclick=()=>dialog.close()}catch(error){if(error.status===401)return phoneStep();const stale=['OFFER_EXPIRED','INVALID_OFFER'].includes(error.code),final=error.code==='ALERT_LIMIT';body.innerHTML=`<div class="alert-error"><p class="form-error" role="alert">${esc(error.message)}</p><button type="button" class="secondary" data-retry>${stale?'Actualizar pesquisa':final?'Fechar':'Tentar novamente'}</button></div>`;body.querySelector('[data-retry]').onclick=()=>stale?location.reload():final?dialog.close():create(who,name)}};
 const phoneStep=()=>mountOtp(body,{purpose:'login',askName:true,submitLabel:'Enviar código por SMS',onSuccess:who=>create(who)});
 const [customer]=await Promise.all([auth.me(),styles]);
 if(!dialog.open)return;
 if(!customer)return phoneStep();
 body.innerHTML=`<form class="alert-account" novalidate>${customer.name?'':`<label class="form-field"><span>Nome completo</span><input name="name" autocomplete="name" maxlength="80" required placeholder="Como queres ser tratado"></label>`}<p>Vamos avisar-te no <b>${esc(formatPhone(customer.phone))}</b>${customer.name?` (${esc(customer.name)})`:''}.</p><p class="form-error" role="alert" hidden></p><button type="submit" class="primary">${icon('bell',16)} Criar aviso</button><button type="button" class="link-btn" data-other>Usar outro número</button></form>`;
 const form=body.querySelector('form');form.querySelector('[data-other]').onclick=phoneStep;form.querySelector('[name=name],[type=submit]').focus();
 form.onsubmit=e=>{e.preventDefault();const field=form.querySelector('[name=name]'),name=field?field.value.trim():'';if(field&&name.length<3){const box=form.querySelector('.form-error');box.textContent='Indica o teu nome completo.';box.hidden=false;return}create(customer,name)};
}
$('#alert-open')?.addEventListener('click',openAlert);
$('#alert-dialog')?.addEventListener('click',e=>{const d=e.currentTarget;if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()});

function applyCurrency(){const note=$('#fare-note');if(pricing?.rate){note.textContent='Preços finais em kwanzas para todos os passageiros da pesquisa, com taxas incluídas, sujeitos a alteração até ao pagamento. A menor tarifa de cada data corresponde às opções encontradas e aos filtros activos.'}else{note.textContent='Preços em reais (BRL) para todos os passageiros da pesquisa, com taxas incluídas e sujeitos a alteração. A compra em kwanzas fica disponível assim que a DOT definir o câmbio do dia.'}}
stickyHeader('.results-header');
// City names arrive with the airport catalogue, in the background: the flight search does not wait
// for it (on a slow phone the catalogue takes seconds). Codes are shown until then.
function applyAirports(list){names=Object.fromEntries(list.map(a=>[a.code,a.city]));names.CMN='Casablanca';airportNames=Object.fromEntries(list.map(a=>[a.code,a.name]));airportNames.LIS='Humberto Delgado';airportNames.CMN='Mohammed V';if(windowStart)render()}
async function init(){try{const iata=c=>/^[A-Z]{2,3}$/.test(c||'')||CITY_BY_CODE.has(c);if(!Number.isInteger(query.children||0)||(query.children||0)<0||(query.children||0)>3)throw Error('Escolhe até 3 crianças.');loadAirports().then(applyAirports).catch(()=>{});pricing=await loadPricing();applyCurrency();if(!iata(query.origin)||!iata(query.destination)||query.origin===query.destination||!validDate(selected)||selected<today||selected>maxDate||(query.returnDate&&(!validDate(query.returnDate)||query.returnDate<selected||query.returnDate>maxDate))||!Number.isInteger(query.passengers)||query.passengers<1||query.passengers>4)throw Error('Escolhe origem, destino e datas válidas para continuar.');if(shortLink)updateURL();windowStart=add(selected,-2);if(windowStart<today)windowStart=today;$('#nonstop').checked=direct;loadSelected()}catch(e){$('.date-section').hidden=true;$('.filters-panel').hidden=true;$('.sort-tabs').hidden=true;$('#offers').innerHTML=`<div class="state-card"><h3>Vamos preparar a tua viagem.</h3><p>${esc(e.message)}</p><a class="primary" href="/#pesquisa">Pesquisar voos</a></div>`;$('#result-count').textContent='Pesquisa indisponível'}}
init();
