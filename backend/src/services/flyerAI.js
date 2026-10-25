import { env } from '../env.js';

export const flyerAiLive = Boolean(env.anthropicKey);
let client = null;

async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: env.anthropicKey });
  }
  return client;
}

const SCHEMA_PROMPT = `You are reading a concert/event flyer image. Extract exactly these fields as
strict JSON, with no prose before or after: {"title":string,"date":string,"doors":string,
"ageLimit":string,"genres":string,"venueGuess":string|null,"lineup":string[]}.
If a field truly cannot be read, use an empty string (or null for venueGuess). Do not guess a
venue address — venues are never printed on these flyers and must come from the owner's saved
list, not the image.`;

// imageBase64 should be a data URL body (no "data:image/...;base64," prefix) plus its media type.
export async function readFlyer({ imageBase64, mediaType = 'image/jpeg' }) {
  if (!flyerAiLive) {
    return {
      ok: true,
      mock: true,
      fields: {
        title: 'Undertow Afters',
        date: 'Saturday, November 15',
        doors: '2:00 AM',
        ageLimit: '21+',
        genres: 'Psybass, glitch, downtempo',
        venueGuess: null,
        lineup: ['Secret guests'],
      },
    };
  }
  const anthropic = await getClient();
  const msg = await anthropic.messages.create({
    model: env.anthropicModel,
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: SCHEMA_PROMPT },
        ],
      },
    ],
  });
  const text = msg.content.find((b) => b.type === 'text')?.text || '{}';
  let fields;
  try {
    // Tolerate a ```json fence around the object.
    fields = JSON.parse(text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  } catch {
    throw Object.assign(new Error('Model did not return valid JSON'), { status: 502, raw: text });
  }
  return { ok: true, mock: false, fields };
}
