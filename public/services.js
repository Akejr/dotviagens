export async function searchFlights(query,meta={}){
 let response;
 try{response=await fetch('/api/flights/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...query,...meta}),signal:AbortSignal.timeout(55000)})}
 catch(e){throw Error(e?.name==='TimeoutError'?'A pesquisa demorou demasiado. Tenta novamente.':'Sem ligação ao servidor. Verifica a internet e tenta novamente.')}
 let data;try{data=await response.json()}catch{throw Error('A pesquisa está temporariamente indisponível.')}
 if(!response.ok)throw Error(data.error||'Não foi possível pesquisar.');return data;
}
