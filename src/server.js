import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerAdmin } from './admin.js';
import { createAuth } from './auth.js';
import { registerCovers } from './covers.js';
import { HttpError } from './http-error.js';
import { accountLimitFor, storageLimitFor } from './limits.js';
import { registerOAuth } from './oauth.js';
import { DAILY_LIMITS, SHARED_YOUTUBE_UPLOADS_PER_DAY } from './platforms/index.js';
import { publicSite } from './site.js';
import { ACTIVE_STATUSES, coverFile, videoFiles } from './store.js';
import { clearAbandonedUploads, registerUploads } from './uploads.js';
import { checkText, checkVideo } from './video-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 3_600_000;
const MIN_LEAD_MS = 60_000;

function hostGuard(config) {
  return (req, res, next) => {
    const allowed = new Set([new URL(config.baseUrl).host, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);
    if (!allowed.has(req.headers.host)) return res.status(403).type('text').send('Unrecognized host.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const { origin } = req.headers;
      let originHost = null;
      try {
        originHost = origin ? new URL(origin).host : null;
      } catch {
        originHost = 'invalid';
      }
      const crossSite = origin ? !allowed.has(originHost) : req.headers['sec-fetch-site'] === 'cross-site';
      if (crossSite) return res.status(403).json({ error: 'Requests from other sites are not allowed.' });
    }
    next();
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'",
  });
  next();
}

// Imports inside app.js are relative, so they follow the same versioned address without being rewritten.
function versionedAssets(dir) {
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).sort()) hash.update(name).update(readFileSync(path.join(dir, name)));
  const prefix = `/v/${hash.digest('hex').slice(0, 12)}`;
  const page = readFileSync(path.join(dir, 'index.html'), 'utf8')
    .replace('href="/styles.css"', `href="${prefix}/styles.css"`)
    .replace('src="/app.js"', `src="${prefix}/app.js"`);
  return { dir, prefix, page };
}

function targetView(target) {
  return {
    id: target.id,
    platform: target.platform,
    accountName: target.account_name,
    status: target.status,
    publishAt: target.publish_at,
    error: target.error,
    attempts: target.attempts,
    nextRunAt: target.next_run_at,
    remoteUrl: target.remote_url,
    coverNote: target.stage.coverNote ?? null,
    // TikTok drafts arrive without a caption, so the schedule offers it for copying.
    ...(target.platform === 'tiktok' ? { caption: target.caption } : {}),
  };
}

export function createApp({ config, store, scheduler, platforms, now = Date.now }) {
  const app = express();
  const videosDir = path.join(config.dataDir, 'videos');
  mkdirSync(videosDir, { recursive: true });

  const flashes = new Map();
  const auth = createAuth({ config, store, now });

  function removeVideoFiles(video) {
    for (const file of videoFiles(video)) rmSync(path.join(videosDir, file), { force: true });
  }

  function removePost(id) {
    const orphan = store.deletePost(id);
    if (orphan) removeVideoFiles(orphan);
  }

  app.disable('x-powered-by');
  app.use(publicSite(config));
  app.use(hostGuard(config));
  app.use(securityHeaders);
  app.use(auth.attachUser);

  // Cloudflare makes browsers keep scripts and stylesheets for 4 hours whatever the app asks, but it leaves
  // HTML alone. So the page always comes fresh and points at files whose address changes with their content.
  const assets = versionedAssets(path.join(ROOT, 'public'));
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(assets.page);
  });
  app.use(assets.prefix, express.static(assets.dir, { index: false, maxAge: '1y', immutable: true }));
  app.use('/fonts', express.static(path.join(ROOT, 'node_modules/@fontsource-variable/plus-jakarta-sans/files'), { maxAge: '30d', immutable: true }));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  auth.register(app);
  registerOAuth(app, {
    config,
    store,
    now,
    stylesheet: `${assets.prefix}/styles.css`,
    setFlash: (userId, value) => flashes.set(userId, value),
  });

  // Everything below belongs to whoever is logged in, and every lookup is limited to that person.
  app.use('/api', auth.requireUser);

  registerAdmin(app, { config, store, requireAdmin: auth.requireAdmin, videosDir });
  clearAbandonedUploads(videosDir);
  registerUploads(app, { config, store, videosDir, now, removeVideoFiles });

  app.get('/api/state', (req, res) => {
    const pending = flashes.get(req.user.id) ?? null;
    flashes.delete(req.user.id);
    res.json({
      demo: config.demo,
      baseUrl: config.baseUrl,
      siteHost: config.site.host,
      user: { id: req.user.id, username: req.user.username, isAdmin: Boolean(req.user.is_admin) },
      accounts: store.listAccounts(req.user.id),
      accountLimit: accountLimitFor(config, req.user),
      connect: {
        meta: Boolean(config.meta.appId && config.meta.appSecret),
        google: Boolean(config.google.clientId && config.google.clientSecret),
        tiktok: Boolean(config.tiktok.clientKey && config.tiktok.clientSecret),
      },
      storage: {
        usedBytes: store.usedBytes(req.user.id),
        limitBytes: storageLimitFor(config, req.user),
      },
      retentionDays: config.retention.postMs / DAY_MS,
      igLeadMinutes: config.schedule.igLeadMs / 60_000,
      flash: pending,
    });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const account = store.getAccountFor(req.user.id, req.params.id);
    if (!account) throw new HttpError(404, 'Account not found.');
    const active = store.countActiveTargets(account.id);
    if (active > 0) throw new HttpError(409, `This account still has ${active} active ${active === 1 ? 'post' : 'posts'}. Cancel ${active === 1 ? 'it' : 'them'} first.`);
    store.deleteAccount(account.id);
    // Posts that only went to this account are gone from the schedule, so their videos shouldn't use up storage.
    for (const postId of store.emptyPostIds(req.user.id)) removePost(postId);
    res.status(204).end();
  });

  // The browser has to ask every time, or the next person logged in on it could be handed a cached copy.
  function sendOwnFile(res, fileName) {
    res.set('Cache-Control', 'private, no-cache');
    res.sendFile(fileName, { root: videosDir, cacheControl: false });
  }

  app.get('/api/videos/:id/file', (req, res) => {
    const video = store.getVideoFor(req.user.id, req.params.id);
    if (!video) throw new HttpError(404, 'Video not found.');
    sendOwnFile(res, video.file_name);
  });

  // The schedule shows the chosen cover when there is one.
  app.get('/api/videos/:id/thumb', (req, res) => {
    const video = store.getVideoFor(req.user.id, req.params.id);
    if (!video?.has_thumb && !video?.has_cover) throw new HttpError(404, 'Thumbnail not found.');
    sendOwnFile(res, video.has_cover ? coverFile(video.id) : `${video.id}.jpg`);
  });

  registerCovers(app, { config, store, videosDir, sendOwnFile });

  // TikTok fetches the video itself, from a link that only works while that send is under way.
  app.get('/media/:file', (req, res) => {
    const token = req.params.file.match(/^([A-Za-z0-9_-]{32}).mp4$/)?.[1];
    const video = token ? store.videoForOpenMediaLink(token) : null;
    if (!video) return res.status(404).type('text').send('Not found.');
    res.set('Cache-Control', 'no-store');
    res.sendFile(video.file_name, { root: videosDir, cacheControl: false });
  });

  app.post('/api/posts', express.json({ limit: '1mb' }), (req, res) => {
    const { videoId, caption = '', publishNow = false, targets } = req.body ?? {};
    const publishAt = publishNow === true ? now() : req.body?.publishAt;
    const video = store.getVideoFor(req.user.id, String(videoId));
    if (!video) throw new HttpError(422, 'The video has not been uploaded.');
    if (typeof caption !== 'string') throw new HttpError(422, 'The caption is not valid.');
    if (!Number.isFinite(publishAt)) throw new HttpError(422, 'A publish time is required.');
    if (publishNow !== true && publishAt < now() + MIN_LEAD_MS) throw new HttpError(422, 'The publish time must be at least 1 minute from now.');
    if (!Array.isArray(targets) || targets.length === 0) throw new HttpError(422, 'Choose at least one account.');

    const checks = checkVideo(video.info);
    const prepared = targets.map((target) => {
      const account = store.getAccountFor(req.user.id, String(target?.accountId));
      if (!account) throw new HttpError(422, 'One of the chosen accounts is no longer connected.');
      if (account.needs_reconnect) throw new HttpError(422, `${account.name} needs to be reconnected first.`);
      const check = checks[account.platform];
      if (!check.ok) throw new HttpError(422, `${account.name}: ${check.issues.find((issue) => issue.level === 'error').text}`);
      const text = {
        caption: typeof target.caption === 'string' ? target.caption : caption,
        title: typeof target.title === 'string' ? target.title.trim() : null,
      };
      const problem = checkText(account.platform, text);
      if (problem) throw new HttpError(422, `${account.name}: ${problem}`);
      const limit = DAILY_LIMITS[account.platform];
      if (store.countNear(account.id, publishAt, DAY_MS) >= limit) {
        throw new HttpError(422, `${account.name} has reached the limit of ${limit} posts per 24 hours around that time.`);
      }
      return { accountId: account.id, platform: account.platform, ...text, madeForKids: Boolean(target.madeForKids) };
    });

    const youtubeUploads = prepared.filter((target) => target.platform === 'youtube').length;
    if (youtubeUploads > 0 && store.countYouTubeUploadsSince(now() - DAY_MS) + youtubeUploads > SHARED_YOUTUBE_UPLOADS_PER_DAY) {
      throw new HttpError(422, "This server has used up today's YouTube upload allowance, which everyone here shares. Try YouTube again tomorrow.");
    }

    const postId = store.createPost({ userId: req.user.id, videoId: video.id, caption, publishAt, targets: prepared });
    scheduler.kick();
    res.status(201).json({ id: postId });
  });

  app.get('/api/posts', (req, res) => {
    const posts = store.listPosts(req.user.id)
      .filter((post) => post.targets.length > 0)
      .map((post) => ({
        id: post.id,
        caption: post.caption,
        publishAt: post.publish_at,
        video: {
          originalName: post.original_name,
          durationSec: JSON.parse(post.info).durationSec,
          thumbUrl: post.has_thumb || post.has_cover ? `/api/videos/${post.video_id}/thumb` : null,
        },
        targets: post.targets.map(targetView),
      }));
    res.json({ posts, serverTime: now() });
  });

  app.delete('/api/posts/:id', (req, res) => {
    const post = store.getPostFor(req.user.id, req.params.id);
    if (!post) throw new HttpError(404, 'Post not found.');
    if (store.postTargets(post.id).some((target) => ACTIVE_STATUSES.includes(target.status))) {
      throw new HttpError(409, 'Some destinations are still active. Cancel them first.');
    }
    removePost(post.id);
    res.status(204).end();
  });

  function loadTarget(req) {
    const target = store.getTargetFor(req.user.id, req.params.id);
    if (!target) throw new HttpError(404, 'Destination not found.');
    return target;
  }

  app.post('/api/targets/:id/retry', (req, res) => {
    const target = loadTarget(req);
    if (target.status !== 'failed' && target.status !== 'missed') throw new HttpError(409, "This destination hasn't failed.");
    if (store.getAccount(target.account_id).needs_reconnect) throw new HttpError(409, `${target.account_name} needs to be reconnected first.`);
    const { failedFrom, restart, ...stage } = target.stage;
    const pastGrace = now() > target.publish_at + config.schedule.missedGraceMs;
    store.patchTarget(target.id, {
      status: restart ? 'waiting' : failedFrom ?? 'waiting',
      stage: restart ? {} : stage,
      error: null,
      attempts: 0,
      next_run_at: now(),
      ...(pastGrace ? { publish_at: now() } : {}),
    });
    scheduler.kick();
    res.json({ target: targetView(store.getTarget(target.id)) });
  });

  app.post('/api/targets/:id/cancel', async (req, res) => {
    const target = loadTarget(req);
    if (!ACTIVE_STATUSES.includes(target.status)) throw new HttpError(409, 'This destination is no longer active.');
    if (scheduler.isBusy(target.id)) throw new HttpError(409, 'The video is being processed. Try again in a moment.');
    try {
      await platforms[target.platform].cancel(target, store.getAccount(target.account_id), scheduler.context);
    } catch (err) {
      throw new HttpError(502, `Couldn't cancel on the platform: ${err.message}`);
    }
    store.patchTarget(target.id, { status: 'canceled', next_run_at: null, error: null });
    res.json({ target: targetView(store.getTarget(target.id)) });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server.' : err.message });
  });

  return app;
}
