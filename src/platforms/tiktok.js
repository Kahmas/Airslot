import { randomBytes } from 'node:crypto';
import { AuthError, classify, PermanentError, restartError, send } from './http.js';

const MINUTE = 60_000;
const FETCH_POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 30 * MINUTE;
const INBOX_POLL_MS = 10 * MINUTE;
// A draft nobody posts would otherwise keep its post on the schedule, and its video on this server, for good.
export const INBOX_WAIT_MS = 3 * 24 * 60 * MINUTE;
const RESENDS = 2;
export const TIKTOK_SCOPES = 'user.info.basic,video.upload';

// From the fail_reason list in TikTok's status documentation. The first two are the ones it calls retryable.
const RETRYABLE_FAILURES = new Set(['internal', 'video_pull_failed']);
const FAILURE_TEXT = {
  video_pull_failed: "TikTok couldn't fetch the video from this server",
  file_format_check_failed: "TikTok doesn't accept this file format",
  duration_check_failed: 'the video is too long or too short for this TikTok account',
  frame_rate_check_failed: 'the frame rate is outside 23 to 60 fps',
  picture_size_check_failed: 'the resolution is outside 360 to 4096 pixels',
  spam_risk_too_many_posts: 'this TikTok account has posted too much today. Post from the TikTok app instead',
  spam_risk_user_banned_from_posting: 'this TikTok account is not allowed to post right now',
};

const ERROR_TEXT = {
  spam_risk_too_many_pending_share: 'TikTok allows at most 5 drafts waiting in your inbox in 24 hours. Post the ones waiting in the Inbox tab of the TikTok app, then click Retry.',
  url_ownership_unverified: "TikTok hasn't verified this server's address yet. The admin has to verify the domain under URL properties in the TikTok app.",
  spam_risk_user_banned_from_posting: 'This TikTok account is not allowed to post right now.',
};

function tiktokError(response) {
  const error = classify(response);
  const code = response.data?.error?.code;
  if (!error.message) error.message = code ?? `HTTP ${response.status}`;
  const text = ERROR_TEXT[code];
  if (!text || error instanceof AuthError) return error;
  const friendly = new PermanentError(text);
  friendly.detail = error.detail;
  return friendly;
}

// TikTok's token endpoint reports errors as error and error_description, sometimes with a 200.
export async function requestToken(tiktok, fields) {
  const response = await send(`${tiktok.apiUrl}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: tiktok.clientKey ?? '', client_secret: tiktok.clientSecret ?? '', ...fields }),
  });
  if (response.status === 200 && response.data?.access_token) return response.data;
  const code = response.data?.error;
  const message = response.data?.error_description || (typeof code === 'string' ? code : null) || `HTTP ${response.status}`;
  if (code === 'invalid_grant') throw new AuthError(message);
  throw classify({ ...response, data: { error: typeof code === 'string' ? code : 'token_error', error_description: message } });
}

export async function tiktokCall(tiktok, path, token, { body, query } = {}) {
  const response = await send(`${tiktok.apiUrl}${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const code = response.data?.error?.code;
  if (response.status === 200 && (!code || code === 'ok')) return response.data?.data ?? {};
  throw tiktokError(response);
}

// TikTok only offers sending a draft to the creator's inbox to apps like this one. The creator finishes the post
// in the TikTok app, so this app sends it at the publish time and then watches for it to be posted.
export function createTikTok(config) {
  const { tiktok } = config;
  const refreshing = new Map();

  // Each refresh voids the refresh token it used. Two posts refreshing at once would lock the account out,
  // so they share one refresh, and each looks at the stored token first in case another just renewed it.
  async function accessToken(account, ctx) {
    const current = ctx.loadAccount?.(account.id) ?? account;
    if (current.token_expires_at && current.token_expires_at > ctx.now() + MINUTE) return current.token;
    if (!refreshing.has(account.id)) {
      const job = requestToken(tiktok, { grant_type: 'refresh_token', refresh_token: current.refresh_token ?? '' })
        .then((data) => {
          ctx.saveAccessToken(account.id, data.access_token, ctx.now() + data.expires_in * 1000, data.refresh_token);
          return data.access_token;
        })
        .finally(() => refreshing.delete(account.id));
      refreshing.set(account.id, job);
    }
    return refreshing.get(account.id);
  }

  const fetchStatus = (publishId, token) => tiktokCall(tiktok, '/v2/post/publish/status/fetch/', token, { body: { publish_id: publishId } });

  function afterFailure(reason, stage, now) {
    if (reason === 'auth_removed') throw new AuthError('Access to TikTok was removed.');
    const resends = stage.resends ?? 0;
    if (RETRYABLE_FAILURES.has(reason) && resends < RESENDS) {
      return { status: 'waiting', stage: { resends: resends + 1 }, next_run_at: now + MINUTE };
    }
    throw restartError(`TikTok didn't take the video: ${FAILURE_TEXT[reason] ?? reason ?? 'no reason given'}.`);
  }

  return {
    async step(target, account, ctx) {
      const now = ctx.now();
      const { stage } = target;

      switch (target.status) {
        case 'waiting': {
          if (now < target.publish_at) return { next_run_at: target.publish_at };
          // TikTok may fetch the video as soon as it hears of the link, so the link has to work before it is sent.
          if (!stage.mediaToken) return { stage: { ...stage, mediaToken: randomBytes(24).toString('base64url') }, next_run_at: now };
          const token = await accessToken(account, ctx);
          const data = await tiktokCall(tiktok, '/v2/post/publish/inbox/video/init/', token, {
            body: { source_info: { source: 'PULL_FROM_URL', video_url: ctx.mediaUrl(stage.mediaToken) } },
          });
          return { status: 'processing', stage: { ...stage, publishId: data.publish_id, sentAt: now }, next_run_at: now + FETCH_POLL_MS };
        }
        case 'processing':
        case 'handed_off': {
          const token = await accessToken(account, ctx);
          const { status, fail_reason: reason } = await fetchStatus(stage.publishId, token);
          if (status === 'PUBLISH_COMPLETE') return { status: 'published', next_run_at: null };
          if (status === 'FAILED') return afterFailure(reason, stage, now);
          if (status === 'SEND_TO_USER_INBOX') {
            const inboxAt = stage.inboxAt ?? now;
            if (now - inboxAt > INBOX_WAIT_MS) {
              throw restartError("The draft wasn't posted from your TikTok inbox within 3 days. Retry sends it again.");
            }
            return { status: 'handed_off', stage: { ...stage, inboxAt }, next_run_at: now + INBOX_POLL_MS };
          }
          if (now - stage.sentAt > FETCH_TIMEOUT_MS) throw restartError('TikTok took too long to fetch the video.');
          return { next_run_at: now + FETCH_POLL_MS };
        }
        default:
          return { next_run_at: null };
      }
    },

    // TikTok has no way to take a draft back out of someone's inbox, so canceling only stops the tracking here.
    async cancel() {},

    // Before it is sent, the new time and caption simply apply. After, the caption only changes what Copy caption gives.
    async edit(target, account, ctx) {
      return { next_run_at: ctx.now() };
    },
  };
}
