import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { sign, requireOwner } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { currentEvent, doorState, moveDoor } from '../services/door.js';

export const crewRouter = Router();
export const crewAdminRouter = Router();

export const CHANNELS = ['all', 'ops', 'door', 'sec', 'bar', 'prod', 'light', 'art'];
const KINDS = ['urgent', 'task', 'break', 'capacity', 'info'];

const writeLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Crew routes take a crew token (from an invite code or the demo login) or an
// owner token, who acts as Ops. req.crew = { key, name, dept, owner }.
function requireCrew(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  let p;
  try {
    p = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (p.kind === 'crew') {
    req.crew = { key: p.sub, name: p.name, dept: p.dept, owner: false };
    return next();
  }
  if (p.kind === 'owner') {
    req.auth = p;
    return requireOwner(req, res, () => {
      req.crew = { key: 'owner:' + p.sub, name: 'Ops', dept: 'ops', owner: true };
      next();
    });
  }
  return res.status(403).json({ error: 'Wrong token type' });
}

function crewToken(key, name, dept) {
  return sign({ sub: key, kind: 'crew', name, dept }, { expiresIn: '2d' });
}

// ---- sign in ----
// The prototype's Teams portal is "Jules, door lead". Same idea as the demo
// fan: a fixed identity so the live demo exercises real crew auth.
crewRouter.post('/demo', (req, res) => {
  res.json({ token: crewToken('demo-jules', 'Jules', 'door'), crew: { name: 'Jules', dept: 'door' } });
});

const joinSchema = z.object({
  code: z.string().min(4).max(20),
  name: z.string().trim().min(1).max(40),
  dept: z.enum(CHANNELS.filter((c) => c !== 'all')).optional(),
});

crewRouter.post(
  '/join',
  rateLimit({ windowMs: 60_000, max: 10 }),
  asyncRoute(async (req, res) => {
    const body = joinSchema.parse(req.body);
    const invite = await prisma.crewInvite.findUnique({ where: { code: body.code.toUpperCase() } });
    if (!invite || invite.expiresAt < new Date()) throw httpError(401, 'That crew code is not valid');
    await prisma.crewInvite.update({ where: { id: invite.id }, data: { uses: { increment: 1 } } });
    const dept = invite.dept || body.dept || 'prod';
    const key = 'crew-' + crypto.randomBytes(6).toString('hex');
    res.json({ token: crewToken(key, body.name, dept), crew: { name: body.name, dept } });
  })
);

// ---- one poll for the whole crew phone ----
function shapePing(p, me) {
  const acks = p.acks.map((a) => ({ by: a.byName, answer: a.answer, at: a.createdAt }));
  return {
    id: p.id, kind: p.kind, title: p.title, body: p.body, to: JSON.parse(p.toJson), from: p.fromName,
    at: p.createdAt, resolved: Boolean(p.resolvedAt), acks, mine: p.acks.find((a) => a.byKey === me)?.answer || null,
  };
}

crewRouter.get(
  '/state',
  requireCrew,
  asyncRoute(async (req, res) => {
    const event = await currentEvent(req.query.event ? String(req.query.event) : null);
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 24 * 3600_000);
    const [pings, messages, incidents] = await Promise.all([
      prisma.crewPing.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { acks: { orderBy: { createdAt: 'asc' } } } }),
      prisma.crewMessage.findMany({ where: { createdAt: { gt: isNaN(since) ? new Date(0) : since } }, orderBy: { createdAt: 'desc' }, take: 120 }),
      prisma.incident.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const channels = Object.fromEntries(CHANNELS.map((c) => [c, []]));
    for (const m of messages.reverse()) {
      (channels[m.channel] || channels.all).push({ id: m.id, by: m.byName, dept: m.byDept, text: m.text, alert: m.alert, at: m.createdAt, mine: m.byKey === req.crew.key });
    }
    res.json({
      me: req.crew,
      door: event ? await doorState(event) : null,
      pings: pings.map((p) => shapePing(p, req.crew.key)),
      channels,
      incidents: incidents.map((i) => ({ id: i.id, kind: i.kind, note: i.note, by: i.byName, at: i.createdAt, resolved: Boolean(i.resolvedAt) })),
      serverTime: new Date(),
    });
  })
);

// ---- channel chat ----
const msgSchema = z.object({ channel: z.enum(CHANNELS), text: z.string().trim().min(1).max(500) });

crewRouter.post(
  '/messages',
  requireCrew,
  writeLimit,
  asyncRoute(async (req, res) => {
    const body = msgSchema.parse(req.body);
    const m = await prisma.crewMessage.create({
      data: { channel: body.channel, text: body.text, byKey: req.crew.key, byName: req.crew.name, byDept: req.crew.dept },
    });
    res.status(201).json({ id: m.id, at: m.createdAt });
  })
);

// ---- pings: takeover alerts that need an answer ----
const pingSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(300).optional(),
  to: z.array(z.string().max(40)).min(1).max(20).default(['all']),
});

crewRouter.post(
  '/pings',
  requireCrew,
  writeLimit,
  asyncRoute(async (req, res) => {
    const body = pingSchema.parse(req.body);
    const ev = await currentEvent();
    const p = await prisma.crewPing.create({
      data: { eventSlug: ev?.slug, kind: body.kind, title: body.title, body: body.body, toJson: JSON.stringify(body.to), fromKey: req.crew.key, fromName: req.crew.name },
      include: { acks: true },
    });
    for (const ch of body.to.filter((t) => CHANNELS.includes(t))) {
      await prisma.crewMessage.create({ data: { eventSlug: ev?.slug, channel: ch, byKey: req.crew.key, byName: req.crew.name, byDept: req.crew.dept, text: body.title + (body.body ? '. ' + body.body : ''), alert: body.kind } });
    }
    res.status(201).json(shapePing(p, req.crew.key));
  })
);

crewRouter.post(
  '/pings/:id/ack',
  requireCrew,
  writeLimit,
  asyncRoute(async (req, res) => {
    const answer = req.body?.answer === 'cant' ? 'cant' : 'ok';
    const ping = await prisma.crewPing.findUnique({ where: { id: req.params.id } });
    if (!ping) throw httpError(404, 'Ping not found');
    await prisma.crewAck.upsert({
      where: { pingId_byKey: { pingId: ping.id, byKey: req.crew.key } },
      create: { pingId: ping.id, byKey: req.crew.key, byName: req.crew.name, answer },
      update: { answer },
    });
    const full = await prisma.crewPing.findUnique({ where: { id: ping.id }, include: { acks: { orderBy: { createdAt: 'asc' } } } });
    res.json(shapePing(full, req.crew.key));
  })
);

crewRouter.post(
  '/pings/:id/resolve',
  requireCrew,
  asyncRoute(async (req, res) => {
    const ping = await prisma.crewPing.findUnique({ where: { id: req.params.id } });
    if (!ping) throw httpError(404, 'Ping not found');
    if (!req.crew.owner && ping.fromKey !== req.crew.key) throw httpError(403, 'Only the sender or Ops can close a ping');
    await prisma.crewPing.update({ where: { id: ping.id }, data: { resolvedAt: new Date() } });
    res.json({ ok: true });
  })
);

// ---- incidents: one tap logs it and pings the right people ----
const QUICK = {
  incident: { title: 'Incident logged', to: ['sec', 'all'], kind: 'urgent' },
  medic: { title: 'Medic needed', to: ['sec', 'all'], kind: 'urgent' },
  backup: { title: 'Backup requested', to: ['sec'], kind: 'urgent' },
  other: { title: 'Heads up', to: ['all'], kind: 'info' },
};
const incidentSchema = z.object({ kind: z.enum(Object.keys(QUICK)), note: z.string().trim().max(300).optional() });

crewRouter.post(
  '/incidents',
  requireCrew,
  writeLimit,
  asyncRoute(async (req, res) => {
    const body = incidentSchema.parse(req.body);
    const ev = await currentEvent();
    const q = QUICK[body.kind];
    const where = req.crew.dept ? ` at ${req.crew.dept === 'door' ? 'the door' : req.crew.dept}` : '';
    const text = `${q.title}${where} by ${req.crew.name}${body.note ? ': ' + body.note : ''}`;
    const [incident, ping] = await prisma.$transaction([
      prisma.incident.create({ data: { eventSlug: ev?.slug, kind: body.kind, note: body.note, byName: req.crew.name } }),
      prisma.crewPing.create({ data: { eventSlug: ev?.slug, kind: q.kind, title: q.title, body: text, toJson: JSON.stringify(q.to), fromKey: req.crew.key, fromName: req.crew.name }, include: { acks: true } }),
      prisma.crewMessage.create({ data: { eventSlug: ev?.slug, channel: q.to[0], byKey: req.crew.key, byName: req.crew.name, byDept: req.crew.dept, text, alert: q.kind } }),
    ]);
    res.status(201).json({ incident: { id: incident.id, kind: incident.kind }, ping: shapePing(ping, req.crew.key) });
  })
);

crewRouter.post(
  '/incidents/:id/resolve',
  requireCrew,
  asyncRoute(async (req, res) => {
    await prisma.incident.update({ where: { id: req.params.id }, data: { resolvedAt: new Date() } });
    res.json({ ok: true });
  })
);

// ---- door counter: manual admits/exits share the scan path's thresholds ----
const doorSchema = z.object({ event: z.string().optional(), delta: z.union([z.literal(1), z.literal(-1)]) });

crewRouter.post(
  '/door',
  requireCrew,
  rateLimit({ windowMs: 60_000, max: 240 }),
  asyncRoute(async (req, res) => {
    const body = doorSchema.parse(req.body);
    const ev = await currentEvent(body.event);
    if (!ev) throw httpError(404, 'No show tonight');
    const r = await moveDoor(ev.id, body.delta, { key: req.crew.key, name: req.crew.name });
    res.json(r);
  })
);

// ---- owner side: invite codes and capacity ----
crewAdminRouter.post(
  '/invites',
  requireOwner,
  asyncRoute(async (req, res) => {
    const dept = req.body?.dept && CHANNELS.includes(req.body.dept) && req.body.dept !== 'all' ? req.body.dept : null;
    // No 0/O/1/I so codes read cleanly over a radio.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
    const invite = await prisma.crewInvite.create({ data: { code, dept, expiresAt: new Date(Date.now() + 3 * 86400_000) } });
    res.status(201).json({ code: invite.code, dept: invite.dept, expiresAt: invite.expiresAt });
  })
);

const capSchema = z.object({ capacity: z.number().int().min(1).max(100000) });

crewAdminRouter.patch(
  '/events/:slug/capacity',
  requireOwner,
  asyncRoute(async (req, res) => {
    const { capacity } = capSchema.parse(req.body);
    const ev = await prisma.event.update({ where: { slug: req.params.slug }, data: { capacity } });
    res.json(await doorState(ev));
  })
);
