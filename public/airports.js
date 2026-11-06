let promise;
export function loadAirports(){return promise ||= fetch('/airports.json').then(r=>{if(!r.ok)throw Error('Não foi possível carregar os aeroportos.');return r.json()}).then(rows=>{const names=new Intl.DisplayNames(['pt'],{type:'region'});return rows.map(a=>({...a,country:names.of(a.countryCode)||a.country}))}).catch(e=>{promise=null;throw e})}
