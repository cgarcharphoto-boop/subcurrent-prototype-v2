import { env } from '../env.js';

// Real the moment STRIPE_SECRET_KEY is set. Until then, mock mode marks the
// order paid immediately so the rest of the app (tickets, check-in, push)
// can be built and tested end to end without a Stripe account.
let stripeClient = null;
export const paymentsLive = Boolean(env.stripeSecretKey);
// Server-side confirmation with Stripe's test card only works in test mode.
// A live key needs a client-side card form (Checkout or Payment Element).
export const paymentsTestMode = env.stripeSecretKey.startsWith('sk_test_') || env.stripeSecretKey.startsWith('rk_test_');

async function getStripe() {
  if (!stripeClient) {
    const { default: Stripe } = await import('stripe');
    stripeClient = new Stripe(env.stripeSecretKey);
  }
  return stripeClient;
}

export async function charge({ amountCents, currency = 'usd', description, idempotencyKey }) {
  if (!paymentsLive) {
    return { ok: true, mock: true, ref: `mock_${idempotencyKey}`, status: 'succeeded' };
  }
  if (!paymentsTestMode) {
    throw Object.assign(new Error('Live Stripe keys need the card form; use a test key (sk_test_) for the prototype'), { status: 503 });
  }
  const stripe = await getStripe();
  const intent = await stripe.paymentIntents.create(
    {
      amount: amountCents, currency, description, confirm: true, payment_method: 'pm_card_visa',
      // Server-side confirm can't follow a redirect, so card-only.
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    },
    { idempotencyKey }
  );
  return { ok: intent.status === 'succeeded', mock: false, ref: intent.id, status: intent.status };
}

// ---- Stripe Checkout: the fan types their own card on Stripe's page ----
// Order details ride in session metadata, so fulfillment needs nothing but
// the session id (from the webhook or the fan's return to the app).
export async function createCheckout({ orderId, fanId, eventId, tierId, tierName, eventTitle, unitCents, qty, holderName, successUrl, cancelUrl }) {
  const stripe = await getStripe();
  return stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [{ quantity: qty, price_data: { currency: 'usd', unit_amount: unitCents, product_data: { name: `${eventTitle}: ${tierName}` } } }],
      metadata: { orderId, fanId, eventId, tierId, qty: String(qty), holderName },
      client_reference_id: orderId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    },
    { idempotencyKey: `checkout-${orderId}` }
  );
}

export async function getCheckout(sessionId) {
  const stripe = await getStripe();
  return stripe.checkout.sessions.retrieve(sessionId);
}

export async function refund(paymentIntentId) {
  const stripe = await getStripe();
  return stripe.refunds.create({ payment_intent: paymentIntentId });
}

// Returns the verified event, or throws if the signature doesn't match.
export async function verifyWebhook(rawBody, signature) {
  if (!env.stripeWebhookSecret) throw Object.assign(new Error('Webhook secret not set'), { status: 503 });
  const stripe = await getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
}
