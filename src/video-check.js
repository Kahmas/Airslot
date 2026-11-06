import { execFile } from 'node:child_process';
import { open, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MB = 1024 * 1024;

function parseRate(rate) {
  const [num, den] = String(rate ?? '').split('/').map(Number);
  return num && den ? num / den : null;
}

// Phones often store portrait video as landscape pixels plus a rotation flag.
function rotationOf(stream) {
  const fromSideData = stream.side_data_list?.find((entry) => entry.rotation != null)?.rotation;
  return Math.abs(Number(fromSideData ?? stream.tags?.rotate ?? 0)) % 180 === 90;
}

async function moovBeforeMdat(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    let pos = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, 16, pos);
      if (bytesRead < 8) return null;
      const type = buf.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      let size = buf.readUInt32BE(0);
      if (size === 1) size = Number(buf.readBigUInt64BE(8));
      if (size < 8) return null;
      pos += size;
    }
  } finally {
    await handle.close();
  }
}

export async function probeVideo(filePath, config) {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const { format, streams } = JSON.parse(stdout);
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  if (!video) throw new Error('no video stream');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const rotated = rotationOf(video);
  const isMp4Family = format.format_name.includes('mp4');
  return {
    container: isMp4Family ? 'mp4' : format.format_name.split(',')[0],
    durationSec: Number(format.duration),
    sizeBytes: Number(format.size),
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    videoCodec: video.codec_name,
    fps: parseRate(video.avg_frame_rate),
    realFps: parseRate(video.r_frame_rate),
    audioCodec: audio?.codec_name ?? null,
    audioRate: audio ? Number(audio.sample_rate) : null,
    audioChannels: audio?.channels ?? null,
    moovFirst: isMp4Family ? await moovBeforeMdat(filePath) : null,
  };
}

// Instagram asks for the moov atom at the front. Remuxing moves it without re-encoding.
export async function moveMoovToFront(filePath, config) {
  const fixed = `${filePath}.faststart.mp4`;
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-i', filePath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', fixed]);
    await rename(fixed, filePath);
    return true;
  } catch {
    await rm(fixed, { force: true });
    return false;
  }
}

export async function makeThumbnail(filePath, thumbPath, config) {
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', '0.3', '-i', filePath, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', '4', thumbPath]);
    return true;
  } catch {
    return false;
  }
}

const formatSeconds = (seconds) => `${Math.round(seconds)} seconds`;
const formatMb = (bytes) => `${Math.round(bytes / MB)} MB`;
const isPortrait916 = (info) => Math.abs(info.width / info.height - 9 / 16) < 0.01;
const ratioLabel = (info) => `${info.width}x${info.height}`;

function checkInstagram(info) {
  const issues = [];
  if (info.container !== 'mp4') issues.push({ level: 'error', text: 'Instagram only accepts MP4 or MOV.' });
  if (!['h264', 'hevc'].includes(info.videoCodec)) issues.push({ level: 'error', text: `Video codec ${info.videoCodec} isn't supported. Use H.264 or HEVC.` });
  if (info.durationSec < 3) issues.push({ level: 'error', text: `Length of ${formatSeconds(info.durationSec)} is under the 3-second minimum.` });
  if (info.durationSec > 900) issues.push({ level: 'error', text: `Length of ${formatSeconds(info.durationSec)} is over Instagram's 15-minute limit.` });
  if (info.sizeBytes > 300 * MB) issues.push({ level: 'error', text: `File size of ${formatMb(info.sizeBytes)} is over Instagram's 300 MB limit.` });
  if (info.fps && (info.fps < 23 || info.fps > 60)) issues.push({ level: 'error', text: `Frame rate of ${info.fps.toFixed(1)} fps is outside the 23 to 60 fps range.` });
  if (info.audioCodec && info.audioCodec !== 'aac') issues.push({ level: 'error', text: `Audio codec ${info.audioCodec} isn't supported. Use AAC.` });
  if (info.audioRate && info.audioRate > 48000) issues.push({ level: 'error', text: 'Audio sample rate is above 48 kHz.' });
  if (info.audioChannels && info.audioChannels > 2) issues.push({ level: 'error', text: 'Audio must be mono or stereo.' });
  if (!isPortrait916(info)) issues.push({ level: 'warn', text: `${ratioLabel(info)} isn't 9:16, so it may be cropped in Reels.` });
  if (info.moovFirst === false) issues.push({ level: 'warn', text: "The file isn't optimized for Instagram and couldn't be fixed automatically." });
  return issues;
}

function checkFacebook(info) {
  const issues = [];
  if (!['h264', 'hevc', 'vp9', 'av1'].includes(info.videoCodec)) issues.push({ level: 'error', text: `Video codec ${info.videoCodec} isn't supported by Facebook Reels.` });
  if (info.durationSec < 3) issues.push({ level: 'error', text: `Length of ${formatSeconds(info.durationSec)} is under the 3-second minimum.` });
  if (info.durationSec > 90) issues.push({ level: 'error', text: `Length of ${formatSeconds(info.durationSec)} is over the Facebook Reels limit of 90 seconds.` });
  if (!isPortrait916(info)) issues.push({ level: 'error', text: `${ratioLabel(info)} isn't 9:16, which Facebook Reels requires.` });
  if (info.width < 540 || info.height < 960) issues.push({ level: 'error', text: `Resolution of ${ratioLabel(info)} is under the 540x960 minimum.` });
  if (info.fps && (info.fps < 24 || info.fps > 60)) issues.push({ level: 'error', text: `Frame rate of ${info.fps.toFixed(1)} fps is outside the 24 to 60 fps range.` });
  if (info.fps && info.realFps && Math.abs(info.fps - info.realFps) > 1) issues.push({ level: 'warn', text: 'Frame rate varies, and Facebook asks for a fixed frame rate.' });
  if (info.audioCodec && info.audioCodec !== 'aac') issues.push({ level: 'warn', text: `Facebook recommends AAC audio, this video uses ${info.audioCodec}.` });
  return issues;
}

function checkYouTube(info) {
  const issues = [];
  const squareOrTaller = info.height >= info.width;
  if (!squareOrTaller) issues.push({ level: 'warn', text: 'A horizontal video will be published as a regular video, not a Short.' });
  if (info.durationSec > 180) issues.push({ level: 'warn', text: `At ${formatSeconds(info.durationSec)} it runs over 3 minutes, so it will be a regular video, not a Short.` });
  return issues;
}

// From TikTok's media transfer guide. Some accounts may only post 3 or 5 minutes, which TikTok checks itself.
function checkTikTok(info) {
  const issues = [];
  if (!['mp4', 'matroska'].includes(info.container)) issues.push({ level: 'error', text: 'TikTok only accepts MP4, MOV, or WebM.' });
  if (!['h264', 'hevc', 'vp8', 'vp9'].includes(info.videoCodec)) issues.push({ level: 'error', text: `Video codec ${info.videoCodec} isn't supported. Use H.264.` });
  if (info.durationSec > 600) issues.push({ level: 'error', text: `Length of ${formatSeconds(info.durationSec)} is over TikTok's 10-minute limit.` });
  if (info.fps && (info.fps < 23 || info.fps > 60)) issues.push({ level: 'error', text: `Frame rate of ${info.fps.toFixed(1)} fps is outside the 23 to 60 fps range.` });
  if (Math.min(info.width, info.height) < 360 || Math.max(info.width, info.height) > 4096) {
    issues.push({ level: 'error', text: `Resolution of ${ratioLabel(info)} is outside TikTok's 360 to 4096 pixel range.` });
  }
  if (info.durationSec > 180) issues.push({ level: 'warn', text: 'Some TikTok accounts can only post up to 3 or 5 minutes.' });
  return issues;
}

export function checkVideo(info) {
  const result = { instagram: checkInstagram(info), facebook: checkFacebook(info), youtube: checkYouTube(info), tiktok: checkTikTok(info) };
  return Object.fromEntries(Object.entries(result).map(([platform, issues]) => [
    platform,
    { ok: !issues.some((issue) => issue.level === 'error'), issues },
  ]));
}

const HASHTAG = /(^|\s)#[^\s#]+/g;

// Returns a message when a platform would reject this text.
export function checkText(platform, { caption, title }) {
  if (platform === 'instagram') {
    if (caption.length > 2200) return `Instagram caption is ${caption.length} characters, the limit is 2,200.`;
    if ((caption.match(HASHTAG) ?? []).length > 30) return 'Instagram captions allow at most 30 hashtags.';
  }
  if (platform === 'youtube') {
    if (!title?.trim()) return 'YouTube title is required.';
    if (title.length > 100) return `YouTube title is ${title.length} characters, the limit is 100.`;
    if (/[<>]/.test(title)) return "YouTube titles can't contain < or >.";
    if (/[<>]/.test(caption)) return "YouTube descriptions can't contain < or >.";
    if (Buffer.byteLength(caption) > 5000) return 'YouTube description is too long, the limit is 5,000 bytes.';
  }
  return null;
}
