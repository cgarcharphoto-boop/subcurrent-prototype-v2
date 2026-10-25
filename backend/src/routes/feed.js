import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAny, requireFan, requireOwner } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { notifyAllFans } from '../services/push.js';
import { holdReason, REPORT_HOLD_THRESHOLD } from '../services/moderation.js';

export const feedRouter = Router();
export const moderationRouter = Router();

const TEAM_NAME = 'Subcurrent';
const PAGE = 30;
const MAX_IMAGE_CHARS = 700_000; // ~500 KB of image after base64
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

// Writes are cheap to spam; keep them to a human pace per IP.
const writeLimit = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Resolves who is writing. Fans must still exist: the demo database can reset,
// which leaves old tokens pointing at nobody.
async function author(req) {
  if (req.auth.kind === 'owner') return { ownerId: req.auth.sub, authorName: TEAM_NAME, fromTeam: true };
  const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
  if (!fan) throw httpError(401, 'Account not found. Sign in again.');
  if (fan.bannedUntil && fan.bannedUntil > new Date()) throw httpError(403, `You can’t post until ${fan.bannedUntil.toISOString().slice(0, 10)}`);
  return { fanId: fan.id, authorName: fan.name, fromTeam: false };
}

function postInclude(viewerFanId) {
  return {
    _count: { select: { likes: true, comments: true } },
    likes: viewerFanId ? { where: { fanId: viewerFanId }, select: { fanId: true } } : { take: 0, select: { fanId: true } },
    pollVotes: { select: { fanId: true, option: true } },
  };
}

function shapePost(p, viewerFanId) {
  let poll = null;
  if (p.pollJson) {
    const options = JSON.parse(p.pollJson);
    const votes = options.map(() => 0);
    let mine = null;
    for (const v of p.pollVotes || []) {
      if (v.option >= 0 && v.option < votes.length) votes[v.option]++;
      if (viewerFanId && v.fanId === viewerFanId) mine = v.option;
    }
    poll = { options, votes, mine };
  }
  return {
    id: p.id,
    appKey: p.appKey,
    author: p.authorName,
    fromTeam: p.fromTeam,
    text: p.text,
    eventSlug: p.eventSlug,
    pinned: p.pinned,
    status: p.status,
    heldReason: p.status === 'held' ? p.heldReason : null,
    createdAt: p.createdAt,
    image: p.imageData ? `/feed/${p.id}/image` : null,
    poll,
    likes: p._count.likes,
    comments: p._count.comments,
    liked: viewerFanId ? p.likes.some((l) => l.fanId === viewerFanId) : false,
    mine: Boolean(viewerFanId && p.fanId === viewerFanId),
  };
}

// Never select image bytes for list views.
const listSelect = (viewer) => ({
  id: true, appKey: true, fanId: true, authorName: true, fromTeam: true, text: true, eventSlug: true, pinned: true,
  status: true, heldReason: true, createdAt: true, pollJson: true,
  imageData: false,
  ...postInclude(viewer),
});
async function withImageFlags(posts) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const withImg = await prisma.post.findMany({ where: { id: { in: ids }, imageData: { not: null } }, select: { id: true } });
  const set = new Set(withImg.map((x) => x.id));
  return posts.map((p) => ({ ...p, imageData: set.has(p.id) ? true : null }));
}

async function visiblePost(id) {
  const post = await prisma.post.findUnique({ where: { id }, select: { id: true, status: true, fanId: true } });
  if (!post || post.status !== 'visible') throw httpError(404, 'Post not found');
  return post;
}

// Public read; a fan token adds liked/mine/poll vote, and shows the fan their
// own posts that are held for review.
feedRouter.get(
  '/',
  requireAny({ optional: true }),
  asyncRoute(async (req, res) => {
    const viewer = req.auth?.kind === 'fan' ? req.auth.sub : null;
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const visibleOrMine = viewer ? { OR: [{ status: 'visible' }, { status: 'held', fanId: viewer }] } : { status: 'visible' };
    const timeFilter = before && !isNaN(before) ? { createdAt: { lt: before } } : {};
    const [pinned, posts] = await Promise.all([
      before ? [] : prisma.post.findMany({ where: { status: 'visible', pinned: true }, orderBy: { createdAt: 'desc' }, select: listSelect(viewer) }),
      prisma.post.findMany({ where: { ...visibleOrMine, ...timeFilter, pinned: false }, orderBy: { createdAt: 'desc' }, take: PAGE, select: listSelect(viewer) }),
    ]);
    const all = await withImageFlags([...pinned, ...posts]);
    res.json({
      posts: all.map((p) => shapePost(p, viewer)),
      nextBefore: posts.length === PAGE ? posts[posts.length - 1].createdAt : null,
    });
  })
);

// Look up server posts by the prototype's ids (p1, p2, ...), so the app's
// built-in posts can carry real likes, comments and votes.
feedRouter.get(
  '/by-app-keys',
  requireAny({ optional: true }),
  asyncRoute(async (req, res) => {
    const viewer = req.auth?.kind === 'fan' ? req.auth.sub : null;
    const keys = String(req.query.keys || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 50);
    if (!keys.length) return res.json({});
    const posts = await prisma.post.findMany({ where: { appKey: { in: keys }, status: 'visible' }, select: listSelect(viewer) });
    const out = {};
    for (const p of await withImageFlags(posts)) out[p.appKey] = shapePost(p, viewer);
    res.json(out);
  })
);

feedRouter.get(
  '/:id/image',
  asyncRoute(async (req, res) => {
    const p = await prisma.post.findUnique({ where: { id: req.params.id }, select: { imageData: true, status: true } });
    if (!p || !p.imageData || p.status === 'removed') return res.status(404).json({ error: 'No image' });
    const m = p.imageData.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(Buffer.from(m[2], 'base64'));
  })
);

const postSchema = z.object({
  text: z.string().trim().max(1000).default(''),
  eventSlug: z.string().max(80).optional(),
  pinned: z.boolean().optional(),
  notify: z.boolean().optional(),
  image: z.string().max(MAX_IMAGE_CHARS, 'Photo is too large. Try a smaller one.').regex(IMAGE_RE, 'Photo must be a JPEG, PNG or WebP').optional(),
  poll: z.array(z.string().trim().min(1).max(80)).min(2).max(4).optional(),
});

feedRouter.post(
  '/',
  writeLimit,
  requireAny(),
  asyncRoute(async (req, res) => {
    const body = postSchema.parse(req.body);
    if (!body.text && !body.image && !body.poll) throw httpError(400, 'Write something, add a photo, or add a poll');
    const who = await author(req);
    const isTeam = who.fromTeam;
    const pinned = isTeam && Boolean(body.pinned);
    // Team posts are trusted; fan posts that look like ticket resale wait for review.
    const reason = isTeam ? null : holdReason(body.text);
    const post = await prisma.$transaction(async (tx) => {
      if (pinned) await tx.post.updateMany({ where: { fromTeam: true, pinned: true }, data: { pinned: false } });
      const created = await tx.post.create({
        data: {
          ...who,
          text: body.text,
          eventSlug: body.eventSlug,
          pinned,
          imageData: body.image,
          pollJson: body.poll ? JSON.stringify(body.poll) : null,
          status: reason ? 'held' : 'visible',
          heldReason: reason,
        },
        select: { id: true },
      });
      return tx.post.findUnique({ where: { id: created.id }, select: listSelect(who.fanId) });
    });
    let push = null;
    if (isTeam && body.notify) {
      push = await notifyAllFans({ title: TEAM_NAME, body: (body.text || 'New post').slice(0, 140), url: './' });
    }
    const [shaped] = await withImageFlags([post]);
    res.status(201).json({ post: shapePost(shaped, who.fanId), push });
  })
);

feedRouter.post(
  '/:id/like',
  writeLimit,
  requireFan,
  asyncRoute(async (req, res) => {
    const post = await visiblePost(req.params.id);
    const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
    if (!fan) throw httpError(401, 'Account not found. Sign in again.');
    const key = { postId_fanId: { postId: post.id, fanId: fan.id } };
    const existing = await prisma.postLike.findUnique({ where: key });
    if (existing) await prisma.postLike.delete({ where: key });
    else await prisma.postLike.create({ data: { postId: post.id, fanId: fan.id } });
    const likes = await prisma.postLike.count({ where: { postId: post.id } });
    res.json({ liked: !existing, likes });
  })
);

const voteSchema = z.object({ option: z.number().int().min(0).max(3) });

feedRouter.post(
  '/:id/vote',
  writeLimit,
  requireFan,
  asyncRoute(async (req, res) => {
    const { option } = voteSchema.parse(req.body);
    const p = await prisma.post.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, pollJson: true } });
    if (!p || p.status !== 'visible' || !p.pollJson) throw httpError(404, 'Poll not found');
    const options = JSON.parse(p.pollJson);
    if (option >= options.length) throw httpError(400, 'No such option');
    const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
    if (!fan) throw httpError(401, 'Account not found. Sign in again.');
    await prisma.pollVote.upsert({
      where: { postId_fanId: { postId: p.id, fanId: fan.id } },
      create: { postId: p.id, fanId: fan.id, option },
      update: { option },
    });
    const votes = options.map(() => 0);
    for (const v of await prisma.pollVote.findMany({ where: { postId: p.id }, select: { option: true } })) votes[v.option]++;
    res.json({ options, votes, mine: option });
  })
);

feedRouter.get(
  '/:id/comments',
  asyncRoute(async (req, res) => {
    const post = await visiblePost(req.params.id);
    const comments = await prisma.comment.findMany({ where: { postId: post.id }, orderBy: { createdAt: 'asc' }, take: 200 });
    res.json(comments.map((c) => ({ id: c.id, author: c.authorName, fromTeam: c.fromTeam, text: c.text, createdAt: c.createdAt })));
  })
);

const commentSchema = z.object({ text: z.string().trim().min(1).max(500) });

feedRouter.post(
  '/:id/comments',
  writeLimit,
  requireAny(),
  asyncRoute(async (req, res) => {
    const body = commentSchema.parse(req.body);
    const post = await visiblePost(req.params.id);
    const who = await author(req);
    const c = await prisma.comment.create({ data: { ...who, postId: post.id, text: body.text } });
    res.status(201).json({ id: c.id, author: c.authorName, fromTeam: c.fromTeam, text: c.text, createdAt: c.createdAt });
  })
);

const reportSchema = z.object({ reason: z.string().trim().min(1).max(200) });

// Each fan can report a post once. Enough reports hide it until the team reviews.
feedRouter.post(
  '/:id/report',
  writeLimit,
  requireFan,
  asyncRoute(async (req, res) => {
    const { reason } = reportSchema.parse(req.body);
    const post = await visiblePost(req.params.id);
    if (post.fanId === req.auth.sub) throw httpError(400, 'You can remove your own post instead');
    const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
    if (!fan) throw httpError(401, 'Account not found. Sign in again.');
    const existing = await prisma.report.findUnique({ where: { postId_fanId: { postId: post.id, fanId: fan.id } } });
    if (existing) return res.json({ ok: true, already: true });
    await prisma.report.create({ data: { postId: post.id, fanId: fan.id, reason } });
    const updated = await prisma.post.update({ where: { id: post.id }, data: { reportCount: { increment: 1 } } });
    if (updated.reportCount >= REPORT_HOLD_THRESHOLD && updated.status === 'visible' && !updated.fromTeam) {
      await prisma.post.update({ where: { id: post.id }, data: { status: 'held', heldReason: `Reported by ${updated.reportCount} fans`, pinned: false } });
    }
    res.status(201).json({ ok: true });
  })
);

// Fans can remove their own posts (visible or held); the team can remove any.
feedRouter.delete(
  '/:id',
  requireAny(),
  asyncRoute(async (req, res) => {
    const post = await prisma.post.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, fanId: true } });
    if (!post || post.status === 'removed') throw httpError(404, 'Post not found');
    const allowed = req.auth.kind === 'owner' || post.fanId === req.auth.sub;
    if (!allowed) throw httpError(403, 'You can only remove your own posts');
    await prisma.post.update({ where: { id: post.id }, data: { status: 'removed', pinned: false } });
    res.json({ ok: true });
  })
);

// Team pins (or unpins) any visible post to the top of the feed.
feedRouter.post(
  '/:id/pin',
  requireOwner,
  asyncRoute(async (req, res) => {
    await visiblePost(req.params.id);
    const post = await prisma.post.findUnique({ where: { id: req.params.id }, select: { id: true, pinned: true } });
    const pinned = typeof req.body?.pinned === 'boolean' ? req.body.pinned : !post.pinned;
    await prisma.post.update({ where: { id: post.id }, data: { pinned } });
    res.json({ ok: true, pinned });
  })
);

// ---- team moderation queue ----
moderationRouter.get(
  '/',
  requireOwner,
  asyncRoute(async (req, res) => {
    const held = await prisma.post.findMany({
      where: { status: 'held' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { ...listSelect(null), reportCount: true, reports: { select: { reason: true }, take: 5, orderBy: { createdAt: 'desc' } } },
    });
    const shaped = await withImageFlags(held);
    res.json(shaped.map((p) => ({ ...shapePost(p, null), heldReason: p.heldReason, reportCount: p.reportCount, reports: p.reports.map((r) => r.reason) })));
  })
);

const decisionSchema = z.object({ action: z.enum(['approve', 'remove', 'ban']), days: z.number().int().min(1).max(365).default(30) });
const BAN_DAYS = 30;

moderationRouter.post(
  '/:id',
  requireOwner,
  asyncRoute(async (req, res) => {
    const { action, days } = decisionSchema.parse(req.body);
    const post = await prisma.post.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, fanId: true } });
    // Ban works on any fan post, held or not; approve/remove only on the queue.
    if (!post || (action !== 'ban' && post.status !== 'held') || (action === 'ban' && (!post.fanId || post.status === 'removed'))) {
      throw httpError(404, 'Nothing to review for that post');
    }
    await prisma.post.update({
      where: { id: post.id },
      data: action === 'approve' ? { status: 'visible', heldReason: null } : { status: 'removed', pinned: false },
    });
    if (action !== 'ban') return res.json({ ok: true, status: action === 'approve' ? 'visible' : 'removed' });
    const bannedUntil = new Date(Date.now() + (days || BAN_DAYS) * 86400_000);
    await prisma.fan.update({ where: { id: post.fanId }, data: { bannedUntil } });
    res.json({ ok: true, status: 'removed', bannedUntil });
  })
);
