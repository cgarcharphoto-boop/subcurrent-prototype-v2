import { prisma } from '../db.js';

// Worked minutes on a shift, net of breaks (an open break counts up to now).
export function shiftMinutes(s, now = new Date()) {
  const end = s.outAt || now;
  const onBreak = s.breakAt ? Math.round((end - s.breakAt) / 60000) : 0;
  return Math.max(0, Math.round((end - s.inAt) / 60000) - s.breakMins - onBreak);
}

// What one shift costs, given the roster. Crew are matched to the roster by
// name because invite-code crew have no account to link to.
export function shiftCost(s, member) {
  if (!member || !member.rateCents) return 0;
  if (member.basis === 'hour') return Math.round((shiftMinutes(s) / 60) * member.rateCents);
  return member.rateCents; // night or flat: one rate per shift worked
}

// Profit and loss from real rows: ticket sales by tier, logged purchases and
// bills, and crew hours at roster rates. With an event slug it covers that
// show only; without one it covers everything on the books.
export async function profitAndLoss(eventSlug) {
  const eventWhere = eventSlug ? { slug: eventSlug } : {};
  const [events, expenses, shifts, roster] = await Promise.all([
    prisma.event.findMany({ where: eventWhere, include: { tiers: true } }),
    prisma.expense.findMany({ where: eventSlug ? { eventSlug } : {}, orderBy: { spentAt: 'desc' } }),
    prisma.crewShift.findMany({ where: eventSlug ? { eventSlug } : {} }),
    prisma.teamMember.findMany({ where: { active: true } }),
  ]);
  const byName = new Map(roster.map((m) => [m.name.trim().toLowerCase(), m]));

  const tickets = {};
  let gross = 0;
  let sold = 0;
  for (const e of events) {
    for (const t of e.tiers) {
      tickets[t.name] = (tickets[t.name] || 0) + t.soldCount * t.priceCents;
      gross += t.soldCount * t.priceCents;
      sold += t.soldCount;
    }
  }

  const spend = {};
  for (const x of expenses) spend[x.category] = (spend[x.category] || 0) + x.amountCents;
  const expenseTotal = expenses.reduce((n, x) => n + x.amountCents, 0);

  const labor = {};
  let laborTotal = 0;
  let laborMins = 0;
  const unrated = new Set();
  for (const s of shifts) {
    const m = byName.get(s.byName.trim().toLowerCase());
    if (!m || !m.rateCents) unrated.add(s.byName);
    const c = shiftCost(s, m);
    labor[s.byName] = (labor[s.byName] || 0) + c;
    laborTotal += c;
    laborMins += shiftMinutes(s);
  }

  return {
    scope: eventSlug || 'all',
    revenue: { tickets, gross, sold },
    expenses: { byCategory: spend, total: expenseTotal, count: expenses.length },
    labor: { byPerson: labor, total: laborTotal, hours: Math.round(laborMins / 6) / 10, unrated: [...unrated] },
    net: gross - expenseTotal - laborTotal,
  };
}
