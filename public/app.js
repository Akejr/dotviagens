import {searchFlights} from './services.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('pt-PT',{style:'currency',currency:'EUR'}).format(n);
const duration=n=>`${Math.floor(n/60)}h ${n%60}min`;
const $=s=>document.querySelector(s);let trip='return';
const names={NBJ:'Luanda',LIS:'Lisboa',GRU:'São Paulo',CPT:'Cidade do Cabo',DXB:'Dubai'};
const codes={NBJ:'NBJ · António Agostinho Neto',LIS:'LIS · Humberto Delgado',GRU:'GRU · Guarulhos',CPT:'CPT · Cape Town International',DXB:'DXB · Dubai International'};
const iso=d=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);const now=new Date();const start=new Date(now);start.setDate(start.getDate()+30);const end=new Date(start);end.setDate(end.getDate()+10);
$('#departure').min=iso(now);$('#departure').value=iso(start);$('#return').min=iso(start);$('#return').value=iso(end);
$('#departure').addEventListener('change',()=>{$('#return').min=$('#departure').value;if($('#return').value<$('#departure').value)$('#return').value=$('#departure').value});
document.querySelectorAll('[data-trip]').forEach(b=>b.addEventListener('click',()=>{trip=b.dataset.trip;document.querySelectorAll('[data-trip]').forEach(t=>t.classList.toggle('selected',t===b));$('#return-field').hidden=trip==='oneway';$('#return').required=trip==='return';}));
$('#origin').addEventListener('change',()=>$('#origin-code').textContent=codes[$('#origin').value]);
// The selects only hold the airports already chosen: copy the option across before swapping.
const keep=(select,option)=>{if(option&&![...select.options].some(o=>o.value===option.value))select.append(new Option(option.text,option.value))};
$('#swap').addEventListener('click',()=>{const o=$('#origin'),d=$('#destination');if(!d.value)return;const from=o.selectedOptions[0],to=d.selectedOptions[0];keep(o,to);keep(d,from);o.value=to.value;d.value=from?from.value:'';o.dispatchEvent(new Event('change'));});
document.querySelectorAll('[data-region]:not(.destination-card)').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.filters button').forEach(t=>t.classList.toggle('selected',t===b));document.querySelectorAll('.destination-card').forEach(c=>c.hidden=b.dataset.region!=='all'&&c.dataset.region!==b.dataset.region)}));
document.querySelectorAll('.destination-card').forEach(b=>b.addEventListener('click',()=>{$('#destination').value=b.dataset.code;$('#pesquisa').scrollIntoView({behavior:'smooth',block:'center'});$('#departure').focus({preventScroll:true})}));
const modal=$('#modal');function show(content){$('#modal-content').innerHTML=content;modal.showModal()};$('.close').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
document.querySelectorAll('[data-dialog="help"]').forEach(b=>b.onclick=()=>show('<span class="eyebrow">ESTAMOS POR PERTO</span><h2>Vamos falar da tua próxima viagem?</h2><p>A equipa DOT ajuda-te a escolher o voo, a pagar em kwanzas e a acompanhar a emissão do bilhete. Fala connosco pelo WhatsApp.</p><a class="primary" href="https://wa.me/244931343433" target="_blank" rel="noopener">Falar com a DOT ↗</a>'));
$('#search-form').addEventListener('submit',async e=>{e.preventDefault();const origin=$('#origin').value,destination=$('#destination').value;if(origin===destination){$('#form-error').textContent='Escolhe um destino diferente da origem.';$('#form-error').hidden=false;$('#destination-trigger').focus();return}if(!destination){$('#form-error').textContent='Escolhe o teu destino para continuar.';$('#form-error').hidden=false;$('#destination-trigger').focus();$('#destination-trigger').click();return}if(!$('#departure').value||$('#departure').value<$('#departure').min||(trip==='return'&&(!$('#return').value||$('#return').value<$('#departure').value))){$('#form-error').textContent='Confirma as datas da tua viagem.';$('#form-error').hidden=false;return}$('#form-error').hidden=true;$('#results').hidden=true;const query={origin,destination,departureDate:$('#departure').value,returnDate:trip==='return'?$('#return').value:null,passengers:Number($('#passengers').value),cabin:'economy'};location.href='/resultados?'+new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([,v])=>v!==null))).toString();});
$('#destination').addEventListener('change',()=>$('#destination').setCustomValidity(''));

// Both load at the same time; neither waits for the other.
import('./interactions.js');
import('./carousel.js');
