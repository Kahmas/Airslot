import { randomBytes } from 'node:crypto';
import express from 'express';
import { HttpError } from './http-error.js';
import { accountLimitFor } from './limits.js';
import { call, createGraph } from './platforms/http.js';
import { requestToken, TIKTOK_SCOPES, tiktokCall } from './platforms/tiktok.js';
import { escapeHtml } from './site.js';

const STATE_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
// One scope covers upload, reading status and deleting a scheduled video.
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish';
const PAGE_FIELDS = 'id,name,access_token,instagram_business_account{id,username}';
const PROVIDER_NAMES = { meta: 'Facebook and Instagram', google: 'YouTube', tiktok: 'TikTok' };

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

export function registerOAuth(app, { config, store, setFlash, stylesheet, now = Date.now }) {
  const states = new Map();
  const links = new Map();

  // A state only works for the person it was issued to, so nobody can attach their account to someone else.
  // fromLink marks a sign-in started from a copied link, where the browser has no Airslot login of its own.
  function issueState(provider, userId, fromLink = false) {
    for (const [key, entry] of states) {
      if (entry.expires <= Date.now()) states.delete(key);
    }
    const state = randomBytes(24).toString('hex');
    states.set(state, { provider, userId, fromLink, expires: Date.now() + STATE_TTL_MS });
    return state;
  }

  function takeState(state, provider) {
    const entry = states.get(state);
    states.delete(state);
    return entry && entry.provider === provider && entry.expires > Date.now() ? entry : null;
  }

  const redirectUri = (provider) => `${config.baseUrl}/auth/${provider}/callback`;

  function metaDialogUrl(state) {
    const { meta } = config;
    const params = new URLSearchParams({
      client_id: meta.appId,
      redirect_uri: redirectUri('meta'),
      response_type: 'code',
      state,
    });
    if (meta.configId) params.set('config_id', meta.configId);
    else params.set('scope', META_SCOPES);
    return `${meta.dialogUrl}/${meta.version}/dialog/oauth?${params}`;
  }

  function googleDialogUrl(state) {
    const { google } = config;
    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      access_type: 'offline',
      // select_account always offers a choice, so a second Google account can be added.
      prompt: 'select_account consent',
      state,
    });
    return `${google.authUrl}?${params}`;
  }

  function tiktokDialogUrl(state) {
    const { tiktok } = config;
    const params = new URLSearchParams({
      client_key: tiktok.clientKey,
      response_type: 'code',
      scope: TIKTOK_SCOPES,
      redirect_uri: redirectUri('tiktok'),
      state,
      // Always shows the permission page, so it is clear which TikTok account is about to connect.
      disable_auto_auth: '1',
    });
    return `${tiktok.authUrl}?${params}`;
  }

  const providerReady = {
    meta: () => Boolean(config.meta.appId && config.meta.appSecret),
    google: () => Boolean(config.google.clientId && config.google.clientSecret),
    tiktok: () => Boolean(config.tiktok.clientKey && config.tiktok.clientSecret),
  };
  const dialogUrl = { meta: metaDialogUrl, google: googleDialogUrl, tiktok: tiktokDialogUrl };

  function signedIn(req, res, next) {
    if (req.user) return next();
    res.redirect('/#/login');
  }

  function finish(req, res, flash) {
    setFlash(req.user.id, flash);
    res.redirect('/#/accounts');
  }

  function linkPage(res, status, title, body) {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} | Airslot</title>
  <link rel="stylesheet" href="${stylesheet}">
</head>
<body>
  <main class="connect-page">
    <p class="wordmark">Airslot</p>
    <div class="card auth-card">
      <h1 class="auth-title">${title}</h1>
      ${body}
    </div>
  </main>
</body>
</html>`);
  }

  // Who a sign-in belongs to, and where it ends. A copied link settled that on its confirmation page,
  // so it needs no login here. Any other sign-in has to come back to the person who started it.
  function callbackContext(req, res, provider) {
    const entry = takeState(req.query.state, provider);
    if (entry?.fromLink) {
      const user = store.getUser(entry.userId);
      if (!user || user.disabled) {
        linkPage(res, 410, 'This link no longer works', '<p class="auth-note">The Airslot login it belongs to is turned off.</p>');
        return null;
      }
      return {
        user,
        valid: true,
        finish: (flash) => {
          setFlash(user.id, flash);
          const title = flash.level === 'error' ? 'Not connected' : 'Connected';
          linkPage(res, 200, title, `<p class="auth-note">${escapeHtml(flash.text)}</p><p class="auth-note">You can close this window and go back to Airslot.</p>`);
        },
      };
    }
    if (!req.user) {
      res.redirect('/#/login');
      return null;
    }
    return { user: req.user, valid: entry?.userId === req.user.id, finish: (flash) => finish(req, res, flash) };
  }

  // Connecting again only refreshes an account's access, so it never counts against the limit.
  function connectWithinLimit(user, candidates) {
    const limit = accountLimitFor(config, user);
    let count = store.countAccounts(user.id);
    const connected = [];
    const leftOut = [];
    for (const account of candidates) {
      const isNew = !store.hasAccount(user.id, account.platform, account.remote_id);
      if (isNew && limit != null && count >= limit) {
        leftOut.push(account.name);
      } else {
        store.upsertAccount({ userId: user.id, ...account });
        if (isNew) count += 1;
        connected.push(account);
      }
    }
    const note = leftOut.length > 0
      ? `Your limit of ${limit} ${limit === 1 ? 'account' : 'accounts'} left out ${leftOut.join(', ')}. Disconnect an account, or ask your admin for more.`
      : '';
    return { connected, note };
  }

  // A link can be pasted into a browser profile where the other Facebook or Google account is logged in.
  // It is one-use and short-lived, because whoever signs in through it attaches their account to this person.
  app.post('/api/connect-links', express.json({ limit: '1kb' }), (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in.' });
    const provider = req.body?.provider;
    if (!Object.hasOwn(providerReady, provider)) throw new HttpError(422, 'That platform is not valid.');
    if (!providerReady[provider]()) throw new HttpError(422, "That platform isn't set up on this server yet.");

    for (const [key, link] of links) {
      if (link.expires <= now() || (link.userId === req.user.id && link.provider === provider)) links.delete(key);
    }
    const token = randomBytes(32).toString('base64url');
    const expires = now() + LINK_TTL_MS;
    links.set(token, { provider, userId: req.user.id, expires });
    res.status(201).json({ url: `${config.baseUrl}/connect/${token}`, expiresAt: expires });
  });

  function openLink(token) {
    const link = links.get(token);
    if (!link || link.expires <= now()) return null;
    const user = store.getUser(link.userId);
    return user && !user.disabled ? { link, user } : null;
  }

  const deadLink = (res) => linkPage(res, 410, 'This link no longer works', '<p class="auth-note">It has expired, or it was already used. Copy a new one from the Accounts page in Airslot.</p>');

  // Opening the link only shows this page. Previews and link checkers fetch it too, so only the button uses it up.
  app.get('/connect/:token', (req, res) => {
    const opened = openLink(req.params.token);
    if (!opened) return deadLink(res);
    linkPage(res, 200, 'Connect to Airslot?', `
      <p class="auth-note">This adds the ${PROVIDER_NAMES[opened.link.provider]} account you choose next to the Airslot login <strong>${escapeHtml(opened.user.username)}</strong>.</p>
      <p class="auth-note"><strong>Only continue if you made this link yourself.</strong> Whoever holds that Airslot login will be able to post to the account you connect.</p>
      <form method="post"><button class="btn btn-primary auth-submit connect-continue" type="submit">Continue</button></form>`);
  });

  app.post('/connect/:token', (req, res) => {
    const opened = openLink(req.params.token);
    links.delete(req.params.token);
    if (!opened) return deadLink(res);
    const { provider } = opened.link;
    res.redirect(303, dialogUrl[provider](issueState(provider, opened.user.id, true)));
  });

  app.get('/auth/meta/start', signedIn, (req, res) => {
    if (!providerReady.meta()) return finish(req, res, { level: 'error', text: "Meta isn't set up on this server yet." });
    res.redirect(metaDialogUrl(issueState('meta', req.user.id)));
  });

  app.get('/auth/meta/callback', async (req, res) => {
    const { meta } = config;
    const context = callbackContext(req, res, 'meta');
    if (!context) return;
    const { user, valid, finish: done } = context;
    if (!valid) return done({ level: 'error', text: 'The Meta sign-in session expired. Try connecting again.' });
    if (!req.query.code) return done({ level: 'error', text: 'Meta sign-in was canceled or permission was denied.' });
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
      if (pages.length === 0) return done({ level: 'error', text: 'Sign-in worked, but Meta returned no Facebook Page for this account. Connect again and tick your Page in the list.' });

      // A Page token derived from a long-lived user token does not expire on a timer.
      const candidates = pages.flatMap((page) => {
        const ig = page.instagram_business_account;
        return [
          { platform: 'facebook', remote_id: page.id, name: page.name, token: page.access_token },
          ...(ig ? [{ platform: 'instagram', remote_id: ig.id, name: `@${ig.username}`, token: page.access_token }] : []),
        ];
      });
      const { connected, note } = connectWithinLimit(user, candidates);
      if (connected.length === 0) return done({ level: 'error', text: `Nothing new was connected. ${note}` });

      const pageCount = connected.filter((account) => account.platform === 'facebook').length;
      const igCount = connected.filter((account) => account.platform === 'instagram').length;
      const noneLinked = !candidates.some((account) => account.platform === 'instagram');
      const parts = [
        pageCount > 0 && `${pageCount} Facebook ${pageCount === 1 ? 'Page' : 'Pages'}`,
        igCount > 0 && `${igCount} Instagram ${igCount === 1 ? 'account' : 'accounts'}`,
        noneLinked && 'no Instagram account linked to them',
      ].filter(Boolean);
      done({ level: note || noneLinked ? 'warn' : 'ok', text: `Connected ${parts.join(', ')}.${note ? ` ${note}` : ''}` });
    } catch (err) {
      console.error(`[oauth meta] ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      done({ level: 'error', text: `Couldn't connect Meta: ${err.message}` });
    }
  });

  app.get('/auth/google/start', signedIn, (req, res) => {
    if (!providerReady.google()) return finish(req, res, { level: 'error', text: "YouTube isn't set up on this server yet." });
    res.redirect(googleDialogUrl(issueState('google', req.user.id)));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const { google } = config;
    const context = callbackContext(req, res, 'google');
    if (!context) return;
    const { user, valid, finish: done } = context;
    if (!valid) return done({ level: 'error', text: 'The Google sign-in session expired. Try connecting again.' });
    if (!req.query.code) return done({ level: 'error', text: 'Google sign-in was canceled or permission was denied.' });
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
      if (!channel) return done({ level: 'error', text: "This Google account doesn't have a YouTube channel yet." });
      const { connected, note } = connectWithinLimit(user, [{
        platform: 'youtube',
        remote_id: channel.id,
        name: channel.snippet.title,
        token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
      }]);
      if (connected.length === 0) return done({ level: 'error', text: `Nothing new was connected. ${note}` });
      done({ level: 'ok', text: `Connected YouTube channel ${channel.snippet.title}.` });
    } catch (err) {
      console.error(`[oauth google] ${err.message}`);
      done({ level: 'error', text: `Couldn't connect YouTube: ${err.message}` });
    }
  });

  app.get('/auth/tiktok/start', signedIn, (req, res) => {
    if (!providerReady.tiktok()) return finish(req, res, { level: 'error', text: "TikTok isn't set up on this server yet." });
    res.redirect(tiktokDialogUrl(issueState('tiktok', req.user.id)));
  });

  app.get('/auth/tiktok/callback', async (req, res) => {
    const { tiktok } = config;
    const context = callbackContext(req, res, 'tiktok');
    if (!context) return;
    const { user, valid, finish: done } = context;
    if (!valid) return done({ level: 'error', text: 'The TikTok sign-in session expired. Try connecting again.' });
    if (!req.query.code) return done({ level: 'error', text: 'TikTok sign-in was canceled or permission was denied.' });
    try {
      const tokens = await requestToken(tiktok, {
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: redirectUri('tiktok'),
      });
      const granted = String(tokens.scope ?? '').split(',').map((scope) => scope.trim());
      if (!granted.includes('video.upload')) {
        return done({ level: 'error', text: 'TikTok connected without permission to send videos. Connect again and allow every permission.' });
      }
      const info = await tiktokCall(tiktok, '/v2/user/info/', tokens.access_token, { query: { fields: 'open_id,display_name' } });
      const profile = info.user ?? info;
      const { connected, note } = connectWithinLimit(user, [{
        platform: 'tiktok',
        remote_id: profile.open_id ?? tokens.open_id,
        name: profile.display_name || 'TikTok account',
        token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
      }]);
      if (connected.length === 0) return done({ level: 'error', text: `Nothing new was connected. ${note}` });
      done({ level: 'ok', text: `Connected TikTok account ${connected[0].name}.` });
    } catch (err) {
      console.error(`[oauth tiktok] ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      done({ level: 'error', text: `Couldn't connect TikTok: ${err.message}` });
    }
  });
}
