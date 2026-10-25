import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sign, requireOwner, requireFan } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(80),
  phone: z.string().optional(),
});

authRouter.post(
  '/fan/signup',
  asyncRoute(async (req, res) => {
    const body = signupSchema.parse(req.body);
    const existing = await prisma.fan.findUnique({ where: { email: body.email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(body.password, 12);
    const fan = await prisma.fan.create({
      data: { email: body.email, passwordHash, name: body.name, phone: body.phone },
    });
    const token = sign({ sub: fan.id, kind: 'fan' });
    res.status(201).json({ token, fan: { id: fan.id, name: fan.name, email: fan.email, handle: fan.handle } });
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post(
  '/fan/login',
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const fan = await prisma.fan.findUnique({ where: { email: body.email } });
    if (!fan || !(await bcrypt.compare(body.password, fan.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = sign({ sub: fan.id, kind: 'fan' });
    res.json({ token, fan: { id: fan.id, name: fan.name, email: fan.email, handle: fan.handle } });
  })
);

// Get-or-create a single fixed demo fan, matching the front-end prototype's
// hardcoded "Alex R." identity. Lets the live demo exercise real auth + real
// push without needing a signup UI yet — not a bypass of the auth system,
// just a consistent identity for it.
authRouter.post(
  '/fan/demo',
  asyncRoute(async (req, res) => {
    const email = 'alex.demo@subcurrent.app';
    const fan = await prisma.fan.upsert({
      where: { email },
      update: {},
      create: { email, name: 'Alex R.', handle: 'alex.demo', passwordHash: await bcrypt.hash(`demo-${Date.now()}`, 4) },
    });
    const token = sign({ sub: fan.id, kind: 'fan' });
    res.json({ token, fan: { id: fan.id, name: fan.name, email: fan.email, handle: fan.handle } });
  })
);

authRouter.post(
  '/owner/login',
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const owner = await prisma.owner.findUnique({ where: { email: body.email } });
    if (!owner || !(await bcrypt.compare(body.password, owner.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = sign({ sub: owner.id, kind: 'owner', role: owner.role, v: owner.tokenVersion });
    res.json({ token, owner: { id: owner.id, name: owner.name, role: owner.role } });
  })
);

const passwordSchema = z.object({ current: z.string(), next: z.string().min(12).max(200) });

// Changing the password signs out every other session (tokenVersion bump)
// and returns a fresh token for this one.
authRouter.post(
  '/owner/password',
  requireOwner,
  asyncRoute(async (req, res) => {
    const body = passwordSchema.parse(req.body);
    const owner = await prisma.owner.findUnique({ where: { id: req.auth.sub } });
    if (!(await bcrypt.compare(body.current, owner.passwordHash))) {
      // 400, not 401: the session is fine, only the typed password is wrong.
      return res.status(400).json({ error: 'Current password is wrong' });
    }
    const updated = await prisma.owner.update({
      where: { id: owner.id },
      data: { passwordHash: await bcrypt.hash(body.next, 12), tokenVersion: { increment: 1 } },
    });
    const token = sign({ sub: updated.id, kind: 'owner', role: updated.role, v: updated.tokenVersion });
    res.json({ token });
  })
);

// ---- fan profile: the handle other fans use to find and message you ----
const HANDLE = /^[a-z0-9._]{3,24}$/;
const profileSchema = z
  .object({
    handle: z.string().trim().toLowerCase().regex(HANDLE, '3-24 letters, numbers, dots or underscores').optional(),
    name: z.string().trim().min(1).max(60).optional(),
    bio: z.string().trim().max(280).optional(),
  })
  .refine((b) => b.handle || b.name || b.bio !== undefined, 'Send a handle, name or bio');

function shapeMe(fan) {
  return { id: fan.id, name: fan.name, email: fan.email, handle: fan.handle, bio: fan.bio, bannedUntil: fan.bannedUntil };
}

authRouter.get(
  '/fan/me',
  requireFan,
  asyncRoute(async (req, res) => {
    const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
    if (!fan) return res.status(401).json({ error: 'Account not found. Sign in again.' });
    res.json(shapeMe(fan));
  })
);

authRouter.patch(
  '/fan/me',
  requireFan,
  asyncRoute(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const fan = await prisma.fan.findUnique({ where: { id: req.auth.sub } });
    if (!fan) return res.status(401).json({ error: 'Account not found. Sign in again.' });
    if (body.handle) {
      const taken = await prisma.fan.findUnique({ where: { handle: body.handle } });
      if (taken && taken.id !== fan.id) return res.status(409).json({ error: 'That handle is taken' });
    }
    const updated = await prisma.fan.update({ where: { id: fan.id }, data: body });
    res.json(shapeMe(updated));
  })
);
