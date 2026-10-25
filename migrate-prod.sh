#!/usr/bin/env bash
# Apply backend/prisma/schema.prisma to the v2 production database (Neon).
# Additive changes only: if Prisma warns about data loss it stops, and so should you.
# Run this before pushing code that needs the new schema.
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -f .env.v2; (cd backend && DATABASE_URL=file:./dev.db node scripts/prisma.js generate >/dev/null)' EXIT
npx --yes vercel@latest env pull .env.v2 --environment production --yes --scope thedude007s-projects >/dev/null
(
  set -a; . ./.env.v2; set +a
  cd backend
  node scripts/prisma.js generate >/dev/null
  node scripts/prisma.js db push --skip-generate
)
echo "Production schema is up to date. Safe to push."
