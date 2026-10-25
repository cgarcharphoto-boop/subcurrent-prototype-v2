#!/usr/bin/env bash
# Ship Subcurrent Prototype v2: GitHub repo + new Vercel project with its own
# Postgres, secrets, schema and seed, then a production deploy.
# Safe to re-run: every step skips what already exists.
# Usage: ./ship-v2.sh [--private]
set -euo pipefail
cd "$(dirname "$0")"
OWNER=cgarcharphoto-boop
REPO=subcurrent-prototype-v2
TEAM=thedude007s-projects
VIS=--public; [ "${1:-}" = "--private" ] && VIS=--private
V() { npx --yes vercel@latest "$@" --scope "$TEAM"; }

echo "== 1/6  GitHub: $OWNER/$REPO"
gh auth switch -u "$OWNER" >/dev/null 2>&1 || true
if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" $VIS --description "Subcurrent fan app, Teams portal and owner portal: prototype v2 with live backend" >/dev/null
fi
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
git push -u origin main

echo "== 2/6  Vercel project: $REPO"
V project add "$REPO" >/dev/null 2>&1 || true
V link --yes --project "$REPO" >/dev/null

has_env() { V env ls --environment production 2>/dev/null | grep -qE "^ *$1 "; }
add_env() {
  for e in production preview development; do printf '%s' "$2" | V env add "$1" "$e" >/dev/null 2>&1 || true; done
  echo "   set $1"
}

echo "== 3/6  Database (Neon Postgres, its own, not shared with v1)"
has_env DATABASE_URL || V integration add neon --name "$REPO-db" --no-env-pull

echo "== 4/6  Secrets"
has_env JWT_SECRET || add_env JWT_SECRET "$(openssl rand -hex 32)"
if ! has_env VAPID_PUBLIC_KEY; then
  read -r PUB PRIV < <(node -e "const k=require('./backend/node_modules/web-push').generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
  add_env VAPID_PUBLIC_KEY "$PUB"
  add_env VAPID_PRIVATE_KEY "$PRIV"
  add_env VAPID_SUBJECT "mailto:owner@subcurrent.app"
fi

echo "== 5/6  Schema + seed (owner password goes to .owner-credentials, git-ignored)"
V env pull .env.v2 --environment production --yes >/dev/null
(
  set -a; . ./.env.v2; set +a
  cd backend
  node scripts/prisma.js generate >/dev/null
  node scripts/prisma.js db push --skip-generate
  node prisma/seed.js
)
rm -f .env.v2
(cd backend && DATABASE_URL=file:./dev.db node scripts/prisma.js generate >/dev/null)  # back to SQLite for local tests

echo "== 6/6  Deploy"
V git connect "https://github.com/$OWNER/$REPO" --yes >/dev/null 2>&1 \
  && echo "   Vercel redeploys on every push to main" \
  || echo "   Note: connect the repo in the Vercel dashboard for deploy-on-push"
V deploy --prod --yes >/dev/null
URL="https://$REPO.vercel.app"
echo ""
echo "Health: $(curl -s "$URL/api/health")"
echo "App:    $URL"
echo "GitHub: https://github.com/$OWNER/$REPO"
echo "Owner:  $(cat .owner-credentials 2>/dev/null | head -2 | tr '\n' ' ')"
