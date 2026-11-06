import { openAsBlob } from 'node:fs';
import { settleCover } from './cover.js';
import { call, classify, openVideo, PermanentError, restartError, send, UPLOAD_TIMEOUT_MS } from './http.js';

const MINUTE = 60_000;
const CHECK_INTERVAL_MS = 5 * MINUTE;
const CONFIRM_DELAY_MS = MINUTE;
const LOCKED_AFTER_MS = 30 * MINUTE;
const PEOPLE_AND_BLOGS = '22';

export function createYouTube(config) {
  const { apiUrl, uploadUrl, tokenUrl, clientId, clientSecret } = config.google;

  async function accessToken(account, ctx) {
    if (account.token_expires_at && account.token_expires_at > ctx.now() + MINUTE) return account.token;
    const data = await call(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token ?? '',
        client_id: clientId ?? '',
        client_secret: clientSecret ?? '',
      }),
    });
    ctx.saveAccessToken(account.id, data.access_token, ctx.now() + data.expires_in * 1000);
    return data.access_token;
  }

  function handedOff(video, target, now) {
    return {
      status: 'handed_off',
      remote_id: video.id,
      remote_url: `https://youtu.be/${video.id}`,
      // Publishing right away means the answer is close, so there is no reason to wait for the usual check.
      next_run_at: now + (target.publish_at <= now ? MINUTE : CHECK_INTERVAL_MS),
    };
  }

  return {
    async step(target, account, ctx) {
      const now = ctx.now();
      const { stage } = target;
      const headers = { Authorization: `Bearer ${await accessToken(account, ctx)}` };

      switch (target.status) {
        case 'waiting': {
          const startAt = target.publish_at - config.schedule.ytLeadMs;
          if (now < startAt) return { next_run_at: startAt };
          const blob = await openVideo(ctx.videoPath(target));
          const response = await send(`${uploadUrl}/videos?uploadType=resumable&part=snippet,status`, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': String(blob.size),
              'X-Upload-Content-Type': 'video/*',
            },
            body: JSON.stringify({
              snippet: { title: target.title, description: target.caption, categoryId: PEOPLE_AND_BLOGS },
              // publishAt requires a private video; YouTube flips it to public at that time.
              // When that time has already come, there is nothing to wait for.
              status: {
                ...(target.publish_at > now
                  ? { privacyStatus: 'private', publishAt: new Date(target.publish_at).toISOString() }
                  : { privacyStatus: 'public' }),
                selfDeclaredMadeForKids: Boolean(target.made_for_kids),
              },
            }),
          });
          if (response.status !== 200 && response.status !== 201) throw classify(response);
          return { status: 'uploading', stage: { sessionUrl: response.headers.get('location') }, next_run_at: now };
        }
        case 'uploading': {
          const blob = await openVideo(ctx.videoPath(target));
          // Ask how far any earlier attempt got, so a retry can never create a second video.
          const progress = await send(stage.sessionUrl, {
            method: 'PUT',
            headers: { ...headers, 'Content-Range': `bytes */${blob.size}` },
          });
          if (progress.status === 200 || progress.status === 201) return handedOff(progress.data, target, now);
          if (progress.status === 404 || progress.status === 410) return { status: 'waiting', stage: {}, next_run_at: now };
          if (progress.status !== 308) throw classify(progress);
          const range = progress.headers.get('range');
          const offset = range ? Number(range.split('-')[1]) + 1 : 0;

          const upload = await send(stage.sessionUrl, {
            method: 'PUT',
            timeoutMs: UPLOAD_TIMEOUT_MS,
            headers: { ...headers, 'Content-Range': `bytes ${offset}-${blob.size - 1}/${blob.size}` },
            body: blob.slice(offset),
          });
          if (upload.status === 200 || upload.status === 201) return handedOff(upload.data, target, now);
          if (upload.status === 308) return { next_run_at: now }; // Partial: resume on the next tick.
          throw classify(upload);
        }
        case 'handed_off': {
          const data = await call(`${apiUrl}/videos?part=status&id=${target.remote_id}`, { headers });
          const video = data.items?.[0];
          if (!video) throw new PermanentError("The video wasn't found on YouTube. It may have been deleted in YouTube Studio.");
          const { uploadStatus, privacyStatus, failureReason, rejectionReason } = video.status;
          if (uploadStatus === 'failed' || uploadStatus === 'rejected') {
            throw restartError(`YouTube rejected the video (${failureReason ?? rejectionReason ?? uploadStatus}).`);
          }
          if (target.has_cover && !stage.coverDone && (uploadStatus === 'processed' || privacyStatus === 'public')) {
            const settled = await settleCover(stage, 'YouTube', async () => {
              const response = await send(`${uploadUrl}/thumbnails/set?uploadType=media&videoId=${target.remote_id}`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'image/jpeg' },
                body: await openAsBlob(ctx.coverPath(target), { type: 'image/jpeg' }),
              });
              if (response.status !== 200) throw classify(response);
            });
            return { stage: settled, next_run_at: settled.coverDone ? now : now + MINUTE };
          }
          const confirmAt = target.publish_at + CONFIRM_DELAY_MS;
          if (now < target.publish_at) {
            return { next_run_at: uploadStatus === 'processed' ? confirmAt : Math.min(confirmAt, now + CHECK_INTERVAL_MS) };
          }
          if (privacyStatus === 'public') return { status: 'published', next_run_at: null };
          if (now > target.publish_at + LOCKED_AFTER_MS) {
            throw new PermanentError('YouTube is still holding the video as private after the publish time. The API project may need an audit, see the YouTube section of the README.');
          }
          return { next_run_at: now + MINUTE };
        }
        default:
          return { next_run_at: null };
      }
    },

    async cancel(target, account, ctx) {
      if (!target.remote_id) return;
      const headers = { Authorization: `Bearer ${await accessToken(account, ctx)}` };
      const response = await send(`${apiUrl}/videos?id=${target.remote_id}`, { method: 'DELETE', headers });
      if (response.status !== 204 && response.status !== 404) throw classify(response);
    },
  };
}
