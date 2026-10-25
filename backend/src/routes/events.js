import { Router } from 'express';
import { prisma } from '../db.js';
import { asyncRoute } from '../middleware/errors.js';
import { requireFan } from '../middleware/auth.js';
import { currentEvent } from '../services/door.js';

export const eventsRouter = Router();

const publicEvent = {
  include: {
    tiers: true,
    lineup: { include: { artist: true }, orderBy: { sortOrder: 'asc' } },
  },
};

eventsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const events = await prisma.event.findMany({
      where: { status: { in: ['announced', 'on_sale', 'sold_out'] } },
      orderBy: { startAt: 'asc' },
      ...publicEvent,
    });
    res.json(events.map(shapeEvent));
  })
);

eventsRouter.get(
  '/:slug',
  asyncRoute(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { slug: req.params.slug }, ...publicEvent });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(shapeEvent(event));
  })
);

// ---- fan intent: going and giveaway entries ----
async function eventAndFan(req) {
  const [event, fan] = await Promise.all([
    currentEvent(req.params.slug),
    prisma.fan.findUnique({ where: { id: req.auth.sub }, select: { id: true } }),
  ]);
  if (!fan) throw Object.assign(new Error('Account not found. Sign in again.'), { status: 401 });
  if (!event || event.status === 'draft') throw Object.assign(new Error('Event not found'), { status: 404 });
  return { event, fan };
}

async function counts(slug) {
  const [going, entries] = await Promise.all([prisma.rsvp.count({ where: { eventSlug: slug } }), prisma.giveawayEntry.count({ where: { eventSlug: slug } })]);
  return { goingCount: going, entries };
}

eventsRouter.get(
  '/:slug/me',
  requireFan,
  asyncRoute(async (req, res) => {
    const { event, fan } = await eventAndFan(req);
    const key = { eventSlug_fanId: { eventSlug: event.slug, fanId: fan.id } };
    const [rsvp, entry, c] = await Promise.all([prisma.rsvp.findUnique({ where: key }), prisma.giveawayEntry.findUnique({ where: key }), counts(event.slug)]);
    res.json({ going: Boolean(rsvp), entered: Boolean(entry), won: Boolean(entry?.won), ...c });
  })
);

// Toggle. Body { going: true|false } sets it explicitly instead.
eventsRouter.post(
  '/:slug/going',
  requireFan,
  asyncRoute(async (req, res) => {
    const { event, fan } = await eventAndFan(req);
    const key = { eventSlug_fanId: { eventSlug: event.slug, fanId: fan.id } };
    const had = await prisma.rsvp.findUnique({ where: key });
    const want = typeof req.body?.going === 'boolean' ? req.body.going : !had;
    if (want && !had) await prisma.rsvp.create({ data: { eventSlug: event.slug, fanId: fan.id } });
    if (!want && had) await prisma.rsvp.delete({ where: key });
    res.json({ going: want, ...(await counts(event.slug)) });
  })
);

eventsRouter.post(
  '/:slug/giveaway',
  requireFan,
  asyncRoute(async (req, res) => {
    const { event, fan } = await eventAndFan(req);
    const key = { eventSlug_fanId: { eventSlug: event.slug, fanId: fan.id } };
    const had = await prisma.giveawayEntry.findUnique({ where: key });
    if (!had) await prisma.giveawayEntry.create({ data: { eventSlug: event.slug, fanId: fan.id } });
    res.status(had ? 200 : 201).json({ entered: true, already: Boolean(had), ...(await counts(event.slug)) });
  })
);

// Never expose the real street address before checkout/drop time — that's
// the whole point of the location-drop mechanic.
function shapeEvent(e) {
  const locationReady = e.revealMode === 'checkout' || (e.dropAt && e.dropAt <= new Date());
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    status: e.status,
    startAt: e.startAt,
    doorsAt: e.doorsAt,
    venueName: locationReady ? e.venueName : null,
    venueAddr: locationReady ? e.venueAddr : null,
    dropAt: e.dropAt,
    tiers: e.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      priceCents: t.priceCents,
      remaining: Math.max(0, t.capacity - t.soldCount),
      salesOpen: t.salesOpen,
    })),
    lineup: e.lineup.map((l) => ({ time: l.startTime, artist: l.artist.name, genre: l.artist.genre })),
  };
}
