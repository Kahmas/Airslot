import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import express from 'express';
import { hashPassword } from './auth.js';
import { HttpError } from './http-error.js';
import { accountLimitFor, storageLimitFor } from './limits.js';

// No I, O, 0, or 1, because people read these codes off a screen and retype them.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newInviteCode() {
  const letters = Array.from(randomBytes(12), (byte) => INVITE_ALPHABET.at(byte % INVITE_ALPHABET.length));
  return [letters.slice(0, 4), letters.slice(4, 8), letters.slice(8, 12)].map((group) => group.join('')).join('-');
}

export function registerAdmin(app, { config, store, requireAdmin, videosDir }) {
  function loadOtherUser(req) {
    const user = store.getUser(req.params.id);
    if (!user) throw new HttpError(404, 'User not found.');
    if (user.id === req.user.id) throw new HttpError(409, "You can't do this to your own account.");
    return user;
  }

  app.get('/api/admin/overview', requireAdmin, (req, res) => {
    const disk = statfsSync(videosDir);
    res.json({
      users: store.listUsers().map((user) => ({
        id: user.id,
        username: user.username,
        isAdmin: Boolean(user.is_admin),
        disabled: Boolean(user.disabled),
        createdAt: user.created_at,
        accountCount: user.account_count,
        postCount: user.post_count,
        usedBytes: user.used_bytes,
        limitBytes: storageLimitFor(config, user),
        customLimit: user.storage_limit_bytes != null,
        accountLimit: accountLimitFor(config, user),
        customAccountLimit: user.account_limit != null,
      })),
      invites: store.listInvites().map((invite) => ({
        code: invite.code,
        createdAt: invite.created_at,
        usedAt: invite.used_at,
        usedBy: invite.used_by_name,
      })),
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      defaultLimitBytes: config.storage.perUserBytes,
      defaultAccountLimit: config.accounts.perUser,
      signupOpen: config.signup.open,
    });
  });

  app.post('/api/admin/invites', requireAdmin, (req, res) => {
    const code = newInviteCode();
    store.createInvite(code, req.user.id);
    res.status(201).json({ code });
  });

  app.delete('/api/admin/invites/:code', requireAdmin, (req, res) => {
    if (!store.revokeInvite(req.params.code)) throw new HttpError(404, 'That invite was already used or removed.');
    res.status(204).end();
  });

  // A limit below what someone already uses keeps their videos and only stops new uploads. Null means the default.
  app.post('/api/admin/users/:id/storage', requireAdmin, express.json({ limit: '1kb' }), (req, res) => {
    const user = loadOtherUser(req);
    const { limitBytes } = req.body ?? {};
    if (limitBytes !== null && (!Number.isSafeInteger(limitBytes) || limitBytes < 0)) {
      throw new HttpError(422, 'The storage limit is not valid.');
    }
    store.setStorageLimit(user.id, limitBytes);
    res.status(204).end();
  });

  // A limit below what someone has connected keeps those accounts and only stops new ones. Null means the default.
  app.post('/api/admin/users/:id/account-limit', requireAdmin, express.json({ limit: '1kb' }), (req, res) => {
    const user = loadOtherUser(req);
    const { limit } = req.body ?? {};
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new HttpError(422, 'The account limit is not valid.');
    }
    store.setAccountLimit(user.id, limit);
    res.status(204).end();
  });

  app.post('/api/admin/users/:id/disable', requireAdmin, (req, res) => {
    const user = loadOtherUser(req);
    store.setUserDisabled(user.id, true);
    store.deleteUserSessions(user.id);
    res.status(204).end();
  });

  app.post('/api/admin/users/:id/enable', requireAdmin, (req, res) => {
    const user = loadOtherUser(req);
    store.setUserDisabled(user.id, false);
    res.status(204).end();
  });

  app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const user = loadOtherUser(req);
    const password = randomBytes(12).toString('base64url');
    store.setPasswordHash(user.id, await hashPassword(password));
    store.deleteUserSessions(user.id);
    res.json({ password });
  });
}
