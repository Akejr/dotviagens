export async function searchFlights(query){
 const response=await fetch('/api/flights/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query),signal:AbortSignal.timeout(55000)});
 let data;try{data=await response.json()}catch{throw Error('A pesquisa está temporariamente indisponível.')}
 if(!response.ok)throw Error(data.error||'Não foi possível pesquisar.');return data;
}
