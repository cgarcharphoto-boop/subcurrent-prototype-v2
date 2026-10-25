import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireFan } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';

// Fans follow other fans (by @handle) and artists ("artist:<id>").
export const followsRouter = Router();

const targetSchema = z.object({
  target: z.string().trim().toLowerCase().regex(/^(artist:[a-z0-9._-]{1,40}|@?[a-z0-9._]{3,24})$/, 'Follow a @handle or artist:<id>'),
});

function norm(t) {
  return t.startsWith('artist:') ? t : t.replace(/^@/, '');
}

async function me(req) {
  const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub }, select: { id: true, handle: true } });
  if (!fan) throw Object.assign(new Error('Account not found. Sign in again.'), { status: 401 });
  return fan;
}

followsRouter.get(
  '/',
  requireFan,
  asyncRoute(async (req, res) => {
    const fan = await me(req);
    const [following, followers] = await Promise.all([
      prisma.follow.findMany({ where: { fanId: fan.id }, orderBy: { createdAt: 'desc' } }),
      fan.handle ? prisma.follow.count({ where: { target: fan.handle } }) : 0,
    ]);
    res.json({ following: following.map((f) => f.target), followers });
  })
);

// Public follower count for a fan handle or artist.
followsRouter.get(
  '/count/:target',
  asyncRoute(async (req, res) => {
    const { target } = targetSchema.parse({ target: req.params.target });
    res.json({ target: norm(target), followers: await prisma.follow.count({ where: { target: norm(target) } }) });
  })
);

// Toggle. Body { follow: true|false } sets it explicitly.
followsRouter.post(
  '/',
  requireFan,
  asyncRoute(async (req, res) => {
    const fan = await me(req);
    const target = norm(targetSchema.parse(req.body).target);
    if (target === fan.handle) return res.status(400).json({ error: 'You can’t follow yourself' });
    if (!target.startsWith('artist:')) {
      const exists = await prisma.fan.findUnique({ where: { handle: target }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: 'No fan with that handle' });
    }
    const key = { fanId_target: { fanId: fan.id, target } };
    const had = await prisma.follow.findUnique({ where: key });
    const want = typeof req.body?.follow === 'boolean' ? req.body.follow : !had;
    if (want && !had) await prisma.follow.create({ data: { fanId: fan.id, target } });
    if (!want && had) await prisma.follow.delete({ where: key });
    res.json({ target, following: want, followers: await prisma.follow.count({ where: { target } }) });
  })
);
