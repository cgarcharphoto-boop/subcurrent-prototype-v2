import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sign } from '../src/middleware/auth.js';
import { newQrSecret, currentCode } from '../src/services/tickets.js';

let ownerToken, crewToken, event;
const slug = `crew-show-${Date.now()}`;

beforeAll(async () => {
  const owner = await prisma.owner.create({
    data: { email: `owner-crew-${Date.now()}@subcurrent.test`, name: 'Crew Owner', role: 'admin', passwordHash: await bcrypt.hash('x', 4) },
  });
  ownerToken = sign({ sub: owner.id, kind: 'owner', role: 'admin' });
  event = await prisma.event.create({
    data: {
      title: 'Crew Test Night', slug, status: 'on_sale', capacity: 4,
      startAt: new Date(Date.now() + 3600_000), doorsAt: new Date(Date.now() + 1800_000),
      tiers: { create: [{ name: 'GA', priceCents: 2500, capacity: 10, soldCount: 3 }] },
    },
  });
  crewToken = (await request(app).post('/crew/demo')).body.token;
});

const crew = (r) => r.set('Authorization', `Bearer ${crewToken}`);
const own = (r) => r.set('Authorization', `Bearer ${ownerToken}`);

describe('crew auth', () => {
  it('rejects fans and anonymous callers', async () => {
    expect((await request(app).get('/crew/state')).status).toBe(401);
    const fan = sign({ sub: 'x', kind: 'fan' });
    expect((await request(app).get('/crew/state').set('Authorization', `Bearer ${fan}`)).status).toBe(403);
  });

  it('joins with an owner-issued code, not a made-up one', async () => {
    expect((await request(app).post('/crew/join').send({ code: 'NOPE99', name: 'Sam' })).status).toBe(401);
    const inv = await own(request(app).post('/owner/crew/invites')).send({ dept: 'sec' });
    expect(inv.status).toBe(201);
    const j = await request(app).post('/crew/join').send({ code: inv.body.code.toLowerCase(), name: 'Sam' });
    expect(j.status).toBe(200);
    expect(j.body.crew).toEqual({ name: 'Sam', dept: 'sec' });
  });
});

describe('door count and capacity hold', () => {
  it('warns at 95%, holds at 100%, refuses entry while held, reopens after exits', async () => {
    const door = (delta) => crew(request(app).post('/crew/door')).send({ event: slug, delta });
    expect((await door(1)).body.state.inside).toBe(1);
    await door(1);
    await door(1);
    const full = await door(1);
    expect(full.body.crossed).toBe('hold');
    expect(full.body.state).toMatchObject({ inside: 4, hold: true, pct: 100 });

    const refused = await door(1);
    expect(refused.body.refused).toBe(true);
    expect(refused.body.state.inside).toBe(4);

    const out = await door(-1);
    expect(out.body.crossed).toBe('release');
    expect(out.body.state.hold).toBe(false);

    const st = await crew(request(app).get('/crew/state').query({ event: slug }));
    expect(st.body.pings.some((p) => p.kind === 'capacity' && p.title === 'Venue at max capacity')).toBe(true);
    expect(st.body.channels.all.some((m) => m.by === 'Door count')).toBe(true);
    expect(st.body.door.peak).toBe(4);
  });

  it('a real ticket scan counts toward the headcount and waits during a hold', async () => {
    const fan = await prisma.fan.create({ data: { email: `door-${Date.now()}@t.test`, name: 'Door Fan', passwordHash: 'x' } });
    const t = await prisma.ticket.create({ data: { eventId: event.id, fanId: fan.id, tierName: 'GA', holderName: 'Door Fan', qrSecret: newQrSecret() } });
    const r = await own(request(app).post('/owner/scan')).send({ ticketId: t.id, code: currentCode(t.qrSecret), eventId: event.id });
    expect(r.body.result).toBe('valid');
    expect(r.body.door.inside).toBe(4);

    const t2 = await prisma.ticket.create({ data: { eventId: event.id, fanId: fan.id, tierName: 'GA', holderName: 'Door Fan', qrSecret: newQrSecret() } });
    const held = await own(request(app).post('/owner/scan')).send({ ticketId: t2.id, code: currentCode(t2.qrSecret), eventId: event.id });
    expect(held.body.result).toBe('hold');
    expect((await prisma.ticket.findUnique({ where: { id: t2.id } })).checkedInAt).toBeNull();
  });
});

describe('pings, chat and incidents', () => {
  it('sends a ping, records acks once per person, and shows it in the channel', async () => {
    const p = await own(request(app).post('/crew/pings')).send({ kind: 'task', title: 'Restock wristbands', to: ['door'] });
    expect(p.status).toBe(201);
    await crew(request(app).post(`/crew/pings/${p.body.id}/ack`)).send({});
    const again = await crew(request(app).post(`/crew/pings/${p.body.id}/ack`)).send({ answer: 'cant' });
    expect(again.body.acks).toHaveLength(1);
    expect(again.body.mine).toBe('cant');
    const st = await crew(request(app).get('/crew/state'));
    expect(st.body.channels.door.some((m) => m.text.startsWith('Restock wristbands'))).toBe(true);
  });

  it('only the sender or Ops can close a ping', async () => {
    const p = await own(request(app).post('/crew/pings')).send({ kind: 'info', title: 'Doors in 10' });
    expect((await crew(request(app).post(`/crew/pings/${p.body.id}/resolve`))).status).toBe(403);
    expect((await own(request(app).post(`/crew/pings/${p.body.id}/resolve`))).status).toBe(200);
  });

  it('chat validates the channel', async () => {
    expect((await crew(request(app).post('/crew/messages')).send({ channel: 'nope', text: 'hi' })).status).toBe(400);
    const m = await crew(request(app).post('/crew/messages')).send({ channel: 'sec', text: 'Radio check' });
    expect(m.status).toBe(201);
  });

  it('a medic call logs an incident and pings security', async () => {
    const r = await crew(request(app).post('/crew/incidents')).send({ kind: 'medic', note: 'Front left, by the subs' });
    expect(r.status).toBe(201);
    expect(r.body.ping).toMatchObject({ kind: 'urgent', title: 'Medic needed', to: ['sec', 'all'] });
    expect(r.body.ping.body).toContain('Jules');
  });
});

describe('broadcast', () => {
  it('flags platform problems before sending', async () => {
    const r = await own(request(app).post('/owner/broadcast')).send({ text: 'x'.repeat(300), platforms: ['x', 'instagram'] });
    expect(r.status).toBe(422);
    expect(r.body.issues.join(' ')).toMatch(/X: 20 characters over/);
    expect(r.body.issues.join(' ')).toMatch(/Instagram: needs a flyer/);
  });

  it('posts to the app for real and records unconnected platforms honestly', async () => {
    const r = await own(request(app).post('/owner/broadcast')).send({ text: 'Night Two doors at 9', platforms: ['app', 'facebook', 'x'], pin: true });
    expect(r.status).toBe(201);
    expect(r.body.results.app.status).toBe('posted');
    expect(r.body.results.facebook.status).toBe('not_connected');
    expect(r.body.results.x.status).toBe('not_connected');
    const feed = await request(app).get('/feed');
    expect(feed.body.posts.some((p) => p.text === 'Night Two doors at 9' && p.pinned && p.fromTeam)).toBe(true);
    const hist = await own(request(app).get('/owner/broadcasts'));
    expect(hist.body[0].platforms).toEqual(['app', 'facebook', 'x']);
  });
});

describe('night report', () => {
  it('summarizes sales, door, crew and incidents from real rows', async () => {
    const r = await own(request(app).get('/owner/night-report').query({ event: slug }));
    expect(r.status).toBe(200);
    expect(r.body.sales).toMatchObject({ sold: 3, grossCents: 7500 });
    expect(r.body.door.peak).toBe(4);
    expect(r.body.crew.capacityHolds).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.ai).toBe(false);
    expect(r.body.summary.text).toContain('Crew Test Night');
  });
});

describe('ticket transfer', () => {
  it('moves the ticket to another fan by handle and rotates the code', async () => {
    const a = await prisma.fan.create({ data: { email: `ta-${Date.now()}@t.test`, name: 'Giver', passwordHash: 'x' } });
    const b = await prisma.fan.create({ data: { email: `tb-${Date.now()}@t.test`, name: 'Taker', handle: `taker${Date.now()}`, passwordHash: 'x' } });
    const t = await prisma.ticket.create({ data: { eventId: event.id, fanId: a.id, tierName: 'GA', holderName: 'Giver', qrSecret: newQrSecret() } });
    const tokA = sign({ sub: a.id, kind: 'fan' });
    const r = await request(app).post(`/tickets/${t.id}/transfer`).set('Authorization', `Bearer ${tokA}`).send({ handle: '@' + b.handle });
    expect(r.status).toBe(200);
    const moved = await prisma.ticket.findUnique({ where: { id: t.id } });
    expect(moved.fanId).toBe(b.id);
    expect(moved.holderName).toBe('Taker');
    expect(moved.qrSecret).not.toBe(t.qrSecret);
    const again = await request(app).post(`/tickets/${t.id}/transfer`).set('Authorization', `Bearer ${tokA}`).send({ handle: b.handle });
    expect(again.status).toBe(404);
  });
});
