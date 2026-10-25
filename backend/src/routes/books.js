import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { profitAndLoss } from '../services/books.js';

// Owner books: team roster, purchases and bills, and a P&L built from them.
export const booksRouter = Router();
booksRouter.use(requireOwner);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function shapeMember(m) {
  return { id: m.id, name: m.name, role: m.role, rateCents: m.rateCents, basis: m.basis, email: m.email, active: m.active, createdAt: m.createdAt };
}

function shapeExpense(x) {
  return { id: x.id, kind: x.kind, vendor: x.vendor, category: x.category, amountCents: x.amountCents, eventSlug: x.eventSlug, spentAt: x.spentAt, note: x.note, by: x.byName };
}

// ---- team roster ----
const memberSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(40).default('Crew'),
  rateCents: z.number().int().min(0).max(10_000_000).default(0),
  basis: z.enum(['hour', 'night', 'flat']).default('hour'),
  // Contact only. Bank and tax details belong with the payroll provider.
  email: z.string().trim().email().max(120).optional(),
});

booksRouter.get(
  '/team',
  asyncRoute(async (req, res) => {
    const list = await prisma.teamMember.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
    res.json(list.map(shapeMember));
  })
);

booksRouter.post(
  '/team',
  asyncRoute(async (req, res) => {
    const body = memberSchema.parse(req.body);
    const m = await prisma.teamMember.create({ data: body });
    res.status(201).json(shapeMember(m));
  })
);

booksRouter.patch(
  '/team/:id',
  asyncRoute(async (req, res) => {
    const body = memberSchema.partial().parse(req.body);
    const m = await prisma.teamMember.update({ where: { id: req.params.id }, data: body }).catch(() => null);
    if (!m) throw httpError(404, 'Team member not found');
    res.json(shapeMember(m));
  })
);

// Soft delete: past shifts still need the rate to cost out.
booksRouter.delete(
  '/team/:id',
  asyncRoute(async (req, res) => {
    const m = await prisma.teamMember.update({ where: { id: req.params.id }, data: { active: false } }).catch(() => null);
    if (!m) throw httpError(404, 'Team member not found');
    res.json({ ok: true });
  })
);

// ---- purchases and bills ----
const expenseSchema = z.object({
  kind: z.enum(['purchase', 'bill']).default('purchase'),
  vendor: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40).default('other'),
  amountCents: z.number().int().min(1).max(100_000_000),
  eventSlug: z.string().max(80).optional(),
  spentAt: z.coerce.date().optional(),
  note: z.string().trim().max(300).optional(),
});

booksRouter.get(
  '/expenses',
  asyncRoute(async (req, res) => {
    const where = {};
    if (req.query.event) where.eventSlug = String(req.query.event);
    if (req.query.kind) where.kind = String(req.query.kind);
    const list = await prisma.expense.findMany({ where, orderBy: { spentAt: 'desc' }, take: 500 });
    res.json(list.map(shapeExpense));
  })
);

booksRouter.post(
  '/expenses',
  asyncRoute(async (req, res) => {
    const body = expenseSchema.parse(req.body);
    const x = await prisma.expense.create({ data: { ...body, byName: req.auth.role === 'admin' ? 'Owner' : 'Team' } });
    res.status(201).json(shapeExpense(x));
  })
);

booksRouter.delete(
  '/expenses/:id',
  asyncRoute(async (req, res) => {
    const x = await prisma.expense.delete({ where: { id: req.params.id } }).catch(() => null);
    if (!x) throw httpError(404, 'Expense not found');
    res.json({ ok: true });
  })
);

// ---- P&L ----
booksRouter.get(
  '/pnl',
  asyncRoute(async (req, res) => {
    res.json(await profitAndLoss(req.query.event ? String(req.query.event) : null));
  })
);

// CSV for the accountant: every expense plus the P&L totals.
booksRouter.get(
  '/export.csv',
  asyncRoute(async (req, res) => {
    const event = req.query.event ? String(req.query.event) : null;
    const [pnl, list] = await Promise.all([
      profitAndLoss(event),
      prisma.expense.findMany({ where: event ? { eventSlug: event } : {}, orderBy: { spentAt: 'asc' } }),
    ]);
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const dollars = (c) => (c / 100).toFixed(2);
    const rows = [
      ['Subcurrent P&L', pnl.scope],
      [],
      ['Line', 'Amount'],
      ...Object.entries(pnl.revenue.tickets).map(([k, v]) => ['Tickets: ' + k, dollars(v)]),
      ['Gross revenue', dollars(pnl.revenue.gross)],
      ...Object.entries(pnl.expenses.byCategory).map(([k, v]) => ['Expense: ' + k, dollars(-v)]),
      ['Labor', dollars(-pnl.labor.total)],
      ['Net', dollars(pnl.net)],
      [],
      ['Date', 'Kind', 'Vendor', 'Category', 'Show', 'Amount', 'Note'],
      ...list.map((x) => [x.spentAt.toISOString().slice(0, 10), x.kind, x.vendor, x.category, x.eventSlug || '', dollars(x.amountCents), x.note || '']),
    ];
    res.type('text/csv').attachment('subcurrent-books.csv').send(rows.map((r) => r.map(cell).join(',')).join('\n') + '\n');
  })
);
