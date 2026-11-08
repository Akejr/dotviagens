// Browser client for the DOT Viagens API. Network failures become Portuguese messages.

export class ApiError extends Error {
  constructor(message, status = 0, code = 'ERROR', data = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new ApiError(
      error?.name === 'TimeoutError'
        ? 'O pedido demorou demasiado. Verifica a ligação e tenta novamente.'
        : 'Sem ligação ao servidor. Verifica a internet e tenta novamente.',
      0,
      'NETWORK',
    );
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new ApiError(data?.error || 'Não foi possível concluir o pedido.', response.status, data?.code || 'ERROR', data);
  return data;
}

export const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const formatKz = value =>
  new Intl.NumberFormat('pt-AO', { style: 'currency', currency: 'AOA', maximumFractionDigits: 0 }).format(Number(value) || 0);

export const formatBrl = value =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);

export const formatPhone = phone =>
  phone ? `+244 ${String(phone).slice(0, 3)} ${String(phone).slice(3, 6)} ${String(phone).slice(6)}` : '';

export const formatDate = iso =>
  iso ? new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)) : '';

export const formatDateTime = iso =>
  iso ? new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Luanda' }).format(new Date(iso)) : '';

export const duration = minutes => `${Math.floor((minutes || 0) / 60)}h ${(minutes || 0) % 60}min`;

export const auth = {
  me: () => api('/api/auth/me').then(data => data.customer).catch(() => null),
  requestOtp: (phone, purpose) => api('/api/auth/otp/request', { method: 'POST', body: { phone, purpose } }),
  verifyOtp: payload => api('/api/auth/otp/verify', { method: 'POST', body: payload }).then(data => data.customer),
  logout: () => api('/api/auth/logout', { method: 'POST', body: {} }),
};

// Sticky headers get the highlighted state once the page scrolls.
export function stickyHeader(selector = '.results-header') {
  const header = document.querySelector(selector);
  if (!header) return;
  let ticking = false;
  const update = () => {
    header.classList.toggle('scrolled', scrollY > 24);
    ticking = false;
  };
  addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
}
