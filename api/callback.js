// api/auth/callback.js
// Google redirects here after the user approves.
// We exchange the code for tokens and store them in Firestore.

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

export default async function handler(req, res) {
  const { code, error } = req.query;

  // User denied access
  if (error) {
    return res.redirect(302, 'https://familyhub-ashy.vercel.app/?gcal=denied');
  }

  if (!code) {
    return res.status(400).send('Missing code parameter');
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  try {
    // Exchange the auth code for access + refresh tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Token exchange error:', tokens);
      return res.redirect(302, 'https://familyhub-ashy.vercel.app/?gcal=error');
    }

    // Find the calendar ID for "Our Lovely Life"
    const calListRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const calList = await calListRes.json();
    const targetCal = (calList.items || []).find(c => c.summary === 'Our Lovely Life');
    const calendarId = targetCal ? targetCal.id : 'primary';

    // Store tokens + calendarId in Firestore under a shared key
    const db = getDb();
    await db.collection('kv').doc('gcal__tokens').set({
      val: {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt:    Date.now() + (tokens.expires_in * 1000),
        calendarId,
        calendarName: targetCal ? targetCal.summary : 'primary',
        connectedAt:  Date.now(),
      }
    });

    // Redirect back to the app with success flag
    res.redirect(302, 'https://familyhub-ashy.vercel.app/?gcal=connected');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(302, 'https://familyhub-ashy.vercel.app/?gcal=error');
  }
}
