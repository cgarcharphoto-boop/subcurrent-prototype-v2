import { env } from '../env.js';
import { prisma } from '../db.js';
import { doorState } from './door.js';

// The morning-after numbers for one show, built from real rows: sales, door,
// crew response times, incidents and fan activity. With an Anthropic key the
// summary is written by Claude; without one it is a plain template.
export async function nightReport(event) {
  const showStart = new Date(event.doorsAt.getTime() - 6 * 3600_000);
  const showEnd = new Date(event.startAt.getTime() + 12 * 3600_000);
  const inShow = { createdAt: { gte: showStart, lte: showEnd } };

  const [tiers, scans, pings, incidents, posts, messages] = await Promise.all([
    prisma.tier.findMany({ where: { eventId: event.id } }),
    prisma.scanLog.groupBy({ by: ['result'], where: { ticket: { eventId: event.id } }, _count: true }),
    prisma.crewPing.findMany({ where: { eventSlug: event.slug }, include: { acks: true } }),
    prisma.incident.findMany({ where: { eventSlug: event.slug }, orderBy: { createdAt: 'asc' } }),
    prisma.post.count({ where: { ...inShow, status: 'visible' } }),
    prisma.message.count({ where: inShow }),
  ]);

  const sold = tiers.reduce((n, t) => n + t.soldCount, 0);
  const gross = tiers.reduce((n, t) => n + t.soldCount * t.priceCents, 0);
  const ackTimes = [];
  let unanswered = 0;
  for (const p of pings) {
    if (!p.acks.length) unanswered++;
    else ackTimes.push((Math.min(...p.acks.map((a) => a.createdAt.getTime())) - p.createdAt.getTime()) / 1000);
  }
  ackTimes.sort((a, b) => a - b);
  const median = ackTimes.length ? Math.round(ackTimes[Math.floor(ackTimes.length / 2)]) : null;

  const report = {
    show: { slug: event.slug, title: event.title, startAt: event.startAt },
    sales: { sold, grossCents: gross, tiers: tiers.map((t) => ({ name: t.name, sold: t.soldCount, capacity: t.capacity, priceCents: t.priceCents })) },
    door: { ...(await doorState(event)), scans: Object.fromEntries(scans.map((s) => [s.result, s._count])) },
    crew: { pings: pings.length, unanswered, medianAckSeconds: median, capacityHolds: pings.filter((p) => p.kind === 'capacity').length },
    incidents: incidents.map((i) => ({ kind: i.kind, note: i.note, by: i.byName, at: i.createdAt, resolved: Boolean(i.resolvedAt) })),
    fans: { posts, messages },
  };
  report.summary = await summarize(report);
  return report;
}

function template(r) {
  const money = '$' + Math.round(r.sales.grossCents / 100).toLocaleString('en-US');
  const lines = [
    `${r.show.title}: ${r.sales.sold} tickets sold for ${money} gross.`,
    `Door admitted ${r.door.admitted}, peaked at ${r.door.peak} of ${r.door.capacity} (${Math.round((r.door.peak / r.door.capacity) * 100)}%).` +
      (r.crew.capacityHolds ? ` Entry held at capacity ${r.crew.capacityHolds} time${r.crew.capacityHolds === 1 ? '' : 's'}.` : ''),
    r.crew.pings
      ? `Crew answered ${r.crew.pings - r.crew.unanswered} of ${r.crew.pings} pings` + (r.crew.medianAckSeconds != null ? `, median ${r.crew.medianAckSeconds}s to first answer.` : '.')
      : 'No crew pings sent.',
    r.incidents.length ? `${r.incidents.length} incident${r.incidents.length === 1 ? '' : 's'} logged, ${r.incidents.filter((i) => !i.resolved).length} still open.` : 'No incidents logged.',
  ];
  return { text: lines.join(' '), ai: false };
}

async function summarize(r) {
  if (!env.anthropicKey) return template(r);
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: env.anthropicKey });
    const msg = await client.messages.create({
      model: env.anthropicModel,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You write the morning-after recap for an underground electronic music promoter's team. Using only these numbers, write 4 short sentences: how the night went, what stood out, and one concrete thing to fix next show. No headings, no invented facts.\n\n${JSON.stringify({ ...r, summary: undefined })}`,
      }],
    });
    const text = msg.content.find((b) => b.type === 'text')?.text?.trim();
    return text ? { text, ai: true } : template(r);
  } catch {
    return template(r);
  }
}
