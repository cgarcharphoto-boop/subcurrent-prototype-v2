import crypto from 'node:crypto';
import { env } from '../env.js';

// Outbound posting for Broadcast. Each platform goes live when its keys are
// set; until then a broadcast records it as "not_connected" instead of
// pretending it posted.
export const socialLive = {
  facebook: Boolean(env.metaPageId && env.metaPageToken),
  instagram: Boolean(env.metaPageToken && env.igUserId && env.publicBaseUrl),
  x: Boolean(env.xApiKey && env.xApiSecret && env.xAccessToken && env.xAccessSecret),
};

export const LIMITS = { x: 280, instagram: 2200, facebook: 63206, app: 2000 };

// Problems the owner should fix before sending, per platform.
export function checkBroadcast({ text, platforms, hasImage }) {
  const issues = [];
  for (const p of platforms) {
    if (LIMITS[p] && text.length > LIMITS[p]) issues.push(`${label(p)}: ${text.length - LIMITS[p]} characters over the ${LIMITS[p]} limit`);
    if (p === 'instagram' && !hasImage) issues.push('Instagram: needs a flyer or photo attached');
  }
  return issues;
}

export function label(p) {
  return { app: 'App', facebook: 'Facebook', instagram: 'Instagram', x: 'X' }[p] || p;
}

async function graph(path, params) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, access_token: env.metaPageToken }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Meta returned ${r.status}`);
  return j;
}

// OAuth 1.0a user-context signature for X API v2 (HMAC-SHA1).
function xAuthHeader(method, url) {
  const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const oauth = {
    oauth_consumer_key: env.xApiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.xAccessToken,
    oauth_version: '1.0',
  };
  const params = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join('&');
  const base = [method, pct(url), pct(params)].join('&');
  const key = `${pct(env.xApiSecret)}&${pct(env.xAccessSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}

export async function postTo(platform, { text, imageUrl }) {
  if (!socialLive[platform]) return { status: 'not_connected' };
  try {
    if (platform === 'facebook') {
      const r = imageUrl
        ? await graph(`${env.metaPageId}/photos`, { url: imageUrl, caption: text })
        : await graph(`${env.metaPageId}/feed`, { message: text });
      return { status: 'posted', ref: r.post_id || r.id };
    }
    if (platform === 'instagram') {
      const c = await graph(`${env.igUserId}/media`, { image_url: imageUrl, caption: text });
      const r = await graph(`${env.igUserId}/media_publish`, { creation_id: c.id });
      return { status: 'posted', ref: r.id };
    }
    if (platform === 'x') {
      const url = 'https://api.twitter.com/2/tweets';
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: xAuthHeader('POST', url), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || j.title || `X returned ${r.status}`);
      return { status: 'posted', ref: j.data?.id };
    }
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
  return { status: 'not_connected' };
}
