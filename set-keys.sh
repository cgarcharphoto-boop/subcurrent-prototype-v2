#!/usr/bin/env bash
# Turn on the third-party integrations for Subcurrent Prototype v2.
# Prompts for each key (input hidden), sets it on the Vercel project for
# production, preview and development, then redeploys. Press Enter to skip
# any key; already-set keys are skipped unless you pass --replace.
# Usage: ./set-keys.sh [--replace]
set -euo pipefail
cd "$(dirname "$0")"
TEAM=thedude007s-projects
REPLACE=0; [ "${1:-}" = "--replace" ] && REPLACE=1
V() { npx --yes vercel@latest "$@" --scope "$TEAM"; }
if [ ! -t 0 ]; then
  echo "set-keys.sh needs a real terminal so it can read keys without showing them."
  echo "Open Terminal and run: cd $(pwd) && ./set-keys.sh"
  exit 1
fi

EXISTING=$(V env ls --environment production 2>/dev/null | awk 'NR>2{print $1}')
changed=0

# Point Stripe at our webhook and store its signing secret. Replaces any old
# endpoint for the same URL, so re-running after a key roll is safe.
stripe_webhook() {
  local key=$1 url="https://subcurrent-prototype-v2.vercel.app/api/webhooks/stripe" id secret
  for id in $(curl -s -u "$key:" "https://api.stripe.com/v1/webhook_endpoints?limit=100" \
      | python3 -c "import sys,json;[print(e['id']) for e in json.load(sys.stdin).get('data',[]) if e['url']=='$url']"); do
    curl -s -u "$key:" -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$id" >/dev/null
  done
  secret=$(curl -s -u "$key:" https://api.stripe.com/v1/webhook_endpoints -d url="$url" \
      -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.async_payment_succeeded" \
      -d "description=Subcurrent Prototype v2" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("secret",""))')
  case "$secret" in
    whsec_*) for e in production preview development; do
               V env rm STRIPE_WEBHOOK_SECRET "$e" --yes >/dev/null 2>&1 || true
               printf '%s' "$secret" | V env add STRIPE_WEBHOOK_SECRET "$e" >/dev/null
             done; echo "    webhook registered with Stripe";;
    *) echo "    could not register the Stripe webhook; check the key";;
  esac
}

ask() { # name, help
  local name=$1 help=$2 val
  if [ $REPLACE = 0 ] && grep -qx "$name" <<<"$EXISTING"; then echo "  $name already set, skipping"; return; fi
  printf '  %s (%s): ' "$name" "$help"
  read -rs val; echo
  [ -z "$val" ] && return
  for e in production preview development; do
    V env rm "$name" "$e" --yes >/dev/null 2>&1 || true
    printf '%s' "$val" | V env add "$name" "$e" >/dev/null
  done
  echo "    set"
  [ "$name" = STRIPE_SECRET_KEY ] && stripe_webhook "$val"
  changed=1
}

echo "== Payments: Stripe (dashboard.stripe.com > Developers > API keys; use a TEST key, sk_test_...)"
ask STRIPE_SECRET_KEY "sk_test_..."

echo "== Flyer AI + night recap: Anthropic (console.anthropic.com > API keys)"
ask ANTHROPIC_API_KEY "sk-ant-..."

echo "== SMS: Twilio (console.twilio.com)"
ask TWILIO_ACCOUNT_SID "AC..."
ask TWILIO_AUTH_TOKEN "auth token"
ask TWILIO_FROM_NUMBER "+1..."

echo "== Broadcast to Facebook / Instagram (Meta Graph API; Page access token)"
ask META_PAGE_ID "numeric Page ID"
ask META_PAGE_TOKEN "long-lived Page token"
ask IG_USER_ID "Instagram business account ID"

echo "== Broadcast to X (developer.x.com; app with Read+Write, OAuth 1.0a user tokens)"
ask X_API_KEY "API key"
ask X_API_SECRET "API key secret"
ask X_ACCESS_TOKEN "access token"
ask X_ACCESS_SECRET "access token secret"

if [ $changed = 1 ]; then
  echo "== Redeploying"
  V deploy --prod --yes >/dev/null
fi
echo ""
echo "Integrations: $(curl -s https://subcurrent-prototype-v2.vercel.app/api/health)"
