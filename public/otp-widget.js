// Phone + SMS code (Nsangu) widget, shared by checkout, "Minhas viagens" and admin.

import { auth, esc } from './api.js';
import { icon } from './icons.js';

const digits = value => String(value || '').replace(/\D/g, '');

export function mountOtp(container, { purpose = 'login', title, subtitle, askContact = false, initial = {}, submitLabel = 'Enviar código por SMS', onSuccess }) {
  let phone = initial.phone || '';
  let name = initial.name || '';
  let email = initial.email || '';
  let timer = null;

  function phoneStep(error = '') {
    clearInterval(timer);
    container.innerHTML = `
      <form class="otp-card" novalidate>
        ${title ? `<h2>${esc(title)}</h2>` : ''}
        ${subtitle ? `<p class="otp-sub">${esc(subtitle)}</p>` : ''}
        ${askContact ? `
          <label class="form-field"><span>Nome completo</span><input name="name" autocomplete="name" required maxlength="80" value="${esc(name)}" placeholder="Como queres ser tratado"></label>
          <label class="form-field"><span>E-mail</span><input name="email" type="email" autocomplete="email" required maxlength="160" value="${esc(email)}" placeholder="nome@exemplo.com"></label>` : ''}
        <label class="form-field"><span>Número de telemóvel</span>
          <div class="input-prefix"><b>+244</b><input name="phone" inputmode="numeric" autocomplete="tel-national" required maxlength="11" value="${esc(phone)}" placeholder="9XX XXX XXX"></div>
        </label>
        <p class="form-hint">${icon('lock', 14)} Enviamos um código de 6 dígitos por SMS para confirmar o número.</p>
        <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
        <button class="primary otp-submit" type="submit">${icon('message', 17)} ${esc(submitLabel)}</button>
      </form>`;
    const form = container.querySelector('form');
    form.querySelector(askContact ? '[name=name]' : '[name=phone]').focus();
    form.onsubmit = async event => {
      event.preventDefault();
      const errorBox = form.querySelector('.form-error');
      const field = key => form.querySelector(`[name=${key}]`);
      phone = digits(field('phone').value).replace(/^244(?=9\d{8}$)/, '');
      if (askContact) {
        name = field('name').value.trim();
        email = field('email').value.trim();
        if (name.length < 3) return showError(errorBox, 'Indica o teu nome completo.');
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return showError(errorBox, 'Indica um e-mail válido.');
      }
      if (!/^9\d{8}$/.test(phone)) return showError(errorBox, 'O número tem 9 dígitos e começa por 9.');
      const button = form.querySelector('button');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> A enviar…';
      try {
        const result = await auth.requestOtp(phone, purpose);
        codeStep(result);
      } catch (error) {
        button.disabled = false;
        button.innerHTML = `${icon('message', 17)} ${esc(submitLabel)}`;
        showError(errorBox, error.message);
      }
    };
  }

  function codeStep(result, error = '') {
    const sender = result?.sender && /^\d+$/.test(result.sender)
      ? `<p class="form-hint">${icon('info', 14)} A mensagem pode chegar do número <b>${esc(result.sender)}</b> (rede Movicel).</p>`
      : '';
    container.innerHTML = `
      <form class="otp-card" novalidate>
        <h2>Confirma o teu número</h2>
        <p class="otp-sub">Escreve o código que enviámos para <b>${esc(result?.maskedPhone || `+244 ${phone}`)}</b>. É válido durante 5 minutos.</p>
        <label class="form-field"><span>Código de 6 dígitos</span>
          <input class="otp-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="••••••">
        </label>
        ${sender}
        <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
        <button class="primary otp-submit" type="submit">${icon('shield', 17)} Confirmar código</button>
        <div class="otp-actions">
          <button type="button" class="link-btn" data-change>${icon('arrowLeft', 14)} Alterar número</button>
          <button type="button" class="link-btn" data-resend disabled>Reenviar código</button>
        </div>
      </form>`;
    const form = container.querySelector('form');
    const input = form.querySelector('[name=code]');
    const resend = form.querySelector('[data-resend]');
    input.focus();
    input.oninput = () => {
      input.value = digits(input.value).slice(0, 6);
      if (input.value.length === 6) form.requestSubmit();
    };
    let left = result?.resendIn || 60;
    const tick = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Reenviar em ${left}s` : 'Reenviar código';
      left -= 1;
      if (left < -1) clearInterval(timer);
    };
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    tick();
    form.querySelector('[data-change]').onclick = () => phoneStep();
    resend.onclick = async () => {
      resend.disabled = true;
      try {
        codeStep(await auth.requestOtp(phone, purpose));
      } catch (error) {
        showError(form.querySelector('.form-error'), error.message);
        resend.disabled = false;
      }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const errorBox = form.querySelector('.form-error');
      if (input.value.length !== 6) return showError(errorBox, 'O código tem 6 dígitos.');
      const button = form.querySelector('.otp-submit');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> A confirmar…';
      try {
        const customer = await auth.verifyOtp({ phone, code: input.value, purpose, ...(askContact ? { name, email } : {}) });
        clearInterval(timer);
        onSuccess?.(customer, { name, email });
      } catch (error) {
        button.disabled = false;
        button.innerHTML = `${icon('shield', 17)} Confirmar código`;
        input.value = '';
        input.focus();
        showError(errorBox, error.message);
      }
    };
  }

  function showError(box, message) {
    box.textContent = message;
    box.hidden = false;
  }

  phoneStep();
  return { reset: () => phoneStep() };
}
