// Vercel Function: every /api/* request (rewritten here by vercel.json) runs the same
// router as the Cloudflare Worker. Variables come from the Vercel project settings.
import { handleApi } from '../server/router.mjs';

// Same contract as waitUntil() from @vercel/functions (read from Vercel's request context):
// logs, payment SMS and invoices keep running after the response is sent.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const FUNCTION_PATHS = new Set(['/api', '/api/', '/api/index', '/api/index.mjs']);

function backgroundRunner(pending) {
  const vercelWaitUntil = globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil;
  return promise => {
    if (typeof vercelWaitUntil === 'function') vercelWaitUntil(promise);
    else pending.push(promise);
  };
}

// The router compares the browser Origin with the request URL and builds callback links
// from it: rebuild the public URL (https + domain) and the original /api path.
export function publicRequest(request) {
  const url = new URL(request.url);
  const proto = (request.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0].trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  if (host) url.host = host;
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    if (FUNCTION_PATHS.has(url.pathname)) url.pathname = `/api/${original.replace(/^\/+/, '')}`;
  }
  if (url.href === request.url) return request;
  const init = { method: request.method, headers: request.headers, signal: request.signal };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function handle(request) {
  const pending = [];
  const response = await handleApi(publicRequest(request), process.env, { waitUntil: backgroundRunner(pending) });
  // Without Vercel's waitUntil (local tests), finish the background work before answering.
  if (pending.length) await Promise.allSettled(pending);
  return response;
}

const vercelFunction = { fetch: handle };
export default vercelFunction;
