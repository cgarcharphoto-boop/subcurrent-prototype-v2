import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL', 'file:./dev.db'),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: process.env.TWILIO_FROM_NUMBER || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',

  // Broadcast to Facebook / Instagram (Meta Graph API) and X (API v2)
  metaPageId: process.env.META_PAGE_ID || '',
  metaPageToken: process.env.META_PAGE_TOKEN || '',
  igUserId: process.env.IG_USER_ID || '',
  xApiKey: process.env.X_API_KEY || '',
  xApiSecret: process.env.X_API_SECRET || '',
  xAccessToken: process.env.X_ACCESS_TOKEN || '',
  xAccessSecret: process.env.X_ACCESS_SECRET || '',
  // Public URL of this API, so Meta can fetch broadcast images
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api` : '')).replace(/\/$/, ''),
};

if (env.jwtSecret === 'dev-only-insecure-secret-change-me' && process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to start in production with the default JWT_SECRET. Set a real one.');
}
