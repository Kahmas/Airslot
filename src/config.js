import path from 'node:path';

const MINUTE = 60_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// An app bound to localhost is still public when a tunnel points at it, so the address decides too.
export function requiresPassword(config) {
  return !LOCAL_HOSTS.has(config.host) || !LOCAL_HOSTS.has(new URL(config.baseUrl).hostname);
}

// Only true when nothing but a local proxy can talk to the app, which makes its headers trustworthy.
export const listensLocally = (config) => LOCAL_HOSTS.has(config.host);

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    // The setup code that creates the first admin account. It does nothing once that account exists.
    appPassword: env.APP_PASSWORD || null,
    signup: {
      open: env.SIGNUP_OPEN === 'true',
    },
    storage: {
      perUserBytes: Number(env.USER_STORAGE_MB ?? 10240) * 1024 * 1024,
    },
    accounts: {
      // Each Facebook Page, Instagram account, and YouTube channel counts as one.
      perUser: Number(env.USER_ACCOUNT_LIMIT ?? 3),
    },
    retention: {
      // Finished posts and their videos leave this server after this long. Posts on the platforms stay.
      postMs: Number(env.POST_RETENTION_DAYS ?? 7) * 24 * 60 * MINUTE,
    },
    limits: {
      signupPerHour: 10,
      loginFailuresPerName: 8,
      loginFailuresPerIp: 40,
    },
    site: {
      host: env.SITE_HOST?.toLowerCase() || null,
      contactEmail: env.SITE_CONTACT_EMAIL || null,
    },
    demo: false,
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    upload: {
      // Cloudflare's Free plan refuses request bodies over 100 MB, so files travel in smaller pieces.
      chunkBytes: 50 * 1024 * 1024,
    },
    meta: {
      appId: env.META_APP_ID || null,
      appSecret: env.META_APP_SECRET || null,
      configId: env.META_CONFIG_ID || null,
      version: env.META_API_VERSION || 'v26.0',
      graphUrl: 'https://graph.facebook.com',
      ruploadUrl: 'https://rupload.facebook.com',
      dialogUrl: 'https://www.facebook.com',
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      apiUrl: 'https://www.googleapis.com/youtube/v3',
      uploadUrl: 'https://www.googleapis.com/upload/youtube/v3',
    },
    schedule: {
      tickMs: 15_000,
      concurrency: 3,
      // Instagram has no native scheduling, so the video is prepared shortly before air time.
      igLeadMs: 15 * MINUTE,
      // YouTube caps uploads per channel per day, so videos go up a day ahead instead of all on the day they're scheduled.
      ytLeadMs: 24 * 60 * MINUTE,
      // After this long past air time a post is flagged instead of going out unexpectedly late.
      missedGraceMs: 120 * MINUTE,
    },
  };
}
