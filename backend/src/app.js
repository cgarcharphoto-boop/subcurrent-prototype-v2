import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { ticketsRouter, fulfillCheckout } from './routes/tickets.js';
import { verifyWebhook } from './services/payments.js';
import { ownerRouter } from './routes/owner.js';
import { pushRouter } from './routes/push.js';
import { feedRouter, moderationRouter } from './routes/feed.js';
import { dmRouter } from './routes/dms.js';
import { messagesRouter, inboxRouter } from './routes/messages.js';
import { crewRouter, crewAdminRouter } from './routes/crew.js';
import { booksRouter } from './routes/books.js';
import { followsRouter } from './routes/follows.js';
import { socialLive } from './services/social.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { paymentsLive } from './services/payments.js';
import { smsLive } from './services/sms.js';
import { flyerAiLive } from './services/flyerAI.js';
import { pushConfigured } from './services/push.js';

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins.length ? env.corsOrigins : true,
    credentials: true,
  })
);
// Stripe signs the exact bytes it sent, so this route reads the raw body and
// has to come before express.json.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.status ? e.message : 'Bad signature' });
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await fulfillCheckout(event.data.object);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('stripe webhook', e);
    res.status(500).json({ error: 'Fulfillment failed; Stripe will retry' });
  }
});
app.use(express.json({ limit: '8mb' })); // flyer photos ride in as base64
app.use(morgan(process.env.NODE_ENV === 'test' ? 'tiny' : 'dev'));

// Generous overall ceiling plus a tight one on auth to blunt credential stuffing.
app.use(rateLimit({ windowMs: 60_000, max: 300 }));
// Tight limit only where passwords are checked or accounts are created.
const credentialLimit = rateLimit({ windowMs: 60_000, max: 20 });
app.use(['/auth/fan/login', '/auth/fan/signup', '/auth/fan/demo', '/auth/owner/login', '/auth/owner/password', '/crew/demo'], credentialLimit);

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    integrations: { payments: paymentsLive, checkout: paymentsLive && Boolean(env.stripeWebhookSecret), sms: smsLive, flyerAi: flyerAiLive, push: pushConfigured, crew: true, ...Object.fromEntries(Object.entries(socialLive).map(([k, v]) => ['social_' + k, v])) },
  })
);

app.use('/auth', authRouter);
app.use('/events', eventsRouter);
app.use('/tickets', ticketsRouter);
app.use('/owner', ownerRouter);
app.use('/push', pushRouter);
app.use('/feed', feedRouter);
app.use('/messages', messagesRouter);
app.use('/owner/inbox', inboxRouter);
app.use('/owner/moderation', moderationRouter);
app.use('/dms', dmRouter);
app.use('/crew', crewRouter);
app.use('/owner/crew', crewAdminRouter);
app.use('/owner/books', booksRouter);
app.use('/follows', followsRouter);

app.use(notFound);
app.use(errorHandler);
