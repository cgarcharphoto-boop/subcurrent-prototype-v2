import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireFan } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { newQrSecret, currentCode } from '../services/tickets.js';
import { charge, paymentsLive, createCheckout, getCheckout, refund } from '../services/payments.js';
import { env } from '../env.js';
import { notifyFan } from '../services/push.js';

export const ticketsRouter = Router();

ticketsRouter.get(
  '/mine',
  requireFan,
  asyncRoute(async (req, res) => {
    const tickets = await prisma.ticket.findMany({
      where: { fanId: req.auth.sub },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(
      tickets.map((t) => ({
        id: t.id,
        event: { title: t.event.title, startAt: t.event.startAt, slug: t.event.slug },
        tierName: t.tierName,
        holderName: t.holderName,
        source: t.source,
        checkedInAt: t.checkedInAt,
        liveCode: currentCode(t.qrSecret),
      }))
    );
  })
);

// Poll-friendly endpoint so the client can refresh just the rotating code
// every 10s without re-fetching the whole ticket list.
ticketsRouter.get(
  '/:id/code',
  requireFan,
  asyncRoute(async (req, res) => {
    const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!t || t.fanId !== req.auth.sub) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ code: currentCode(t.qrSecret), refreshMs: 10_000 });
  })
);

const purchaseSchema = z.object({
  eventId: z.string(),
  tierId: z.string(),
  qty: z.number().int().min(1).max(8),
  holderName: z.string().min(1).max(80),
});

ticketsRouter.post(
  '/purchase',
  requireFan,
  asyncRoute(async (req, res) => {
    const body = purchaseSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      const tier = await tx.tier.findUnique({ where: { id: body.tierId } });
      if (!tier || tier.eventId !== body.eventId) throw httpError(404, 'Tier not found for this event');
      if (!tier.salesOpen) throw httpError(409, 'Sales are closed for this tier');
      if (tier.soldCount + body.qty > tier.capacity) throw httpError(409, 'Not enough tickets left');

      const order = await tx.order.create({
        data: { fanId: req.auth.sub, totalCents: tier.priceCents * body.qty, status: 'pending' },
      });

      const payment = await charge({
        amountCents: order.totalCents,
        description: `${body.qty}x ${tier.name}`,
        idempotencyKey: order.id,
      });
      if (!payment.ok) throw httpError(402, 'Payment failed');

      await tx.order.update({
        where: { id: order.id },
        data: { status: 'paid', paymentRef: payment.ref },
      });
      await tx.tier.update({ where: { id: tier.id }, data: { soldCount: { increment: body.qty } } });

      const tickets = await Promise.all(
        Array.from({ length: body.qty }).map(() =>
          tx.ticket.create({
            data: {
              eventId: body.eventId,
              fanId: req.auth.sub,
              orderId: order.id,
              tierName: tier.name,
              holderName: body.holderName,
              qrSecret: newQrSecret(),
            },
          })
        )
      );

      return { order, tickets, mockPayment: payment.mock };
    });

    res.status(201).json({
      orderId: result.order.id,
      mockPayment: result.mockPayment,
      tickets: result.tickets.map((t) => ({ id: t.id, tierName: t.tierName })),
    });
  })
);

// ---- Stripe Checkout ----
// Where Stripe sends the fan back: the app's own origin when it's one we
// serve, otherwise the production URL. Never an arbitrary caller-chosen URL.
function appOrigin(req) {
  const allowed = [
    ...env.corsOrigins,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
  ].filter(Boolean);
  const origin = req.headers.origin;
  if (origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return origin;
  return allowed[0] || 'http://localhost:4000';
}

ticketsRouter.post(
  '/checkout',
  requireFan,
  asyncRoute(async (req, res) => {
    if (!paymentsLive) throw httpError(409, 'Card checkout is off; use /tickets/purchase');
    const body = purchaseSchema.parse(req.body);
    const tier = await prisma.tier.findUnique({ where: { id: body.tierId }, include: { event: true } });
    if (!tier || tier.eventId !== body.eventId) throw httpError(404, 'Tier not found for this event');
    if (!tier.salesOpen) throw httpError(409, 'Sales are closed for this tier');
    if (tier.soldCount + body.qty > tier.capacity) throw httpError(409, 'Not enough tickets left');
    const order = await prisma.order.create({ data: { fanId: req.auth.sub, totalCents: tier.priceCents * body.qty, status: 'pending' } });
    const base = appOrigin(req);
    const session = await createCheckout({
      orderId: order.id, fanId: req.auth.sub, eventId: tier.eventId, tierId: tier.id, tierName: tier.name, eventTitle: tier.event.title,
      unitCents: tier.priceCents, qty: body.qty, holderName: body.holderName,
      successUrl: `${base}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/?checkout=cancel`,
    });
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: session.id } });
    res.status(201).json({ orderId: order.id, url: session.url, sessionId: session.id });
  })
);

// Issue tickets for a paid session. Safe to call from both the webhook and
// the fan's return: only the call that flips the order from pending to paid
// creates tickets. If the tier sold out meanwhile, the payment is refunded.
export async function fulfillCheckout(session) {
  const m = session.metadata || {};
  if (!m.orderId) return { status: 'unknown' };
  if (session.payment_status !== 'paid') return { status: session.status === 'expired' ? 'expired' : 'unpaid', orderId: m.orderId };
  const qty = Number(m.qty);
  const out = await prisma.$transaction(async (tx) => {
    const won = await tx.order.updateMany({ where: { id: m.orderId, status: 'pending' }, data: { status: 'paid', paymentRef: session.payment_intent } });
    if (won.count === 0) return { already: true };
    const tier = await tx.tier.findUnique({ where: { id: m.tierId } });
    if (!tier || tier.soldCount + qty > tier.capacity) {
      await tx.order.update({ where: { id: m.orderId }, data: { status: 'refunded' } });
      return { soldOut: true };
    }
    await tx.tier.update({ where: { id: tier.id }, data: { soldCount: { increment: qty } } });
    for (let i = 0; i < qty; i++) {
      await tx.ticket.create({ data: { eventId: m.eventId, fanId: m.fanId, orderId: m.orderId, tierName: tier.name, holderName: m.holderName, qrSecret: newQrSecret() } });
    }
    return { issued: true };
  });
  if (out.soldOut) {
    await refund(session.payment_intent).catch(() => {});
    return { status: 'refunded', orderId: m.orderId };
  }
  const order = await prisma.order.findUnique({ where: { id: m.orderId }, include: { tickets: true } });
  return { status: order.status, orderId: order.id, tickets: order.tickets.map((t) => ({ id: t.id, tierName: t.tierName })) };
}

ticketsRouter.get(
  '/checkout/:sessionId',
  requireFan,
  asyncRoute(async (req, res) => {
    if (!paymentsLive) throw httpError(409, 'Card checkout is off');
    const session = await getCheckout(req.params.sessionId).catch(() => null);
    if (!session || session.metadata?.fanId !== req.auth.sub) throw httpError(404, 'Checkout not found');
    res.json(await fulfillCheckout(session));
  })
);

// Send a ticket to another fan by @handle. The code secret rotates, so a
// screenshot of the old code is dead the moment the transfer lands.
const transferSchema = z.object({ handle: z.string().trim().min(2).max(30) });

ticketsRouter.post(
  '/:id/transfer',
  requireFan,
  asyncRoute(async (req, res) => {
    const { handle } = transferSchema.parse(req.body);
    const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
    if (!t || t.fanId !== req.auth.sub) throw httpError(404, 'Ticket not found');
    if (t.checkedInAt) throw httpError(409, 'This ticket was already scanned at the door');
    const to = await prisma.fan.findUnique({ where: { handle: handle.replace(/^@/, '').toLowerCase() } });
    if (!to) throw httpError(404, 'No fan with that @handle');
    if (to.id === t.fanId) throw httpError(400, 'That is your own account');
    const moved = await prisma.ticket.update({
      where: { id: t.id },
      data: { fanId: to.id, holderName: to.name, qrSecret: newQrSecret() },
      include: { event: true },
    });
    const push = await notifyFan(to.id, { title: 'You got a ticket', body: `${moved.event.title}, ${moved.tierName}. It is in your tickets now.`, url: '/' });
    res.json({ ok: true, to: { name: to.name, handle: to.handle }, push });
  })
);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
