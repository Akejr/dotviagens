// Sends an SMS and records it in sms_messages, so the admin can follow every message.
// The OTP text is never stored: only the provider id, status and sender.

import { sendSms } from './sms.mjs';

export async function sendAndRecord(env, store, { phone, text, category, purpose, idempotencyKey, bookingId = null }, deps = {}) {
  let message = null;
  let failure = null;
  try {
    message = await sendSms(env, { to: phone, text, category, idempotencyKey }, deps);
  } catch (error) {
    failure = error;
  }
  await store
    .upsert('sms_messages', [{
      idempotency_key: idempotencyKey,
      phone,
      category,
      purpose,
      booking_id: bookingId,
      provider_id: message?.id ?? null,
      status: message?.status ?? 'failed',
      sender: message?.from ?? null,
      segments: message?.segments ?? null,
      failure_code: message?.failureCode ?? null,
      error: failure ? String(failure.code || 'error') : null,
    }], 'idempotency_key')
    .catch(error => console.error('sms record failed:', error.message));
  if (failure) throw failure;
  return message;
}
