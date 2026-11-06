import { randomUUID } from 'node:crypto';
import http from 'node:http';

// A stand-in for the Meta and YouTube APIs, written from their documented request formats.
// It proves this app speaks that format; it cannot prove the real services still behave this way.
export async function startMockPlatforms({ now = Date.now, processingPolls = 1 } = {}) {
  const state = {
    containers: new Map(),
    published: [],
    reels: new Map(),
    videos: new Map(),
    sessions: new Map(),
    deleted: [],
    requests: [],
    tokens: new Set(['ig-page-token', 'fb-page-token', 'yt-access-token']),
    lockYouTubePrivate: false,
    thumbnails: [],
    rejectCovers: false,
  };
  const failures = [];

  // Queue a one-off failure for the next request whose "METHOD path" contains `match`.
  // With lostResponse the request takes effect but the caller only sees the failure.
  function failNext(match, status, body, { bodyIncludes = null, lostResponse = false } = {}) {
    failures.push({ match, status, body, bodyIncludes, lostResponse });
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  const metaAuthError = { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } };

  function hasToken(req) {
    const token = (req.headers.authorization ?? '').split(' ')[1];
    return state.tokens.has(token);
  }

  function handleGraph(req, res, url, body, segments) {
    const [id, edge] = segments;
    const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(body.toString());

    if (id === 'oauth') {
      if (url.searchParams.get('grant_type') === 'fb_exchange_token') return send(res, 200, { access_token: 'long-lived-user', expires_in: 5183944 });
      return send(res, 200, { access_token: 'short-lived-user', expires_in: 3600 });
    }
    if (id === 'debug_token') {
      if (req.headers.authorization !== 'Bearer test-app|test-secret') return send(res, 401, metaAuthError);
      return send(res, 200, { data: { is_valid: true, granular_scopes: state.grantedScopes ?? [] } });
    }
    if (state.businessPages?.[id]) return send(res, 200, state.businessPages[id]);
    if (id === 'me' && edge === 'accounts') {
      if (state.emptyMeAccounts) return send(res, 200, { data: [] });
      return send(res, 200, {
        data: [{
          id: 'page-1',
          name: 'Page Uji',
          access_token: 'fb-page-token',
          instagram_business_account: { id: 'ig-1', username: 'akun_uji' },
        }],
      });
    }
    if (!hasToken(req)) return send(res, 401, metaAuthError);

    if (edge === 'media' && req.method === 'POST') {
      if (params.get('media_type') !== 'REELS' || params.get('upload_type') !== 'resumable') {
        return send(res, 400, { error: { message: 'media_type and upload_type are required', code: 100 } });
      }
      const containerId = `container-${randomUUID()}`;
      state.containers.set(containerId, {
        ig: id,
        caption: params.get('caption'),
        coverUrl: params.get('cover_url'),
        thumbOffset: params.get('thumb_offset'),
        bytes: 0,
        polls: 0,
        status: 'WAITING_UPLOAD',
      });
      return send(res, 200, { id: containerId });
    }
    if (edge === 'thumbnails' && req.method === 'POST') {
      const form = body.toString('latin1');
      if (!state.reels.has(id)) return send(res, 400, { error: { message: 'Thumbnails need a video on a Page', code: 100 } });
      if (!form.includes('name="source"')) return send(res, 400, { error: { message: 'source is required', code: 100 } });
      state.thumbnails.push({
        platform: 'facebook',
        videoId: id,
        preferred: /name="is_preferred"\r\n\r\ntrue/.test(form),
        jpeg: form.includes('\xff\xd8\xff'),
      });
      return send(res, 200, { success: true });
    }
    if (edge === 'media_publish') {
      const container = state.containers.get(params.get('creation_id'));
      if (!container || container.status !== 'FINISHED') return send(res, 400, { error: { message: 'Media ID is not available', code: 9007 } });
      container.status = 'PUBLISHED';
      const mediaId = `ig-media-${state.published.length + 1}`;
      state.published.push({ platform: 'instagram', id: mediaId, caption: container.caption, at: now() });
      return send(res, 200, { id: mediaId });
    }
    if (edge === 'video_reels' && req.method === 'POST') {
      const phase = params.get('upload_phase');
      if (phase === 'start') {
        const videoId = `reel-${randomUUID()}`;
        state.reels.set(videoId, { page: id, bytes: 0, state: 'new' });
        return send(res, 200, { video_id: videoId, upload_url: `${mock.url}/video-upload/v26.0/${videoId}` });
      }
      if (phase === 'finish') {
        const reel = state.reels.get(params.get('video_id'));
        if (!reel || !reel.bytes) return send(res, 400, { error: { message: 'Video not uploaded', code: 100 } });
        const videoState = params.get('video_state');
        if (videoState === 'SCHEDULED') {
          const seconds = Number(params.get('scheduled_publish_time'));
          const ahead = seconds * 1000 - now();
          if (ahead < 10 * 60_000 || ahead > 29 * 24 * 3_600_000) {
            return send(res, 400, { error: { message: 'Invalid scheduled_publish_time', code: 100 } });
          }
          reel.scheduledFor = seconds * 1000;
          reel.state = 'scheduled';
        } else {
          reel.scheduledFor = now();
          reel.state = 'scheduled';
        }
        reel.finishCalls = (reel.finishCalls ?? 0) + 1;
        reel.videoState = videoState;
        reel.description = params.get('description');
        return send(res, 200, { success: true });
      }
    }

    if (req.method === 'DELETE') {
      state.deleted.push(id);
      state.reels.delete(id);
      return send(res, 200, { success: true });
    }
    if (req.method === 'GET') {
      const fields = url.searchParams.get('fields') ?? '';
      if (state.containers.has(id)) {
        const container = state.containers.get(id);
        if (container.status === 'IN_PROGRESS' && ++container.polls >= processingPolls) container.status = 'FINISHED';
        return send(res, 200, { status_code: container.status, status: container.status });
      }
      if (state.reels.has(id)) {
        const reel = state.reels.get(id);
        const live = reel.state === 'scheduled' && now() >= reel.scheduledFor;
        if (fields.includes('permalink_url')) return send(res, 200, { permalink_url: `/reel/${id}` });
        return send(res, 200, {
          id,
          status: {
            video_status: reel.bytes ? 'ready' : 'uploading',
            uploading_phase: { status: reel.bytes ? 'complete' : 'not_started', bytes_transfered: reel.bytes },
            processing_phase: { status: reel.bytes ? 'complete' : 'not_started' },
            publishing_phase: {
              status: live ? 'complete' : 'not_started',
              publish_status: live ? 'published' : reel.state === 'scheduled' ? 'scheduled' : 'draft',
            },
          },
        });
      }
      if (id.startsWith('ig-media-')) return send(res, 200, { permalink: `https://www.instagram.com/reel/${id}/` });
    }
    send(res, 404, { error: { message: `Unknown route ${req.method} ${id}/${edge}`, code: 803 } });
  }

  function handleRupload(req, res, kind, id, body) {
    if (!req.headers.authorization?.startsWith('OAuth ')) return send(res, 401, metaAuthError);
    if (!hasToken(req)) return send(res, 401, metaAuthError);
    const fileSize = Number(req.headers.file_size);
    const offset = Number(req.headers.offset);
    if (!Number.isFinite(fileSize) || !Number.isFinite(offset)) {
      return send(res, 400, { debug_info: { retriable: false, message: 'offset and file_size headers are required' } });
    }
    if (offset + body.length !== fileSize) {
      return send(res, 400, { debug_info: { retriable: true, message: `Partial upload: ${offset + body.length}/${fileSize}` } });
    }
    if (kind === 'ig-api-upload') {
      const container = state.containers.get(id);
      if (!container) return send(res, 404, { debug_info: { message: 'Unknown container' } });
      // What Instagram answered live when a second upload reached a container that already had one.
      if (container.status !== 'WAITING_UPLOAD') {
        return send(res, 400, {
          debug_info: {
            retriable: false,
            type: 'ProcessingFailedError',
            message: JSON.stringify({ success: false, error: { message: 'The ig container is not in the status to upload a video' } }),
          },
        });
      }
      container.bytes = fileSize;
      container.status = state.rejectCovers && (container.coverUrl || container.thumbOffset) ? 'ERROR' : 'IN_PROGRESS';
      return send(res, 200, { success: true, message: 'Upload successful.' });
    }
    const reel = state.reels.get(id);
    if (!reel) return send(res, 404, { debug_info: { message: 'Unknown video' } });
    reel.bytes = fileSize;
    send(res, 200, { success: true });
  }

  function youTubeVideo(id) {
    const video = state.videos.get(id);
    const due = video.privacy === 'public' || now() >= video.publishAt;
    const live = due && !state.lockYouTubePrivate;
    return {
      id,
      status: {
        uploadStatus: 'processed',
        privacyStatus: live ? 'public' : 'private',
        ...(video.publishAt ? { publishAt: new Date(video.publishAt).toISOString() } : {}),
        selfDeclaredMadeForKids: video.madeForKids,
      },
    };
  }

  const ytAuthError = { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } };

  function handleYouTube(req, res, url, body, pathname) {
    if (pathname === '/token') {
      const params = new URLSearchParams(body.toString());
      if (params.get('grant_type') === 'refresh_token') {
        if (params.get('refresh_token') === 'revoked') return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return send(res, 200, { access_token: 'yt-access-token', expires_in: 3600 });
      }
      return send(res, 200, { access_token: 'yt-access-token', refresh_token: 'yt-refresh-token', expires_in: 3600 });
    }
    if (!hasToken(req)) return send(res, 401, ytAuthError);

    if (pathname === '/youtube/v3/channels') {
      return send(res, 200, { items: [state.youtubeChannel ?? { id: 'channel-1', snippet: { title: 'Kanal Uji' } }] });
    }
    if (pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
      if (url.searchParams.get('uploadType') !== 'resumable') return send(res, 400, { error: { code: 400, message: 'uploadType must be resumable' } });
      const meta = JSON.parse(body.toString());
      if (meta.status.publishAt && meta.status.privacyStatus !== 'private') {
        return send(res, 400, { error: { code: 400, message: 'publishAt requires private', errors: [{ reason: 'invalidPublishAt' }] } });
      }
      if (!meta.snippet.title) return send(res, 400, { error: { code: 400, message: 'title required', errors: [{ reason: 'invalidTitle' }] } });
      const sessionId = randomUUID();
      state.sessions.set(sessionId, { meta, total: Number(req.headers['x-upload-content-length']), received: 0, videoId: null });
      return send(res, 200, undefined, { Location: `${mock.url}/upload/session/${sessionId}` });
    }
    if (pathname.startsWith('/upload/session/') && req.method === 'PUT') {
      const session = state.sessions.get(pathname.split('/').pop());
      if (!session) return send(res, 404, { error: { code: 404, message: 'Session gone' } });
      const range = req.headers['content-range'] ?? '';
      if (session.videoId) return send(res, 200, youTubeVideo(session.videoId));
      if (range.startsWith('bytes */')) {
        const headers = session.received ? { Range: `bytes=0-${session.received - 1}` } : {};
        return send(res, 308, undefined, headers);
      }
      const start = Number(range.match(/bytes (\d+)-/)?.[1] ?? -1);
      if (start !== session.received) return send(res, 400, { error: { code: 400, message: `Bad offset ${start}` } });
      session.received += body.length;
      if (session.received < session.total) return send(res, 308, undefined, { Range: `bytes=0-${session.received - 1}` });
      const videoId = `yt-${randomUUID()}`;
      session.videoId = videoId;
      state.videos.set(videoId, {
        title: session.meta.snippet.title,
        description: session.meta.snippet.description,
        privacy: session.meta.status.privacyStatus,
        publishAt: session.meta.status.publishAt ? Date.parse(session.meta.status.publishAt) : null,
        madeForKids: session.meta.status.selfDeclaredMadeForKids,
      });
      return send(res, 200, youTubeVideo(videoId));
    }
    if (pathname === '/upload/youtube/v3/thumbnails/set' && req.method === 'POST') {
      const videoId = url.searchParams.get('videoId');
      if (!state.videos.has(videoId)) return send(res, 404, { error: { code: 404, message: 'Video not found', errors: [{ reason: 'videoNotFound' }] } });
      if (url.searchParams.get('uploadType') !== 'media') return send(res, 400, { error: { code: 400, message: 'uploadType must be media' } });
      state.thumbnails.push({ platform: 'youtube', videoId, jpeg: body[0] === 0xff && body[1] === 0xd8 });
      return send(res, 200, { items: [{ default: { url: 'https://example.invalid/t.jpg' } }] });
    }
    if (pathname === '/youtube/v3/videos' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      return send(res, 200, { items: state.videos.has(id) ? [youTubeVideo(id)] : [] });
    }
    if (pathname === '/youtube/v3/videos' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      state.deleted.push(id);
      state.videos.delete(id);
      return send(res, 204);
    }
    send(res, 404, { error: { code: 404, message: `Unknown route ${req.method} ${pathname}` } });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    const label = `${req.method} ${url.pathname}`;
    state.requests.push(label);

    const route = (target) => {
      const graph = url.pathname.match(/^\/graph\/v[\d.]+\/(.*)$/);
      if (graph) return handleGraph(req, target, url, body, graph[1].split('/'));
      const rupload = url.pathname.match(/^\/(ig-api-upload|video-upload)\/v[\d.]+\/([^/]+)$/);
      if (rupload) return handleRupload(req, target, rupload[1], rupload[2], body);
      if (url.pathname === '/dialog') return send(target, 200, { dialog: true });
      handleYouTube(req, target, url, body, url.pathname);
    };

    const failureIndex = failures.findIndex((failure) => label.includes(failure.match)
      && (!failure.bodyIncludes || body.toString().includes(failure.bodyIncludes)));
    if (failureIndex >= 0) {
      const [failure] = failures.splice(failureIndex, 1);
      if (failure.lostResponse) route({ writeHead() {}, end() {} });
      return send(res, failure.status, failure.body);
    }
    route(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mock = {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    failNext,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
    // Points a config object at this mock instead of the real services.
    wire(config) {
      config.meta.graphUrl = `${mock.url}/graph`;
      config.meta.ruploadUrl = mock.url;
      config.meta.dialogUrl = `${mock.url}/dialog`;
      config.google.authUrl = `${mock.url}/dialog`;
      config.google.tokenUrl = `${mock.url}/token`;
      config.google.apiUrl = `${mock.url}/youtube/v3`;
      config.google.uploadUrl = `${mock.url}/upload/youtube/v3`;
      return config;
    },
  };
  return mock;
}
