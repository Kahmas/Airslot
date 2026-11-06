import { AuthError, createGraph, PermanentError, restartError, ruploadFile } from './http.js';

const POLL_MS = 60_000;
const PROCESSING_TIMEOUT_MS = 20 * 60_000;
const COVER_REFUSED = "Instagram didn't accept the cover, so it picked its own.";
const ALREADY_UPLOADED = /not in the status to upload/i;

// A frame needs only its position. An uploaded image has to be fetched by Instagram from a link.
function coverParams(target, stage, ctx) {
  if (!target.has_cover || stage.skipCover) return {};
  if (target.cover_offset_ms != null) return { thumb_offset: String(target.cover_offset_ms) };
  return { cover_url: ctx.coverUrl(target) };
}

// What has to survive when a container is made again.
const coverOutcome = ({ skipCover, coverNote, freshContainer }) => ({
  ...(skipCover ? { skipCover, coverNote } : {}),
  ...(freshContainer ? { freshContainer } : {}),
});

// The Instagram API can only publish immediately, so this app holds the schedule:
// prepare the container shortly before air time, then publish it at air time.
export function createInstagram(config) {
  const graph = createGraph(config.meta);
  const { ruploadUrl, version } = config.meta;

  const containerStatus = (id, token) => graph.get(`/${id}`, token, { fields: 'status_code,status' });

  async function permalink(mediaId, token) {
    try {
      return (await graph.get(`/${mediaId}`, token, { fields: 'permalink' })).permalink ?? null;
    } catch {
      return null; // The post is live; a missing link must not turn that into a failure.
    }
  }

  return {
    async step(target, account, ctx) {
      const now = ctx.now();
      const { stage } = target;
      const { token } = account;

      switch (target.status) {
        case 'waiting': {
          const startAt = target.publish_at - config.schedule.igLeadMs;
          if (now < startAt) return { next_run_at: startAt };
          const cover = coverParams(target, stage, ctx);
          let container;
          try {
            container = await graph.post(`/${account.remote_id}/media`, token, {
              media_type: 'REELS',
              upload_type: 'resumable',
              caption: target.caption,
              share_to_feed: 'true',
              ...cover,
            });
          } catch (err) {
            // A refused cover must not cost the post, so it goes again without one.
            if (Object.keys(cover).length > 0 && err instanceof PermanentError && !(err instanceof AuthError)) {
              return { stage: { skipCover: true, coverNote: `${COVER_REFUSED} ${err.message}` }, next_run_at: now };
            }
            throw err;
          }
          return { status: 'uploading', stage: { ...coverOutcome(stage), containerId: container.id }, next_run_at: now };
        }
        case 'uploading': {
          try {
            await ruploadFile(`${ruploadUrl}/ig-api-upload/${version}/${stage.containerId}`, token, ctx.videoPath(target));
          } catch (err) {
            // Seen live: the first upload answered "Request processing failed" yet the video had arrived, so the
            // retry was told the container no longer takes uploads. Processing then shows whether it worked.
            if (!ALREADY_UPLOADED.test(err.message)) throw err;
            return { status: 'processing', stage: { ...stage, uploadedAt: now, uploadUnsure: true }, next_run_at: now };
          }
          return { status: 'processing', stage: { ...stage, uploadedAt: now }, next_run_at: now + POLL_MS };
        }
        case 'processing': {
          const container = await containerStatus(stage.containerId, token);
          if (container.status_code === 'FINISHED') return { status: 'ready', next_run_at: Math.max(now, target.publish_at) };
          if (container.status_code === 'EXPIRED') return { status: 'waiting', stage: coverOutcome(stage), next_run_at: now };
          // After an upload we couldn't confirm, a broken or stuck container gets one fresh start before anything fails.
          const stuck = now - stage.uploadedAt > PROCESSING_TIMEOUT_MS;
          if (stage.uploadUnsure && !stage.freshContainer && (container.status_code === 'ERROR' || stuck)) {
            return { status: 'waiting', stage: { ...coverOutcome(stage), freshContainer: true }, next_run_at: now };
          }
          if (container.status_code === 'ERROR') {
            // Instagram doesn't say which part it refused, so a post with a cover gets one try without it.
            if (target.has_cover && !stage.skipCover) {
              return { status: 'waiting', stage: { skipCover: true, coverNote: `${COVER_REFUSED} ${container.status}` }, next_run_at: now };
            }
            throw restartError(`Instagram rejected the video: ${container.status}`);
          }
          if (now - stage.uploadedAt > PROCESSING_TIMEOUT_MS) throw restartError('Instagram took too long to process the video.');
          return { next_run_at: now + POLL_MS };
        }
        case 'ready': {
          if (now < target.publish_at) return { next_run_at: target.publish_at };
          const container = await containerStatus(stage.containerId, token);
          if (container.status_code === 'EXPIRED') return { status: 'waiting', stage: coverOutcome(stage), next_run_at: now };
          // An earlier publish call may have succeeded even though its response was lost.
          if (container.status_code === 'PUBLISHED') return { status: 'published', next_run_at: null };
          const { id } = await graph.post(`/${account.remote_id}/media_publish`, token, { creation_id: stage.containerId });
          return { status: 'published', remote_id: id, remote_url: await permalink(id, token), next_run_at: null };
        }
        default:
          return { next_run_at: null };
      }
    },

    // Nothing to undo remotely: an unpublished container simply expires after 24 hours.
    async cancel() {},
  };
}
