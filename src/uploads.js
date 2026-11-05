import { randomUUID } from 'node:crypto';
import { createWriteStream, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { HttpError } from './http-error.js';
import { storageLimitFor } from './limits.js';
import { checkVideo, makeThumbnail, moveMoovToFront, probeVideo } from './video-check.js';

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const TEMP_SUFFIX = '.upload';
const IDLE_LIMIT_MS = 60 * 60_000;
const UNUSED_VIDEO_MS = 24 * 3_600_000;

// Uploads can't resume across a restart, so anything left behind is dead weight.
export function clearAbandonedUploads(videosDir) {
  for (const name of readdirSync(videosDir)) {
    if (name.endsWith(TEMP_SUFFIX)) rmSync(path.join(videosDir, name), { force: true });
  }
}

function videoView(video) {
  return {
    id: video.id,
    originalName: video.original_name,
    size: video.size,
    info: video.info,
    fileUrl: `/api/videos/${video.id}/file`,
    thumbUrl: video.has_thumb ? `/api/videos/${video.id}/thumb` : null,
  };
}

const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function registerUploads(app, { config, store, videosDir, now, removeVideoFiles }) {
  const sessions = new Map();
  const { chunkBytes } = config.upload;
  const tooLarge = `The file is larger than the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`;

  function discard(session) {
    sessions.delete(session.id);
    rmSync(session.path, { force: true });
  }

  // Someone else's upload answers the same as one that doesn't exist.
  function loadSession(id, userId) {
    const session = sessions.get(id);
    if (session?.userId !== userId) throw new HttpError(404, 'This upload is no longer available. Start it again.');
    return session;
  }

  // Uploads in progress count too, so several at once can't slip past the limit.
  function bytesLeft(user, limit) {
    let reserved = store.usedBytes(user.id);
    for (const session of sessions.values()) {
      if (session.userId === user.id) reserved += session.size;
    }
    return limit - reserved;
  }

  app.post('/api/uploads', express.json({ limit: '16kb' }), (req, res) => {
    for (const session of sessions.values()) {
      if (!session.busy && now() - session.touchedAt > IDLE_LIMIT_MS) discard(session);
    }
    for (const video of store.removeUnusedVideos(req.user.id, now() - UNUSED_VIDEO_MS)) removeVideoFiles(video);

    const { fileName, size } = req.body ?? {};
    const originalName = String(fileName ?? 'video').slice(0, 200);
    const extension = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new HttpError(415, 'Unsupported file type. Use MP4 or MOV.');
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'The file size is not valid.');
    if (size === 0) throw new HttpError(400, 'The file is empty.');
    if (size > config.maxUploadBytes) throw new HttpError(413, tooLarge);
    const limit = storageLimitFor(config, req.user);
    if (limit != null) {
      const left = Math.max(0, bytesLeft(req.user, limit));
      if (size > left) {
        throw new HttpError(413, `This video is ${gigabytes(size)}, and you have ${gigabytes(left)} of storage left. Remove finished posts from the schedule to free up space.`);
      }
    }

    const id = randomUUID();
    const session = {
      id,
      userId: req.user.id,
      originalName,
      extension,
      size,
      received: 0,
      path: path.join(videosDir, `${id}${extension}${TEMP_SUFFIX}`),
      busy: false,
      canceled: false,
      touchedAt: now(),
    };
    writeFileSync(session.path, '');
    sessions.set(id, session);
    res.status(201).json({ id, chunkBytes });
  });

  app.put('/api/uploads/:id/chunk', async (req, res) => {
    // Reply before reading the body only after draining it, so the client sees the answer, not a reset.
    const refuse = (status, body) => {
      req.resume();
      res.status(status).json(body);
    };

    let session;
    try {
      session = loadSession(req.params.id, req.user.id);
    } catch (err) {
      return refuse(err.status, { error: err.message });
    }

    const offset = Number(req.headers['x-upload-offset']);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (session.busy) return refuse(409, { error: 'An earlier piece is still being saved.', received: session.received });
    // An offset at or before what is saved is a safe retry of a piece whose response was lost.
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.received) {
      return refuse(409, { error: 'This piece is out of order.', received: session.received });
    }
    if (declared > chunkBytes) return refuse(413, { error: 'This piece is larger than allowed.' });
    if (offset + declared > session.size) return refuse(413, { error: 'The upload is larger than the file size it declared.' });

    session.busy = true;
    let written = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        written += chunk.length;
        const overflow = written > chunkBytes || offset + written > session.size;
        done(overflow ? new HttpError(413, 'The upload is larger than the file size it declared.') : null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(session.path, { flags: 'r+', start: offset }));
      session.received = Math.max(session.received, offset + written);
      session.touchedAt = now();
      res.json({ received: session.received });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err.code === 'ENOSPC') throw new HttpError(507, 'The server is out of disk space.');
      throw new HttpError(400, 'The upload was interrupted. Try again.');
    } finally {
      session.busy = false;
      if (session.canceled) discard(session);
    }
  });

  app.post('/api/uploads/:id/complete', async (req, res) => {
    const session = loadSession(req.params.id, req.user.id);
    if (session.busy || session.received !== session.size) {
      return res.status(409).json({ error: 'The upload is not finished yet.', received: session.received });
    }

    sessions.delete(session.id);
    const fileName = `${session.id}${session.extension}`;
    const filePath = path.join(videosDir, fileName);
    truncateSync(session.path, session.size);
    renameSync(session.path, filePath);

    let info;
    try {
      info = await probeVideo(filePath, config);
      if (info.moovFirst === false && await moveMoovToFront(filePath, config)) info = await probeVideo(filePath, config);
    } catch (err) {
      rmSync(filePath, { force: true });
      if (err.code === 'ENOENT') throw new HttpError(500, 'ffprobe was not found on this machine. Install FFmpeg first.');
      throw new HttpError(422, "This file can't be read as a video.");
    }

    const hasThumb = await makeThumbnail(filePath, path.join(videosDir, `${session.id}.jpg`), config);
    store.insertVideo({
      id: session.id,
      userId: req.user.id,
      file_name: fileName,
      original_name: session.originalName,
      size: statSync(filePath).size,
      info,
      has_thumb: hasThumb,
    });
    res.status(201).json({ video: videoView(store.getVideoFor(req.user.id, session.id)), checks: checkVideo(info) });
  });

  app.delete('/api/uploads/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session?.userId === req.user.id) {
      if (session.busy) session.canceled = true;
      else discard(session);
    }
    res.status(204).end();
  });
}
