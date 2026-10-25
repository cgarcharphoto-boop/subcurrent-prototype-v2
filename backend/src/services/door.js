import { prisma } from '../db.js';

// Live headcount for a show. Every admit and exit runs through here, whether
// it came from a real ticket scan, the crew door counter or the owner portal,
// so the 95% heads-up and the 100% entry hold fire exactly once per crossing.
export const WARN_AT = 0.95;
// After a hold, entry reopens once the room drops back under this share.
export const RELEASE_AT = 0.97;

export async function venueCapacity(event) {
  if (event.capacity) return event.capacity;
  const tiers = await prisma.tier.findMany({ where: { eventId: event.id }, select: { capacity: true } });
  return tiers.reduce((n, t) => n + t.capacity, 0) || 1;
}

export async function doorState(event) {
  const capacity = await venueCapacity(event);
  const inside = Math.max(0, event.doorIn - event.doorOut);
  return {
    slug: event.slug,
    title: event.title,
    capacity,
    inside,
    admitted: event.doorIn,
    left: event.doorOut,
    peak: event.peakInside,
    pct: Math.round((inside / capacity) * 1000) / 10,
    hold: event.entryHold,
  };
}

// delta: +1 admit, -1 exit. Returns { state, refused, crossed } where crossed
// is 'warn' | 'hold' | 'release' | null.
export async function moveDoor(eventId, delta, by = { key: 'system', name: 'Door' }) {
  return prisma.$transaction(async (tx) => {
    const ev = await tx.event.findUnique({ where: { id: eventId } });
    if (!ev) throw Object.assign(new Error('Show not found'), { status: 404 });
    const capacity = ev.capacity || (await tx.tier.findMany({ where: { eventId }, select: { capacity: true } })).reduce((n, t) => n + t.capacity, 0) || 1;
    const before = Math.max(0, ev.doorIn - ev.doorOut);

    if (delta > 0 && (ev.entryHold || before >= capacity)) {
      return { state: await doorState(ev), refused: true, crossed: null };
    }
    if (delta < 0 && before === 0) return { state: await doorState(ev), refused: true, crossed: null };

    const after = before + (delta > 0 ? 1 : -1);
    let hold = ev.entryHold;
    let crossed = null;
    if (after >= capacity && !hold) { hold = true; crossed = 'hold'; }
    else if (hold && after < capacity * RELEASE_AT) { hold = false; crossed = 'release'; }
    else if (before < capacity * WARN_AT && after >= capacity * WARN_AT) crossed = 'warn';

    const updated = await tx.event.update({
      where: { id: eventId },
      data: {
        doorIn: delta > 0 ? { increment: 1 } : undefined,
        doorOut: delta < 0 ? { increment: 1 } : undefined,
        peakInside: Math.max(ev.peakInside, after),
        entryHold: hold,
      },
    });

    if (crossed) {
      const pct = Math.round((after / capacity) * 100);
      const ping = {
        warn: { kind: 'info', title: `Venue at ${pct}%`, body: `${after} of ${capacity} inside. Slow the line at the door.`, to: ['door', 'sec'] },
        hold: { kind: 'capacity', title: 'Venue at max capacity', body: `${after} of ${capacity} inside. Entry is on hold: one out, one in.`, to: ['all'] },
        release: { kind: 'info', title: 'Entry reopened', body: `${after} of ${capacity} inside. The door is admitting again.`, to: ['all'] },
      }[crossed];
      await tx.crewPing.create({
        data: { eventSlug: ev.slug, kind: ping.kind, title: ping.title, body: ping.body, toJson: JSON.stringify(ping.to), fromKey: by.key, fromName: by.name },
      });
      await tx.crewMessage.create({
        data: { eventSlug: ev.slug, channel: 'all', byKey: 'system', byName: 'Door count', text: `${ping.title}. ${ping.body}`, alert: ping.kind },
      });
    }
    return { state: await doorState(updated), refused: false, crossed };
  });
}

// The show crew are working tonight: the nearest one that hasn't ended
// (shows run about 8 hours), falling back to the next one on sale.
export async function currentEvent(slug) {
  if (slug) return prisma.event.findUnique({ where: { slug } });
  const since = new Date(Date.now() - 8 * 3600_000);
  return (
    (await prisma.event.findFirst({ where: { status: { in: ['on_sale', 'sold_out', 'announced'] }, startAt: { gte: since } }, orderBy: { startAt: 'asc' } })) ||
    (await prisma.event.findFirst({ where: { status: { not: 'draft' } }, orderBy: { startAt: 'desc' } }))
  );
}
