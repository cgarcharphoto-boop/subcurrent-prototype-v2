import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyCode } from '../services/tickets.js';
import { readFlyer } from '../services/flyerAI.js';
import { notifyAllFans } from '../services/push.js';
import { moveDoor, currentEvent } from '../services/door.js';
import { checkBroadcast, postTo, socialLive, label } from '../services/social.js';
import { nightReport } from '../services/recap.js';
import { env } from '../env.js';

export const ownerRouter = Router();

// ---- scan a ticket at the door ----
const scanSchema = z.object({ ticketId: z.string(), code: z.string().length(8), eventId: z.string() });

ownerRouter.post(
  '/scan',
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = scanSchema.parse(req.body);
    const ticket = await prisma.ticket.findUnique({ where: { id: body.ticketId } });

    const log = async (result) => {
      await prisma.scanLog.create({
        data: { ticketId: body.ticketId, result, scannedBy: req.auth.sub },
      });
      return result;
    };

    if (!ticket) return res.status(404).json({ result: 'invalid_code' });
    if (ticket.eventId !== body.eventId) return res.json({ result: await log('wrong_event') });
    if (!verifyCode(ticket.qrSecret, body.code)) return res.json({ result: await log('invalid_code') });
    if (ticket.checkedInAt) return res.json({ result: await log('already_used'), checkedInAt: ticket.checkedInAt });

    // Capacity first: a full room means the ticket waits, unscanned.
    const door = await moveDoor(ticket.eventId, 1, { key: 'owner:' + req.auth.sub, name: 'Door scanner' });
    if (door.refused) return res.json({ result: 'hold', door: door.state });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { checkedInAt: new Date() } });
    res.json({ result: await log('valid'), holderName: ticket.holderName, tierName: ticket.tierName, door: door.state });
  })
);

// ---- AI flyer read ----
const flyerSchema = z.object({ imageBase64: z.string(), mediaType: z.string().optional() });

ownerRouter.post(
  '/flyer-read',
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = flyerSchema.parse(req.body);
    const result = await readFlyer(body);
    res.json(result);
  })
);

// ---- create + publish a show ----
const createEventSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  startAt: z.coerce.date(),
  doorsAt: z.coerce.date(),
  venueName: z.string().optional(),
  venueAddr: z.string().optional(),
  revealMode: z.enum(['checkout', 'timed']).default('checkout'),
  dropAt: z.coerce.date().optional(),
  tiers: z.array(z.object({ name: z.string(), priceCents: z.number().int().min(0), capacity: z.number().int().min(1) })),
});

ownerRouter.post(
  '/events',
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = createEventSchema.parse(req.body);
    const event = await prisma.event.create({
      data: {
        title: body.title,
        slug: body.slug,
        startAt: body.startAt,
        doorsAt: body.doorsAt,
        venueName: body.venueName,
        venueAddr: body.venueAddr,
        revealMode: body.revealMode,
        dropAt: body.dropAt,
        status: 'draft',
        tiers: { create: body.tiers },
      },
      include: { tiers: true },
    });
    res.status(201).json(event);
  })
);

ownerRouter.post(
  '/events/:id/publish',
  requireOwner,
  asyncRoute(async (req, res) => {
    const event = await prisma.event.update({ where: { id: req.params.id }, data: { status: 'on_sale' } });
    const push = await notifyAllFans({
      title: 'New show announced',
      body: `${event.title} just went on sale.`,
      url: `/events/${event.slug}`,
    });
    res.json({ event, push });
  })
);

// ---- all events, drafts included (public /events hides drafts) ----
ownerRouter.get(
  '/events',
  requireOwner,
  asyncRoute(async (req, res) => {
    const events = await prisma.event.findMany({
      orderBy: { startAt: 'asc' },
      include: { tiers: true },
    });
    res.json(
      events.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        status: e.status,
        startAt: e.startAt,
        tiers: e.tiers.map((t) => ({ id: t.id, name: t.name, priceCents: t.priceCents, sold: t.soldCount, capacity: t.capacity })),
      }))
    );
  })
);

// ---- dashboard ----
ownerRouter.get(
  '/dashboard',
  requireOwner,
  asyncRoute(async (req, res) => {
    const [fanCount, upcoming, checkIns] = await Promise.all([
      prisma.fan.count(),
      prisma.event.count({ where: { status: { in: ['announced', 'on_sale'] } } }),
      prisma.ticket.count({ where: { checkedInAt: { not: null } } }),
    ]);
    res.json({ fanCount, upcomingEvents: upcoming, totalCheckIns: checkIns });
  })
);

// ---- Broadcast: one post to the app, Facebook, Instagram and X ----
const PLATFORMS = ['app', 'facebook', 'instagram', 'x'];
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const broadcastSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  eventSlug: z.string().max(80).optional(),
  image: z.string().max(700_000).regex(IMAGE_RE).optional(),
  pin: z.boolean().optional(),
  push: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

ownerRouter.get('/broadcast/status', requireOwner, (req, res) => res.json({ app: true, ...socialLive }));

ownerRouter.post(
  '/broadcast',
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = broadcastSchema.parse(req.body);
    const platforms = [...new Set(body.platforms)];
    const issues = checkBroadcast({ text: body.text, platforms, hasImage: Boolean(body.image) });
    if (body.dryRun || issues.length) {
      return res.status(issues.length && !body.dryRun ? 422 : 200).json({ error: issues.join('; ') || undefined, issues, live: { app: true, ...socialLive } });
    }

    const results = {};
    let post = null;
    if (platforms.includes('app') || platforms.includes('facebook') || platforms.includes('instagram')) {
      // The app post doubles as the public home of the image for Meta to fetch.
      post = await prisma.post.create({
        data: {
          ownerId: req.auth.sub, authorName: 'Subcurrent', fromTeam: true, text: body.text, eventSlug: body.eventSlug || null,
          pinned: Boolean(body.pin), imageData: body.image || null, status: platforms.includes('app') ? 'visible' : 'removed',
        },
      });
    }
    if (platforms.includes('app')) {
      const push = body.push ? await notifyAllFans({ title: 'Subcurrent', body: body.text.slice(0, 180), url: '/' }) : null;
      results.app = { status: 'posted', ref: post.id, push };
    }
    const imageUrl = post && body.image && env.publicBaseUrl ? `${env.publicBaseUrl}/feed/${post.id}/image` : null;
    await Promise.all(
      platforms.filter((p) => p !== 'app').map(async (p) => { results[p] = await postTo(p, { text: body.text, imageUrl }); })
    );
    const b = await prisma.broadcast.create({
      data: { text: body.text, eventSlug: body.eventSlug, platforms: JSON.stringify(platforms), resultsJson: JSON.stringify(results), postId: post?.id, byName: req.auth.role === 'admin' ? 'Owner' : 'Team' },
    });
    res.status(201).json({ id: b.id, results, summary: platforms.map((p) => `${label(p)}: ${results[p].status.replace('_', ' ')}`).join(' · ') });
  })
);

ownerRouter.get(
  '/broadcasts',
  requireOwner,
  asyncRoute(async (req, res) => {
    const list = await prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(list.map((b) => ({ id: b.id, text: b.text, eventSlug: b.eventSlug, platforms: JSON.parse(b.platforms), results: JSON.parse(b.resultsJson), at: b.createdAt })));
  })
);

// ---- night recap ----
ownerRouter.get(
  '/night-report',
  requireOwner,
  asyncRoute(async (req, res) => {
    const event = await currentEvent(req.query.event ? String(req.query.event) : null);
    if (!event) return res.status(404).json({ error: 'Show not found' });
    res.json(await nightReport(event));
  })
);
