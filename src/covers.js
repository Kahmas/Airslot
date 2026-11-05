import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { HttpError } from './http-error.js';
import { storageLimitFor } from './limits.js';
import { coverFile } from './store.js';

const run = promisify(execFile);

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * MB;
// YouTube's lowest documented upload limit, so the same file suits every platform.
const MAX_COVER_BYTES = 2 * MB;
const MIN_LONG_SIDE = 640;
const FIT = "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease";
const TEMP_SUFFIX = '.upload';

const imageKind = (bytes) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg_pipe';
  if (bytes.subarray(0, 4).toString('latin1') === '\x89PNG') return 'png_pipe';
  return null;
};

async function encodeCover(inputArgs, outPath, config) {
  for (const quality of ['3', '6', '10']) {
    await run(config.ffmpeg, ['-y', '-v', 'error', ...inputArgs, '-frames:v', '1', '-vf', FIT, '-q:v', quality, '-f', 'image2', '-update', '1', outPath]);
    const { size } = await stat(outPath);
    if (size <= MAX_COVER_BYTES) return size;
  }
  throw new HttpError(422, 'This image is too detailed to fit the cover size. Try a simpler one.');
}

async function imageSize(filePath, demuxer, config) {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-f', demuxer, '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath]);
  const [stream] = JSON.parse(stdout).streams;
  return stream;
}

// A cover belongs to a video until it is scheduled. After that the platforms may already hold it.
export function registerCovers(app, { config, store, videosDir, sendOwnFile }) {
  const tempPath = () => path.join(videosDir, `${randomUUID()}${TEMP_SUFFIX}`);

  function loadUnscheduledVideo(req) {
    const video = store.getVideoFor(req.user.id, req.params.id);
    if (!video) throw new HttpError(404, 'Video not found.');
    if (store.videoHasPost(video.id)) throw new HttpError(409, "This video is already scheduled, so its cover can't change.");
    return video;
  }

  async function commit(req, res, video, encodedPath, size, offsetMs) {
    const limit = storageLimitFor(config, req.user);
    if (limit != null && store.usedBytes(req.user.id) - video.cover_size + size > limit) {
      await rm(encodedPath, { force: true });
      throw new HttpError(413, 'This cover would go over your storage limit. Remove finished posts from the schedule to free up space.');
    }
    await rename(encodedPath, path.join(videosDir, coverFile(video.id)));
    // Only an uploaded image needs a link, because Instagram fetches it. A frame is sent as a position in the video.
    store.setVideoCover(video.id, { size, offsetMs, token: offsetMs == null ? randomBytes(24).toString('base64url') : null });
    res.json({ cover: { url: `/api/videos/${video.id}/cover`, offsetMs, size } });
  }

  app.get('/api/videos/:id/cover', (req, res) => {
    const video = store.getVideoFor(req.user.id, req.params.id);
    if (!video?.has_cover) throw new HttpError(404, 'Cover not found.');
    sendOwnFile(res, coverFile(video.id));
  });

  app.post('/api/videos/:id/cover', express.json({ limit: '1kb' }), async (req, res) => {
    const video = loadUnscheduledVideo(req);
    const { atMs } = req.body ?? {};
    if (!Number.isFinite(atMs) || atMs < 0) throw new HttpError(422, 'That position in the video is not valid.');
    const position = Math.round(Math.min(atMs, Math.max(0, video.info.durationSec * 1000 - 100)));

    const encoded = tempPath();
    try {
      const inputArgs = ['-ss', (position / 1000).toFixed(3), '-i', path.join(videosDir, video.file_name)];
      const size = await encodeCover(inputArgs, encoded, config);
      await commit(req, res, video, encoded, size, position);
    } catch (err) {
      await rm(encoded, { force: true });
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, "That frame couldn't be read from the video. Try another position.");
    }
  });

  const readImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_IMAGE_BYTES });

  app.put('/api/videos/:id/cover', (req, res, next) => {
    readImage(req, res, (err) => next(err?.status === 413 ? new HttpError(413, 'Cover images can be at most 8 MB.') : err));
  }, async (req, res) => {
    const video = loadUnscheduledVideo(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Use a JPG or PNG image.');
    // The bytes decide the format, and ffmpeg is told to read only that, so a disguised file can't reach other readers.
    const demuxer = imageKind(req.body);
    if (!demuxer) throw new HttpError(415, 'Use a JPG or PNG image.');

    const original = tempPath();
    const encoded = tempPath();
    try {
      await writeFile(original, req.body);
      const { width, height } = await imageSize(original, demuxer, config);
      if (Math.max(width, height) < MIN_LONG_SIDE) throw new HttpError(422, `This image is ${width}x${height}. Use one at least ${MIN_LONG_SIDE} pixels on its long side.`);
      const size = await encodeCover(['-protocol_whitelist', 'file', '-f', demuxer, '-i', original], encoded, config);
      await commit(req, res, video, encoded, size, null);
    } catch (err) {
      await rm(encoded, { force: true });
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, "This image can't be read. Use a JPG or PNG.");
    } finally {
      await rm(original, { force: true });
    }
  });

  app.delete('/api/videos/:id/cover', async (req, res) => {
    const video = loadUnscheduledVideo(req);
    store.clearVideoCover(video.id);
    await rm(path.join(videosDir, coverFile(video.id)), { force: true });
    res.status(204).end();
  });

  // Instagram fetches an uploaded cover from a link without logging in. The link is long enough not to be
  // guessed, and stops working once no Instagram post needs it. no-store keeps Cloudflare from holding a copy.
  app.get('/covers/:file', (req, res) => {
    const token = req.params.file.match(/^([A-Za-z0-9_-]{32})\.jpg$/)?.[1];
    const video = token ? store.videoForOpenCoverLink(token) : null;
    if (!video) return res.status(404).type('text').send('Not found.');
    res.set('Cache-Control', 'no-store');
    res.sendFile(coverFile(video.id), { root: videosDir, cacheControl: false });
  });
}
