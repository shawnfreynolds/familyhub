// api/auth/google.js
// Redirects the user to Google's OAuth consent screen

export default function handler(req, res) {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI env vars not set' });
  }

  const scope = [
    'https://www.googleapis.com/auth/calendar',          // read + write events
    'https://www.googleapis.com/auth/calendar.readonly',  // fallback read
  ].join(' ');

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope,
    access_type:   'offline',   // get a refresh_token so we can work without the user present
    prompt:        'consent',   // force consent screen so refresh_token is always returned
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
