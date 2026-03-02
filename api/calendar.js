// api/calendar.js
// Proxy for all Google Calendar operations.
// GET  ?action=list&days=60        — fetch upcoming events
// POST { action:'create', event:{} } — create an event
// DELETE ?action=delete&gcalId=xxx  — delete an event

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// Load tokens from Firestore and refresh if expired
async function getValidToken() {
  const db = getDb();
  const doc = await db.collection('kv').doc('gcal__tokens').get();
  if (!doc.exists) throw new Error('NOT_CONNECTED');

  let tokens = doc.data().val;

  // Refresh if expired (with 60s buffer)
  if (Date.now() > tokens.expiresAt - 60000) {
    if (!tokens.refreshToken) throw new Error('NO_REFRESH_TOKEN');

    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
        grant_type:    'refresh_token',
      }),
    });

    const refreshed = await refreshRes.json();
    if (refreshed.error) throw new Error('REFRESH_FAILED: ' + refreshed.error);

    tokens = {
      ...tokens,
      accessToken: refreshed.access_token,
      expiresAt:   Date.now() + (refreshed.expires_in * 1000),
    };

    // Save updated token back to Firestore
    await db.collection('kv').doc('gcal__tokens').set({ val: tokens });
  }

  return tokens;
}

export default async function handler(req, res) {
  // CORS headers so the browser can call this
  res.setHeader('Access-Control-Allow-Origin', 'https://familyhub-ashy.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tokens = await getValidToken();
    const { accessToken, calendarId } = tokens;
    const calId = encodeURIComponent(calendarId);

    // ── LIST upcoming events ──────────────────────────────
    if (req.method === 'GET' && req.query.action === 'list') {
      const days  = parseInt(req.query.days) || 60;
      const now   = new Date();
      const later = new Date(now.getTime() + days * 86400000);

      const gcalRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`
        + `?timeMin=${now.toISOString()}`
        + `&timeMax=${later.toISOString()}`
        + `&singleEvents=true`
        + `&orderBy=startTime`
        + `&maxResults=250`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await gcalRes.json();
      if (data.error) return res.status(400).json({ error: data.error });

      // Normalise to ReynoldsHub event shape
      const events = (data.items || []).map(item => {
        const start = item.start.dateTime || item.start.date;
        const date  = start.slice(0, 10);
        let time = '';
        if (item.start.dateTime) {
          const d = new Date(item.start.dateTime);
          const h = d.getHours(), m = d.getMinutes();
          const ampm = h >= 12 ? 'PM' : 'AM';
          time = `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
        }
        return {
          id:       'gcal_' + item.id,
          gcalId:   item.id,
          date,
          title:    item.summary || '(No title)',
          time,
          who:      '',
          col:      'dot-bl',
          colHex:   '#4285F4',
          fromGCal: true,
          repeat:   'none',
          repeatId: null,
        };
      });

      return res.status(200).json({ events, calendarName: tokens.calendarName });
    }

    // ── CREATE event ──────────────────────────────────────
    if (req.method === 'POST') {
      const { event } = req.body;
      if (!event) return res.status(400).json({ error: 'Missing event' });

      // Build Google Calendar event body
      const gcalEvent = {
        summary: event.title,
        description: event.who ? `Who: ${event.who}` : undefined,
        start: event.time
          ? { dateTime: toDateTime(event.date, event.time), timeZone: 'America/Chicago' }
          : { date: event.date },
        end: event.time
          ? { dateTime: toDateTime(event.date, event.time, 60), timeZone: 'America/Chicago' }
          : { date: event.date },
        colorId: gcalColorId(event.colHex),
      };

      const createRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
        {
          method:  'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(gcalEvent),
        }
      );
      const created = await createRes.json();
      if (created.error) return res.status(400).json({ error: created.error });

      return res.status(200).json({ gcalId: created.id });
    }

    // ── DELETE event ──────────────────────────────────────
    if (req.method === 'DELETE') {
      const gcalId = req.query.gcalId;
      if (!gcalId) return res.status(400).json({ error: 'Missing gcalId' });

      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(gcalId)}`,
        {
          method:  'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return res.status(200).json({ ok: true });
    }

    // ── STATUS (GET action=status) ────────────────────────
    if (req.method === 'GET' && req.query.action === 'status') {
      return res.status(200).json({
        connected:    true,
        calendarName: tokens.calendarName,
        connectedAt:  tokens.connectedAt,
      });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    if (err.message === 'NOT_CONNECTED') {
      return res.status(200).json({ connected: false });
    }
    console.error('Calendar API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────

// "2025-03-15" + "3:30 PM" → ISO datetime, optionally offset by durationMins
function toDateTime(dateStr, timeStr, durationMins = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let hour = 0, min = 0;
  if (timeStr) {
    const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (match) {
      hour = parseInt(match[1]);
      min  = parseInt(match[2]);
      if (match[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (match[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
    }
  }
  const dt = new Date(y, m - 1, d, hour, min + durationMins);
  return dt.toISOString();
}

// Map our hex colours to Google Calendar's closest colorId (1-11)
function gcalColorId(hex) {
  const map = {
    '#4285F4': '9',  // Blue (Google events keep their blue)
    '#E9854C': '6',  // Tangerine
    '#40916C': '2',  // Sage
    '#C75B5B': '11', // Tomato
    '#E9A84C': '5',  // Banana
    '#4C89C8': '9',  // Blueberry
  };
  return map[hex] || '9';
}
