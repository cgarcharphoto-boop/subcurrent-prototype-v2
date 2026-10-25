import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Stripe is mocked: sessions live in this map, and a webhook "signature" is
// valid only when it equals 'good'.
const sessions = new Map();
const refunds = [];
vi.mock('stripe', () => ({
  default: class {
    checkout = {
      sessions: {
        create: async (p) => {
          const s = { id: 'cs_test_' + sessions.size, url: 'https://checkout.stripe.test/' + sessions.size, metadata: p.metadata, payment_status: 'unpaid', status: 'open', success_url: p.success_url };
          sessions.set(s.id, s);
          return s;
        },
        retrieve: async (id) => {
          if (!sessions.has(id)) throw new Error('No such session');
          return sessions.get(id);
        },
      },
    };
    refunds = { create: async (p) => refunds.push(p.payment_intent) };
    webhooks = {
      constructEvent: (raw, sig) => {
        if (sig !== 'good') throw new Error('bad sig');
        return JSON.parse(raw.toString());
      },
    };
  },
}));

let app, prisma, sign, fanToken, fanId, otherToken, event, tier;
const pay = (id) => Object.assign(sessions.get(id), { payment_status: 'paid', status: 'complete', payment_intent: 'pi_' + id });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
  ({ app } = await import('../src/app.js'));
  ({ prisma } = await import('../src/db.js'));
  ({ sign } = await import('../src/middleware/auth.js'));
  const fan = await prisma.fan.create({ data: { email: `co-${Date.now()}@t.test`, name: 'Card Fan', passwordHash: 'x' } });
  const other = await prisma.fan.create({ data: { email: `co2-${Date.now()}@t.test`, name: 'Other Fan', passwordHash: 'x' } });
  fanId = fan.id;
  fanToken = sign({ sub: fan.id, kind: 'fan' });
  otherToken = sign({ sub: other.id, kind: 'fan' });
  event = await prisma.event.create({
    data: {
      title: 'Checkout Night', slug: `checkout-${Date.now()}`, status: 'on_sale',
      startAt: new Date(Date.now() + 86400_000), doorsAt: new Date(Date.now() + 80000_000),
      tiers: { create: [{ name: 'GA', priceCents: 2800, capacity: 3 }] },
    },
    include: { tiers: true },
  });
  tier = event.tiers[0];
});

const start = (qty = 1, token = fanToken) =>
  request(app).post('/tickets/checkout').set('Authorization', `Bearer ${token}`).set('Origin', 'https://evil.example')
    .send({ eventId: event.id, tierId: tier.id, qty, holderName: 'Card Fan' });

describe('Stripe Checkout', () => {
  it('starts a session without issuing tickets, and returns to our origin, not the caller\'s', async () => {
    const r = await start(2);
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(sessions.get(r.body.sessionId).success_url).not.toContain('evil.example');
    expect(await prisma.ticket.count({ where: { orderId: r.body.orderId } })).toBe(0);
    const unpaid = await request(app).get(`/tickets/checkout/${r.body.sessionId}`).set('Authorization', `Bearer ${fanToken}`);
    expect(unpaid.body.status).toBe('unpaid');
  });

  it('issues tickets once even when the webhook and the return race', async () => {
    const r = await start(2);
    pay(r.body.sessionId);
    const evt = JSON.stringify({ type: 'checkout.session.completed', data: { object: sessions.get(r.body.sessionId) } });
    const [a, b] = await Promise.all([
      request(app).get(`/tickets/checkout/${r.body.sessionId}`).set('Authorization', `Bearer ${fanToken}`),
      request(app).post('/webhooks/stripe').set('stripe-signature', 'good').set('Content-Type', 'application/json').send(evt),
    ]);
    expect(a.body.status).toBe('paid');
    expect(b.body.received).toBe(true);
    expect(await prisma.ticket.count({ where: { orderId: r.body.orderId } })).toBe(2);
    expect((await prisma.tier.findUnique({ where: { id: tier.id } })).soldCount).toBe(2);
    const again = await request(app).get(`/tickets/checkout/${r.body.sessionId}`).set('Authorization', `Bearer ${fanToken}`);
    expect(again.body.tickets).toHaveLength(2);
  });

  it('refunds instead of overselling when the tier filled up during checkout', async () => {
    const r = await start(1);
    const r2 = await start(1);
    pay(r.body.sessionId);
    pay(r2.body.sessionId);
    expect((await request(app).get(`/tickets/checkout/${r.body.sessionId}`).set('Authorization', `Bearer ${fanToken}`)).body.status).toBe('paid');
    const late = await request(app).get(`/tickets/checkout/${r2.body.sessionId}`).set('Authorization', `Bearer ${fanToken}`);
    expect(late.body.status).toBe('refunded');
    expect(refunds).toContain('pi_' + r2.body.sessionId);
    expect((await prisma.tier.findUnique({ where: { id: tier.id } })).soldCount).toBe(3);
  });

  it('won\'t show one fan another fan\'s checkout', async () => {
    const r = await request(app).post('/tickets/checkout').set('Authorization', `Bearer ${fanToken}`).send({ eventId: event.id, tierId: tier.id, qty: 1, holderName: 'x' });
    expect(r.status).toBe(409); // sold out now
    const id = [...sessions.keys()][0];
    expect((await request(app).get(`/tickets/checkout/${id}`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
  });

  it('rejects a webhook with a bad signature', async () => {
    const r = await request(app).post('/webhooks/stripe').set('stripe-signature', 'forged').set('Content-Type', 'application/json').send('{}');
    expect(r.status).toBe(400);
  });

  it('reports checkout as live in health', async () => {
    expect((await request(app).get('/health')).body.integrations.checkout).toBe(true);
  });
});
