import { openAsBlob } from 'node:fs';
import { settleCover } from './cover.js';
import { createGraph, PermanentError, restartError, ruploadFile } from './http.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Facebook accepts scheduling only more than 10 minutes and at most 29 days ahead.
const MIN_SCHEDULE_AHEAD_MS = 11 * MINUTE;
const MAX_SCHEDULE_AHEAD_MS = 28 * DAY;
const CHECK_INTERVAL_MS = 5 * MINUTE;
const CONFIRM_DELAY_MS = 2 * MINUTE;
const CONFIRM_TIMEOUT_MS = 2 * 60 * MINUTE;

const finished = (phaseStatus) => phaseStatus === 'complete' || phaseStatus === 'completed';

export function createFacebook(config) {
  const graph = createGraph(config.meta);

  const videoStatus = async (id, token) => (await graph.get(`/${id}`, token, { fields: 'status' })).status ?? {};

  async function permalink(videoId, token) {
    try {
      const url = (await graph.get(`/${videoId}`, token, { fields: 'permalink_url' })).permalink_url;
      if (!url) return null;
      return url.startsWith('http') ? url : `https://www.facebook.com${url}`;
    } catch {
      return null; // The reel is live; a missing link must not turn that into a failure.
    }
  }

  function rejectionFrom(status) {
    const reason = status.processing_phase?.error?.message ?? status.publishing_phase?.error?.message;
    if (status.video_status === 'error' || status.video_status === 'upload_failed' || status.video_status === 'expired' || reason) {
      return `Facebook rejected the video: ${reason ?? status.video_status}`;
    }
    return null;
  }

  return {
    async step(target, account, ctx) {
      const now = ctx.now();
      const { stage } = target;
      const { token } = account;
      const untilAir = target.publish_at - now;

      switch (target.status) {
        case 'waiting': {
          if (untilAir > MAX_SCHEDULE_AHEAD_MS) return { next_run_at: target.publish_at - MAX_SCHEDULE_AHEAD_MS };
          const started = await graph.post(`/${account.remote_id}/video_reels`, token, { upload_phase: 'start' });
          return { status: 'uploading', stage: { videoId: started.video_id, uploadUrl: started.upload_url }, next_run_at: now };
        }
        case 'uploading': {
          const status = await videoStatus(stage.videoId, token);
          if (!finished(status.uploading_phase?.status)) {
            const offset = Number(status.uploading_phase?.bytes_transfered ?? 0);
            await ruploadFile(stage.uploadUrl, token, ctx.videoPath(target), offset);
          }
          return { status: 'ready', next_run_at: now };
        }
        case 'ready': {
          // Too close to air time to schedule: hold it here and publish at the exact moment.
          if (untilAir > 0 && untilAir < MIN_SCHEDULE_AHEAD_MS) return { next_run_at: target.publish_at };
          const status = await videoStatus(stage.videoId, token);
          const phase = status.publishing_phase?.publish_status;
          if (phase === 'scheduled' || phase === 'published') {
            return { status: 'handed_off', remote_id: stage.videoId, next_run_at: now };
          }
          const scheduled = untilAir >= MIN_SCHEDULE_AHEAD_MS;
          await graph.post(`/${account.remote_id}/video_reels`, token, {
            upload_phase: 'finish',
            video_id: stage.videoId,
            description: target.caption,
            video_state: scheduled ? 'SCHEDULED' : 'PUBLISHED',
            ...(scheduled ? { scheduled_publish_time: String(Math.floor(target.publish_at / 1000)) } : {}),
          });
          return { status: 'handed_off', remote_id: stage.videoId, next_run_at: now + (scheduled ? CHECK_INTERVAL_MS : MINUTE) };
        }
        case 'handed_off': {
          const status = await videoStatus(stage.videoId, token);
          const rejection = rejectionFrom(status);
          if (rejection) throw restartError(rejection);
          const processed = finished(status.processing_phase?.status);
          const live = status.publishing_phase?.publish_status === 'published';
          if (target.has_cover && !stage.coverDone && (processed || live)) {
            const settled = await settleCover(stage, 'Facebook', async () => {
              const form = new FormData();
              form.set('source', await openAsBlob(ctx.coverPath(target), { type: 'image/jpeg' }), 'cover.jpg');
              form.set('is_preferred', 'true');
              await graph.postForm(`/${stage.videoId}/thumbnails`, token, form);
            });
            return { stage: settled, next_run_at: settled.coverDone ? now : now + MINUTE };
          }
          const confirmAt = target.publish_at + CONFIRM_DELAY_MS;
          if (now < target.publish_at) {
            // Catch a processing rejection early rather than discovering it at air time.
            return { next_run_at: processed ? confirmAt : Math.min(confirmAt, now + CHECK_INTERVAL_MS) };
          }
          if (live) {
            return { status: 'published', remote_url: await permalink(stage.videoId, token), next_run_at: null };
          }
          if (now > target.publish_at + CONFIRM_TIMEOUT_MS) {
            throw new PermanentError("The reel still isn't live on Facebook after 2 hours. Check Meta Business Suite.");
          }
          return { next_run_at: now + MINUTE };
        }
        default:
          return { next_run_at: null };
      }
    },

    async cancel(target, account) {
      if (target.stage.videoId) await graph.del(`/${target.stage.videoId}`, account.token);
    },

    // Until the finish call, Facebook has only the file, which keeps. After it, the reel is scheduled
    // with the old caption and time, so it is deleted there and sent again.
    async edit(target, account, ctx) {
      if (target.status !== 'handed_off') return { next_run_at: ctx.now() };
      await this.cancel(target, account);
      return { status: 'waiting', stage: {}, remote_id: null, next_run_at: ctx.now() };
    },
  };
}
