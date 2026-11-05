import { randomBytes } from 'node:crypto';
import { call, createGraph } from './platforms/http.js';

const STATE_TTL_MS = 10 * 60_000;
// One scope covers upload, reading status and deleting a scheduled video.
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish';
const PAGE_FIELDS = 'id,name,access_token,instagram_business_account{id,username}';

// /me/accounts leaves out Pages a person reaches through a business portfolio, so when it comes back
// empty, the Page IDs recorded on the grant itself are the remaining way to find what was approved.
async function grantedPages(meta, graph, userToken) {
  const listed = await graph.get('/me/accounts', userToken, { fields: PAGE_FIELDS, limit: '100' });
  if (listed.data?.length) return listed.data;

  const debug = await graph.get('/debug_token', `${meta.appId}|${meta.appSecret}`, { input_token: userToken });
  const grants = debug.data?.granular_scopes ?? [];
  const pageIds = new Set(grants
    .filter((grant) => grant.scope === 'pages_show_list' || grant.scope === 'pages_manage_posts')
    .flatMap((grant) => grant.target_ids ?? []));

  const pages = [];
  for (const id of pageIds) {
    try {
      const page = await graph.get(`/${id}`, userToken, { fields: PAGE_FIELDS });
      if (page.access_token) pages.push(page);
      else console.error(`[oauth meta] Page ${id} returned no access token`);
    } catch (err) {
      console.error(`[oauth meta] Page ${id} could not be read: ${err.message}`);
    }
  }
  const granted = grants.map((grant) => `${grant.scope}(${grant.target_ids?.length ?? 'all'})`).join(', ');
  console.error(`[oauth meta] /me/accounts was empty. Granted: ${granted || 'none'}. Pages recovered: ${pages.length}`);
  return pages;
}

export function registerOAuth(app, { config, store, setFlash }) {
  const states = new Map();

  // A state only works for the person it was issued to, so nobody can attach their account to someone else.
  function issueState(provider, userId) {
    for (const [key, entry] of states) {
      if (entry.expires <= Date.now()) states.delete(key);
    }
    const state = randomBytes(24).toString('hex');
    states.set(state, { provider, userId, expires: Date.now() + STATE_TTL_MS });
    return state;
  }

  function consumeState(state, provider, userId) {
    const entry = states.get(state);
    states.delete(state);
    return Boolean(entry && entry.provider === provider && entry.userId === userId && entry.expires > Date.now());
  }

  const redirectUri = (provider) => `${config.baseUrl}/auth/${provider}/callback`;

  function signedIn(req, res, next) {
    if (req.user) return next();
    res.redirect('/#/login');
  }

  function finish(req, res, flash) {
    setFlash(req.user.id, flash);
    res.redirect('/#/accounts');
  }

  app.get('/auth/meta/start', signedIn, (req, res) => {
    const { meta } = config;
    if (!meta.appId || !meta.appSecret) return finish(req, res, { level: 'error', text: "Meta isn't set up on this server yet." });
    const params = new URLSearchParams({
      client_id: meta.appId,
      redirect_uri: redirectUri('meta'),
      response_type: 'code',
      state: issueState('meta', req.user.id),
    });
    if (meta.configId) params.set('config_id', meta.configId);
    else params.set('scope', META_SCOPES);
    res.redirect(`${meta.dialogUrl}/${meta.version}/dialog/oauth?${params}`);
  });

  app.get('/auth/meta/callback', signedIn, async (req, res) => {
    const { meta } = config;
    if (!consumeState(req.query.state, 'meta', req.user.id)) return finish(req, res, { level: 'error', text: 'The Meta sign-in session expired. Try connecting again.' });
    if (!req.query.code) return finish(req, res, { level: 'error', text: 'Meta sign-in was canceled or permission was denied.' });
    try {
      const root = `${meta.graphUrl}/${meta.version}`;
      const short = await call(`${root}/oauth/access_token?${new URLSearchParams({
        client_id: meta.appId,
        client_secret: meta.appSecret,
        redirect_uri: redirectUri('meta'),
        code: req.query.code,
      })}`);
      const long = await call(`${root}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: meta.appId,
        client_secret: meta.appSecret,
        fb_exchange_token: short.access_token,
      })}`);
      const graph = createGraph(meta);
      const pages = await grantedPages(meta, graph, long.access_token);
      if (pages.length === 0) return finish(req, res, { level: 'error', text: 'Sign-in worked, but Meta returned no Facebook Page for this account. Connect again and tick your Page in the list.' });

      let linked = 0;
      for (const page of pages) {
        // A Page token derived from a long-lived user token does not expire on a timer.
        store.upsertAccount({ userId: req.user.id, platform: 'facebook', remote_id: page.id, name: page.name, token: page.access_token });
        const ig = page.instagram_business_account;
        if (ig) {
          store.upsertAccount({ userId: req.user.id, platform: 'instagram', remote_id: ig.id, name: `@${ig.username}`, token: page.access_token });
          linked += 1;
        }
      }
      const pageNote = `${pages.length} Facebook ${pages.length === 1 ? 'Page' : 'Pages'}`;
      const igNote = linked ? `${linked} Instagram ${linked === 1 ? 'account' : 'accounts'}` : 'no Instagram account linked to them';
      finish(req, res, { level: linked ? 'ok' : 'warn', text: `Connected ${pageNote}, ${igNote}.` });
    } catch (err) {
      console.error(`[oauth meta] ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      finish(req, res, { level: 'error', text: `Couldn't connect Meta: ${err.message}` });
    }
  });

  app.get('/auth/google/start', signedIn, (req, res) => {
    const { google } = config;
    if (!google.clientId || !google.clientSecret) return finish(req, res, { level: 'error', text: "YouTube isn't set up on this server yet." });
    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state: issueState('google', req.user.id),
    });
    res.redirect(`${google.authUrl}?${params}`);
  });

  app.get('/auth/google/callback', signedIn, async (req, res) => {
    const { google } = config;
    if (!consumeState(req.query.state, 'google', req.user.id)) return finish(req, res, { level: 'error', text: 'The Google sign-in session expired. Try connecting again.' });
    if (!req.query.code) return finish(req, res, { level: 'error', text: 'Google sign-in was canceled or permission was denied.' });
    try {
      const tokens = await call(google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: redirectUri('google'),
        }),
      });
      const channels = await call(`${google.apiUrl}/channels?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const channel = channels.items?.[0];
      if (!channel) return finish(req, res, { level: 'error', text: "This Google account doesn't have a YouTube channel yet." });
      store.upsertAccount({
        userId: req.user.id,
        platform: 'youtube',
        remote_id: channel.id,
        name: channel.snippet.title,
        token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
      });
      finish(req, res, { level: 'ok', text: `Connected YouTube channel ${channel.snippet.title}.` });
    } catch (err) {
      console.error(`[oauth google] ${err.message}`);
      finish(req, res, { level: 'error', text: `Couldn't connect YouTube: ${err.message}` });
    }
  });
}
