// api/cron-eod.js
//
// Vercel Cron target. Runs hourly (see vercel.json) and asks the backend whether
// a scheduled End-of-Day report is due right now (in America/New_York time,
// DST-aware). If due, it sends the EOD and records a guard so it can't double-send.
//
// Security: Vercel sends CRON_SECRET as a Bearer token on cron invocations.
// Anything without the correct token is rejected, so a random hit on this public
// URL can't trigger an email. Set CRON_SECRET in Vercel env vars (any long random
// string). Vercel injects it automatically on cron calls once it's set.

import { checkAndSendScheduledEOD } from './index.js';

export default async function handler(req, res) {
  // Verify this is a genuine Vercel Cron invocation.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const result = await checkAndSendScheduledEOD();
    res.status(200).json({ ok: true, result });
  } catch (err) {
    // Return 200 so cron doesn't treat it as a failure and retry-storm.
    console.error('[cron-eod] error:', err && err.message);
    res.status(200).json({ ok: true, warning: 'cron ran but check failed', detail: err && err.message });
  }
}
