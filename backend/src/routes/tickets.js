import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireFan } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { newQrSecret, currentCode } from '../services/tickets.js';
import { charge } from '../services/payments.js';
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
