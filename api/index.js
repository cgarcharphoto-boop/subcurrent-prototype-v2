// Vercel serverless entry for the v2 single-project deploy: the app is served
// from docs/ and the backend answers under /api on the same origin.
import { app } from '../backend/src/app.js';

export default function handler(req, res) {
  req.url = req.url.replace(/^\/api(?=\/|\?|$)/, '') || '/';
  return app(req, res);
}
