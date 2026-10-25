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
