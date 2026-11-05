import { rmSync } from 'node:fs';
import path from 'node:path';
import { AuthError, PermanentError } from './platforms/http.js';
import { coverFile, videoFiles } from './store.js';

const MINUTE = 60_000;
const SWEEP_EVERY_MS = 60 * MINUTE;
const BACKOFF_MS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE];
const NOT_YET_LIVE = new Set(['waiting', 'uploading', 'processing', 'ready']);

export function createScheduler({ store, platforms, config, now = Date.now, log = console }) {
  const { tickMs, concurrency, missedGraceMs } = config.schedule;
  const videosDir = path.join(config.dataDir, 'videos');
  const inFlight = new Map();
  let timer = null;
  let lastSweep = -Infinity;

  // Only ever touches this server's record and file. Nothing here calls a platform, so what went live stays live.
  function sweepOldPosts() {
    for (const postId of store.expiredPostIds(now() - config.retention.postMs)) {
      const orphan = store.deletePost(postId);
      if (orphan) {
        for (const file of videoFiles(orphan)) rmSync(path.join(videosDir, file), { force: true });
      }
    }
  }

  const ctx = {
    now,
    videoPath: (target) => path.join(videosDir, target.file_name),
    coverPath: (target) => path.join(videosDir, coverFile(target.video_id)),
    coverUrl: (target) => `${config.baseUrl}/covers/${target.cover_token}.jpg`,
    saveAccessToken: (accountId, token, expiresAt) => store.saveAccessToken(accountId, token, expiresAt),
  };

  function fail(target, err) {
    // Going without the cover didn't help, so the cover wasn't the problem. A retry should send it again.
    const { skipCover, coverNote, ...kept } = target.stage;
    const stage = { ...(skipCover ? kept : target.stage), failedFrom: target.status, restart: Boolean(err.restart) };
    store.patchTarget(target.id, { status: 'failed', stage, error: err.message, next_run_at: null });
  }

  async function run(target) {
    const account = store.getAccount(target.account_id);

    if (NOT_YET_LIVE.has(target.status) && now() > target.publish_at + missedGraceMs) {
      store.patchTarget(target.id, {
        status: 'missed',
        stage: { ...target.stage, failedFrom: target.status },
        error: 'The publish time passed while the app was off or kept failing.',
        next_run_at: null,
      });
      return;
    }

    try {
      const patch = await platforms[target.platform].step(target, account, ctx);
      const changed = patch.status && patch.status !== target.status;
      store.patchTarget(target.id, { ...patch, error: null, attempts: changed ? 0 : target.attempts });
    } catch (err) {
      if (err instanceof AuthError) {
        store.markNeedsReconnect(account.id);
        fail(target, new PermanentError('Access to this account has expired. Reconnect it on the Accounts page, then retry.'));
      } else if (err instanceof PermanentError) {
        fail(target, err);
      } else if (target.attempts >= BACKOFF_MS.length) {
        fail(target, err);
      } else {
        store.patchTarget(target.id, {
          error: err.message,
          attempts: target.attempts + 1,
          next_run_at: now() + BACKOFF_MS[target.attempts],
        });
      }
      log.error(`[${target.platform}] ${target.id}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
    }
  }

  function tick() {
    if (now() - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = now();
      try {
        sweepOldPosts();
      } catch (err) {
        log.error(err);
      }
    }
    for (const target of store.dueTargets(now(), concurrency + inFlight.size)) {
      if (inFlight.size >= concurrency) break;
      if (inFlight.has(target.id)) continue;
      const job = run(target)
        .catch((err) => log.error(err))
        .finally(() => inFlight.delete(target.id));
      inFlight.set(target.id, job);
    }
    return Promise.all(inFlight.values());
  }

  return {
    tick,
    kick: () => setImmediate(tick),
    isBusy: (targetId) => inFlight.has(targetId),
    start() {
      timer = setInterval(tick, tickMs);
      tick();
    },
    async stop() {
      clearInterval(timer);
      await Promise.all(inFlight.values());
    },
    context: ctx,
  };
}
