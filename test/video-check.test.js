import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkText, checkVideo, probeVideo } from '../src/video-check.js';
import { sampleVideo } from './helpers.js';

const tools = { ffprobe: 'ffprobe', ffmpeg: 'ffmpeg' };
const good = {
  container: 'mp4',
  durationSec: 30,
  sizeBytes: 20 * 1048576,
  width: 1080,
  height: 1920,
  videoCodec: 'h264',
  fps: 30,
  realFps: 30,
  audioCodec: 'aac',
  audioRate: 48000,
  audioChannels: 2,
  moovFirst: true,
};

test('a standard 9:16 clip passes everywhere without notes', () => {
  const checks = checkVideo(good);
  for (const platform of ['instagram', 'facebook', 'youtube']) {
    assert.equal(checks[platform].ok, true, platform);
    assert.deepEqual(checks[platform].issues, [], platform);
  }
});

test('over 90 seconds blocks Facebook only', () => {
  const checks = checkVideo({ ...good, durationSec: 120 });
  assert.equal(checks.facebook.ok, false);
  assert.match(checks.facebook.issues[0].text, /90 seconds/);
  assert.equal(checks.instagram.ok, true);
  assert.equal(checks.youtube.ok, true);
});

test('over 300 MB blocks Instagram only', () => {
  const checks = checkVideo({ ...good, sizeBytes: 301 * 1048576 });
  assert.equal(checks.instagram.ok, false);
  assert.equal(checks.facebook.ok, true);
});

test('landscape blocks Facebook, warns on Instagram and YouTube', () => {
  const checks = checkVideo({ ...good, width: 1920, height: 1080 });
  assert.equal(checks.facebook.ok, false);
  assert.equal(checks.instagram.ok, true);
  assert.equal(checks.instagram.issues[0].level, 'warn');
  assert.match(checks.youtube.issues[0].text, /not a Short/);
});

test('a clip over 3 minutes warns it will not become a Short', () => {
  const checks = checkVideo({ ...good, durationSec: 200 });
  assert.equal(checks.youtube.ok, true);
  assert.match(checks.youtube.issues[0].text, /not a Short/);
});

test('probe reads a real encoded file', async () => {
  const info = await probeVideo(sampleVideo(), tools);
  assert.equal(info.container, 'mp4');
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.equal(Math.round(info.fps), 30);
  assert.equal(info.moovFirst, true);
});

test('probe detects moov after mdat', async () => {
  const info = await probeVideo(sampleVideo({ faststart: false }), tools);
  assert.equal(info.moovFirst, false);
});

test('text rules match what each platform rejects', () => {
  assert.match(checkText('instagram', { caption: 'x'.repeat(2201) }), /2,200/);
  assert.match(checkText('instagram', { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') }), /30 hashtags/);
  assert.equal(checkText('instagram', { caption: 'halo #satu' }), null);
  assert.match(checkText('youtube', { caption: '', title: '  ' }), /required/);
  assert.match(checkText('youtube', { caption: '', title: 'x'.repeat(101) }), /100/);
  assert.match(checkText('youtube', { caption: '', title: 'a < b' }), /< or >/);
  assert.match(checkText('youtube', { caption: 'a > b', title: 'ok' }), /< or >/);
  assert.equal(checkText('youtube', { caption: 'halo', title: 'ok' }), null);
  assert.equal(checkText('facebook', { caption: 'x'.repeat(9000) }), null);
});
