import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { listensLocally, requiresPassword } from './config.js';
import { HttpError } from './http-error.js';
import { StoreConflict } from './store.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

const DAY_MS = 24 * 3_600_000;
const SESSION_MS = 30 * DAY_MS;
const RENEW_BELOW_MS = 15 * DAY_MS;
const COOKIE = 'airslot_session';

const USERNAME = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [, N, r, p, salt, expected] = stored.split('$');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), KEY_LENGTH, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, Buffer.from(expected, 'base64'));
}

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function startSession(store, userId, at) {
  const token = randomBytes(32).toString('base64url');
  store.createSession(hashToken(token), userId, at + SESSION_MS);
  return token;
}

function equalStrings(a, b) {
  const hash = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function readCookie(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value ?? null;
  }
  return null;
}

function createLimiter(now) {
  const hits = new Map();
  const live = (key) => {
    const entry = hits.get(key);
    if (entry && entry.resetAt > now()) return entry;
    hits.delete(key);
    return null;
  };
  return {
    count: (key) => live(key)?.count ?? 0,
    hit(key, windowMs) {
      if (hits.size > 20_000) hits.clear();
      const entry = live(key);
      if (entry) entry.count += 1;
      else hits.set(key, { count: 1, resetAt: now() + windowMs });
    },
    clear: (key) => hits.delete(key),
  };
}

function credentialProblem(username, password) {
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    return 'Usernames are 3 to 32 characters: letters, numbers, dots, dashes, and underscores.';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Passwords can be at most ${MAX_PASSWORD} characters.`;
  return null;
}

const userView = (user) => ({ id: user.id, username: user.username, isAdmin: Boolean(user.is_admin) });

export function createAuth({ config, store, now }) {
  const limiter = createLimiter(now);
  const { limits } = config;
  const json = express.json({ limit: '16kb' });
  // Comparing against this for unknown usernames keeps both answers equally slow.
  const decoyHash = hashPassword(randomBytes(16).toString('hex'));

  // Every tunnel request arrives from localhost, so Cloudflare's header is what tells people apart.
  // It is only believed when nothing but the local tunnel can reach the app.
  function clientIp(req) {
    const forwarded = listensLocally(config) ? req.headers['cf-connecting-ip'] : null;
    return forwarded ?? req.socket.remoteAddress ?? 'unknown';
  }

  function setCookie(res, token, maxAgeMs) {
    const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
  }

  function signIn(res, userId) {
    setCookie(res, startSession(store, userId, now()), SESSION_MS);
  }

  function attachUser(req, res, next) {
    const token = readCookie(req);
    const hash = token ? hashToken(token) : null;
    const user = hash ? store.getSessionUser(hash) : null;
    if (user) {
      req.user = user;
      req.sessionHash = hash;
      if (user.expires_at - now() < RENEW_BELOW_MS) {
        store.renewSession(hash, now() + SESSION_MS);
        setCookie(res, token, SESSION_MS);
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (req.user) return next();
    // An upload piece may still be arriving, and the answer only reaches the browser once it is read.
    req.resume();
    res.status(401).json({ error: 'Please log in.' });
  }

  function requireAdmin(req, res, next) {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Only an admin can do this.' });
    next();
  }

  function setupCodeAccepted(code) {
    if (config.appPassword) return typeof code === 'string' && equalStrings(code, config.appPassword);
    return !requiresPassword(config);
  }

  function register(app) {
    app.get('/api/session', (req, res) => {
      const needsSetup = store.countUsers() === 0;
      res.json({
        user: req.user ? userView(req.user) : null,
        needsSetup,
        needsSetupCode: needsSetup && Boolean(config.appPassword),
        needsInvite: !needsSetup && !config.signup.open,
        demo: config.demo,
        siteHost: config.site.host,
      });
    });

    app.post('/api/auth/signup', json, async (req, res) => {
      const { username, password, code } = req.body ?? {};
      const problem = credentialProblem(username, password);
      if (problem) throw new HttpError(422, problem);

      const signupKey = `signup|${clientIp(req)}`;
      if (limiter.count(signupKey) >= limits.signupPerHour) throw new HttpError(429, 'Too many sign-up attempts. Try again in an hour.');
      limiter.hit(signupKey, 3_600_000);

      const firstUser = store.countUsers() === 0;
      const inviteCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
      if (firstUser) {
        if (!setupCodeAccepted(code)) throw new HttpError(403, 'That setup code is not right.');
      } else if (!config.signup.open && !store.inviteIsUsable(inviteCode)) {
        // Checked before the username, so nobody can probe for usernames without an invite.
        throw new HttpError(403, 'That invite code is not valid, or it was already used.');
      }

      const passwordHash = await hashPassword(password);
      try {
        const id = firstUser
          ? store.createFirstAdmin({ username, passwordHash })
          : store.createUser({ username, passwordHash, inviteCode: config.signup.open ? null : inviteCode });
        signIn(res, id);
        res.status(201).json({ user: userView(store.getUser(id)) });
      } catch (err) {
        if (!(err instanceof StoreConflict)) throw err;
        if (err.kind === 'username') throw new HttpError(409, 'That username is taken. Try another.');
        if (err.kind === 'invite') throw new HttpError(403, 'That invite code is not valid, or it was already used.');
        throw new HttpError(409, 'Setup was just finished by someone else. Log in instead.');
      }
    });

    app.post('/api/auth/login', json, async (req, res) => {
      const { username, password } = req.body ?? {};
      const ip = clientIp(req);
      const nameKey = `login|${String(username).toLowerCase()}|${ip}`;
      const ipKey = `login-ip|${ip}`;
      if (limiter.count(nameKey) >= limits.loginFailuresPerName || limiter.count(ipKey) >= limits.loginFailuresPerIp) {
        throw new HttpError(429, 'Too many attempts. Wait 15 minutes, then try again.');
      }

      const valid = typeof username === 'string' && typeof password === 'string' && password.length <= MAX_PASSWORD;
      const user = valid ? store.getUserByUsername(username) : null;
      const matches = await verifyPassword(valid ? password : '', user?.password_hash ?? await decoyHash);
      if (!user || !matches) {
        limiter.hit(nameKey, 15 * 60_000);
        limiter.hit(ipKey, 15 * 60_000);
        throw new HttpError(401, 'Wrong username or password.');
      }
      if (user.disabled) throw new HttpError(403, 'This account is turned off. Contact your admin.');

      limiter.clear(nameKey);
      signIn(res, user.id);
      res.json({ user: userView(user) });
    });

    app.post('/api/auth/logout', (req, res) => {
      if (req.sessionHash) store.deleteSession(req.sessionHash);
      setCookie(res, '', 0);
      res.status(204).end();
    });

    app.post('/api/auth/password', json, requireUser, async (req, res) => {
      const { current, next } = req.body ?? {};
      const key = `password|${req.user.id}`;
      if (limiter.count(key) >= limits.loginFailuresPerName) throw new HttpError(429, 'Too many attempts. Wait 15 minutes, then try again.');
      const user = store.getUser(req.user.id);
      const matches = typeof current === 'string' && current.length <= MAX_PASSWORD && await verifyPassword(current, user.password_hash);
      if (!matches) {
        limiter.hit(key, 15 * 60_000);
        throw new HttpError(403, 'Your current password is not right.');
      }
      const problem = credentialProblem(user.username, next);
      if (problem) throw new HttpError(422, problem);
      store.setPasswordHash(user.id, await hashPassword(next));
      // Anyone signed in elsewhere with the old password is signed out.
      store.deleteUserSessions(user.id, req.sessionHash);
      res.status(204).end();
    });
  }

  return { attachUser, requireUser, requireAdmin, register };
}
