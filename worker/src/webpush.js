// Web Push send adapter around @block65/webcrypto-web-push (pure WebCrypto —
// VAPID ES256 + aes128gcm, no Node compat needed). Returns the raw push-service
// Response so the caller can delete dead subscriptions on 404/410.
import { buildPushPayload } from '@block65/webcrypto-web-push';

export async function sendNotification(subscription, payload, vapid) {
  const message = {
    data: payload,
    // TTL header is mandatory for Apple/Mozilla push services.
    options: { ttl: 86400, urgency: 'normal' },
  };
  const init = await buildPushPayload(message, {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: subscription.keys,
  }, {
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });
  return fetch(subscription.endpoint, init);
}
