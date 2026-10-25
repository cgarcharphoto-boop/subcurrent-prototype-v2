import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { sign } from '../src/middleware/auth.js';
import { newQrSecret } from '../src/services/tickets.js';

let ownerToken, crewToken, event, fanA, fanB;
const stamp = Date.now();
const slug = `ops-show-${stamp}`;

async function makeFan(tag) {
  const fan = await prisma.fan.create({
    data: { email: `${tag}-${stamp}@subcurrent.test`, name: tag, handle: `${tag}${stamp}`.slice(0, 24), passwordHash: await bcrypt.hash('x', 4) },
  });
  return { ...fan, token: sign({ sub: fan.id, kind: 'fan' }) };
}

beforeAll(async () => {
  const owner = await prisma.owner.create({
    data: { email: `owner-ops-${stamp}@subcurrent.test`, name: 'Ops Owner', role: 'admin', passwordHash: await bcrypt.hash('x', 4) },
  });
  ownerToken = sign({ sub: owner.id, kind: 'owner', role: 'admin' });
  event = await prisma.event.create({
    data: {
      title: 'Ops Test Night', slug, status: 'on_sale', revealMode: 'timed', dropAt: new Date(Date.now() + 86400_000),
      venueName: 'Secret Warehouse', venueAddr: '1 Hidden Way, Denver',
      startAt: new Date(Date.now() + 3600_000), doorsAt: new Date(Date.now() + 1800_000),
      tiers: { create: [{ name: 'GA', priceCents: 3000, capacity: 100, soldCount: 10 }, { name: 'VIP', priceCents: 8000, capacity: 10, soldCount: 2 }] },
    },
  });
  const inv = await request(app).post('/owner/crew/invites').set('Authorization', `Bearer ${ownerToken}`).send({ dept: 'bar' });
  crewToken = (await request(app).post('/crew/join').send({ code: inv.body.code, name: 'Rae' })).body.token;
  fanA = await makeFan('ava');
  fanB = await makeFan('ben');
});

const own = (r) => r.set('Authorization', `Bearer ${ownerToken}`);
const crew = (r) => r.set('Authorization', `Bearer ${crewToken}`);
const as = (f, r) => r.set('Authorization', `Bearer ${f.token}`);

describe('crew shifts and breaks', () => {
  it('clocks in once, tracks a break, clocks out', async () => {
    const a = await crew(request(app).post('/crew/clock')).send({ action: 'in' });
    expect(a.status).toBe(201);
    expect(a.body.shift.out).toBeNull();
    const again = await crew(request(app).post('/crew/clock')).send({ action: 'in' });
    expect(again.body.already).toBe(true);

    const b = await crew(request(app).post('/crew/break')).send({ action: 'start' });
    expect(b.body.shift.onBreak).toBe(true);
    const state = await crew(request(app).get('/crew/state'));
    expect(state.body.shift.onBreak).toBe(true);
    expect(state.body.channels.bar.some((m) => /on a 15-minute break/.test(m.text))).toBe(true);
    const e = await crew(request(app).post('/crew/break')).send({ action: 'end' });
    expect(e.body.shift.onBreak).toBe(false);

    const out = await crew(request(app).post('/crew/clock')).send({ action: 'out' });
    expect(out.status).toBe(200);
    expect(out.body.shift.out).not.toBeNull();
    expect((await crew(request(app).post('/crew/clock')).send({ action: 'out' })).status).toBe(409);
  });

  it('lets the owner see shifts, and not crew', async () => {
    const r = await own(request(app).get('/owner/crew/shifts'));
    expect(r.status).toBe(200);
    expect(r.body.some((s) => s.name === 'Rae')).toBe(true);
    expect((await crew(request(app).get('/owner/crew/shifts'))).status).toBe(403);
  });

  it('marks a task done', async () => {
    const p = await own(request(app).post('/crew/pings')).send({ kind: 'task', title: 'Restock cups', to: ['bar'] });
    const d = await crew(request(app).post(`/crew/pings/${p.body.id}/ack`)).send({ answer: 'done' });
    expect(d.body.mine).toBe('done');
  });
});

describe('owner books', () => {
  it('requires an owner', async () => {
    expect((await request(app).get('/owner/books/pnl')).status).toBe(401);
    expect((await as(fanA, request(app).get('/owner/books/team'))).status).toBe(403);
  });

  it('builds a P&L from tickets, expenses and costed crew hours', async () => {
    const m = await own(request(app).post('/owner/books/team')).send({ name: 'Rae', role: 'Bar', rateCents: 2400, basis: 'night' });
    expect(m.status).toBe(201);
    expect((await own(request(app).post('/owner/books/team')).send({ name: '' })).status).toBe(400);
    const x = await own(request(app).post('/owner/books/expenses')).send({ vendor: 'Ice Co', category: 'bar', amountCents: 4500, eventSlug: slug });
    expect(x.status).toBe(201);

    const pnl = await own(request(app).get(`/owner/books/pnl?event=${slug}`));
    expect(pnl.status).toBe(200);
    expect(pnl.body.revenue.gross).toBe(10 * 3000 + 2 * 8000);
    expect(pnl.body.expenses.total).toBe(4500);
    expect(pnl.body.labor.total).toBe(2400); // one night shift at the night rate
    expect(pnl.body.net).toBe(46000 - 4500 - 2400);

    const csv = await own(request(app).get(`/owner/books/export.csv?event=${slug}`));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/Ice Co/);

    expect((await own(request(app).delete(`/owner/books/expenses/${x.body.id}`))).status).toBe(200);
    expect((await own(request(app).delete(`/owner/books/team/${m.body.id}`))).status).toBe(200);
    const team = await own(request(app).get('/owner/books/team'));
    expect(team.body.some((t) => t.id === m.body.id)).toBe(false);
  });
});

describe('going, giveaway, follows', () => {
  it('toggles going and counts it', async () => {
    const g = await as(fanA, request(app).post(`/events/${slug}/going`));
    expect(g.body).toMatchObject({ going: true, goingCount: 1 });
    const me = await as(fanA, request(app).get(`/events/${slug}/me`));
    expect(me.body).toMatchObject({ going: true, entered: false });
    const off = await as(fanA, request(app).post(`/events/${slug}/going`)).send({ going: false });
    expect(off.body.going).toBe(false);
    expect((await request(app).post(`/events/${slug}/going`)).status).toBe(401);
  });

  it('enters once and the owner draws a winner who gets a team message', async () => {
    expect((await as(fanA, request(app).post(`/events/${slug}/giveaway`))).status).toBe(201);
    const again = await as(fanA, request(app).post(`/events/${slug}/giveaway`));
    expect(again.body.already).toBe(true);
    const d = await own(request(app).post(`/owner/events/${slug}/giveaway/draw`)).send({ winners: 1 });
    expect(d.status).toBe(200);
    expect(d.body.winners[0].name).toBe('ava');
    const thread = await as(fanA, request(app).get('/messages'));
    expect(JSON.stringify(thread.body)).toMatch(/You won the Ops Test Night giveaway/);
    expect((await own(request(app).post(`/owner/events/${slug}/giveaway/draw`)).send({})).status).toBe(409);
  });

  it('follows a fan by handle, not a stranger or yourself', async () => {
    const f = await as(fanA, request(app).post('/follows')).send({ target: '@' + fanB.handle });
    expect(f.body).toMatchObject({ following: true, followers: 1 });
    expect((await as(fanA, request(app).post('/follows')).send({ target: fanA.handle })).status).toBe(400);
    expect((await as(fanA, request(app).post('/follows')).send({ target: 'nobody_here_x' })).status).toBe(404);
    const art = await as(fanA, request(app).post('/follows')).send({ target: 'artist:bluetech' });
    expect(art.body.following).toBe(true);
    const mine = await as(fanA, request(app).get('/follows'));
    expect(mine.body.following).toEqual(expect.arrayContaining([fanB.handle, 'artist:bluetech']));
    const cnt = await request(app).get('/follows/count/artist:bluetech');
    expect(cnt.body.followers).toBeGreaterThan(0);
  });

  it('edits name and bio on the profile', async () => {
    const r = await as(fanB, request(app).patch('/auth/fan/me')).send({ name: 'Ben R', bio: 'bass head' });
    expect(r.body).toMatchObject({ name: 'Ben R', bio: 'bass head' });
    expect((await as(fanB, request(app).patch('/auth/fan/me')).send({})).status).toBe(400);
  });
});

describe('location drop', () => {
  it('hides the address until the owner drops it', async () => {
    const before = await request(app).get(`/events/${slug}`);
    expect(before.body.venueAddr).toBeNull();
    await prisma.ticket.create({ data: { eventId: event.id, fanId: fanA.id, tierName: 'GA', holderName: 'ava', qrSecret: newQrSecret() } });
    const d = await own(request(app).post(`/owner/events/${slug}/drop`)).send({});
    expect(d.status).toBe(200);
    expect(d.body.holders).toBe(1);
    const after = await request(app).get(`/events/${slug}`);
    expect(after.body.venueAddr).toBe('1 Hidden Way, Denver');
  });
});

describe('pin and ban', () => {
  it('pins a post, then bans its author from posting', async () => {
    const p = await as(fanB, request(app).post('/feed')).send({ text: 'spam spam' });
    expect(p.status).toBe(201);
    const pin = await own(request(app).post(`/feed/${p.body.post.id}/pin`));
    expect(pin.body.pinned).toBe(true);
    const unpin = await own(request(app).post(`/feed/${p.body.post.id}/pin`));
    expect(unpin.body.pinned).toBe(false);
    expect((await as(fanA, request(app).post(`/feed/${p.body.post.id}/pin`))).status).toBe(403);

    const ban = await own(request(app).post(`/owner/moderation/${p.body.post.id}`)).send({ action: 'ban' });
    expect(ban.status).toBe(200);
    expect(ban.body.bannedUntil).toBeTruthy();
    const blocked = await as(fanB, request(app).post('/feed')).send({ text: 'back again' });
    expect(blocked.status).toBe(403);
  });
});
