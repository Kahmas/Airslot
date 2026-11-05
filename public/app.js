import { viewAccess } from './access.js';
import { viewAdmin } from './admin.js';
import { copyText } from './clipboard.js';
import { emptyCover, renderCover } from './cover.js';
import { viewGuide } from './guide.js';
import { viewProfile } from './profile.js';

const APP_NAME = 'Airslot';
const PLATFORMS = {
  instagram: { name: 'Instagram', mark: 'IG' },
  facebook: { name: 'Facebook', mark: 'FB' },
  youtube: { name: 'YouTube', mark: 'YT' },
};
const POLL_MS = 10_000;
const IG_CAPTION_LIMIT = 2200;
const CHUNK_RETRIES = 5;

const ICONS = {
  moon: '<svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M15.2 11.4A6.9 6.9 0 0 1 6.6 2.8a.6.6 0 0 0-.8-.7 7.9 7.9 0 1 0 10.1 10.1.6.6 0 0 0-.7-.8Z"/></svg>',
  sun: '<svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18"><circle cx="9" cy="9" r="3.6" fill="currentColor"/><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  left: '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const view = document.getElementById('view');
const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
  .formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ?? '';

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

const formatTime = (ms) => timeFormat.format(ms);
const formatDay = (ms) => dayFormat.format(ms);
const formatWhen = (ms) => `${shortDayFormat.format(ms)}, ${formatTime(ms)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const EMPTY_STATE = { demo: false, user: null, accounts: [], connect: {}, storage: { usedBytes: 0, limitBytes: null } };
const emptySchedule = () => ({ posts: null, error: null, selectedDay: null, month: null, renderedMinute: null });

let session = { user: null, needsSetup: false, needsSetupCode: false, needsInvite: true, demo: false, siteHost: null };
let appState = EMPTY_STATE;
let stopView = null;
let draft = null;
let accessNotice = null;
let schedule = emptySchedule();

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return el;
}

// Only ever called with the fixed strings in ICONS.
function icon(name) {
  const holder = document.createElement('span');
  holder.innerHTML = ICONS[name];
  return holder.firstChild;
}

async function api(path, options = {}) {
  const { file, ...rest } = options;
  const res = await fetch(path, file
    ? { ...rest, headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }
    : {
      ...rest,
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && appState.user && !path.startsWith('/api/auth/')) {
    accessNotice = 'Your session ended. Log in again.';
    showLoggedOut();
  }
  if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}.`);
  return data;
}

function toast(text) {
  const el = h('div', { class: 'toast' }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

function confirmAction({ title, text, okLabel }) {
  const dialog = document.getElementById('confirm');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = okLabel;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

function showSecret({ title, text, value }) {
  const dialog = document.getElementById('secret');
  document.getElementById('secret-title').textContent = title;
  document.getElementById('secret-text').textContent = text;
  document.getElementById('secret-value').textContent = value;
  const status = document.getElementById('secret-status');
  status.textContent = '';
  // A toast would sit behind the dialog's backdrop, so the answer shows inside the dialog.
  document.getElementById('secret-copy').onclick = (event) => copyText(value, event.currentTarget, (text) => { status.textContent = text; });
  // It must not stay readable in the page once it has been closed.
  dialog.addEventListener('close', () => { document.getElementById('secret-value').textContent = ''; }, { once: true });
  dialog.showModal();
}

function statePanel(title, text, action, kind = '') {
  return h('section', { class: `card state ${kind}` },
    h('div', { class: 'state-tile', 'aria-hidden': 'true' }),
    h('div', {}, h('h2', {}, title), h('p', {}, text), action));
}

function pageHead(title, sub) {
  return h('div', { class: 'page-head' },
    h('h1', { class: 'page-title' }, title),
    h('p', { class: 'page-sub' }, sub));
}

const platformMark = (platform) => h('span', { class: 'mark', 'aria-hidden': 'true' }, PLATFORMS[platform].mark);

/* ---------- New post ---------- */

function defaultAirTime() {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function newDraft() {
  return {
    video: null,
    checks: null,
    upload: null,
    uploadError: null,
    cover: emptyCover(),
    caption: '',
    publishNow: false,
    publishAt: defaultAirTime(),
    selected: new Set(appState.accounts.filter((account) => !account.needsReconnect).map((account) => account.id)),
    captions: {},
    title: null,
    madeForKids: false,
    formError: null,
    submitting: false,
  };
}

function suggestedTitle(caption) {
  const firstLine = caption.split('\n').find((line) => line.trim()) ?? '';
  return firstLine.replace(/[<>]/g, '').trim().slice(0, 100);
}

const formatBytes = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const formatStorage = (bytes) => (bytes < 1024 ** 3 ? `${Math.round(bytes / 1048576)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`);
const formatDuration = (seconds) => {
  const total = Math.round(seconds);
  return total < 60 ? `${total} sec` : `${Math.floor(total / 60)} min ${total % 60} sec`;
};

function sendChunk(uploadId, piece, offset, upload, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    upload.xhr = xhr;
    xhr.open('PUT', `/api/uploads/${uploadId}/chunk`);
    xhr.setRequestHeader('X-Upload-Offset', String(offset));
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // A proxy's error page is not JSON; the status alone decides what happens next.
      }
      resolve({ status: xhr.status, data });
    });
    xhr.addEventListener('error', () => resolve({ status: 0, data: null }));
    xhr.addEventListener('abort', () => resolve({ status: 0, data: null }));
    xhr.send(piece);
  });
}

function uploadLabel(upload) {
  if (upload.processing) return 'Checking the video specs...';
  if (upload.retrying) return 'Connection dropped, retrying...';
  return `Uploading ${Math.round(upload.progress * 100)}%`;
}

async function uploadVideo(file) {
  // The upload outlives page switches, so it reports to whichever view currently shows this draft.
  const target = draft;
  const upload = { progress: 0, processing: false, retrying: false, canceled: false, xhr: null, cancel: null };
  let uploadId = null;
  const forget = () => {
    if (uploadId) api(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
  };
  upload.cancel = () => {
    upload.canceled = true;
    upload.xhr?.abort();
    forget();
    target.upload = null;
    target.refresh?.();
  };

  target.upload = upload;
  target.uploadError = null;
  target.video = null;
  target.checks = null;
  target.cover = emptyCover();
  target.refresh?.();

  try {
    const session = await api('/api/uploads', { method: 'POST', body: { fileName: file.name, size: file.size } });
    uploadId = session.id;
    if (upload.canceled) {
      forget();
      return;
    }

    let offset = 0;
    let failures = 0;
    while (offset < file.size) {
      const start = offset;
      const { status, data } = await sendChunk(uploadId, file.slice(start, start + session.chunkBytes), start, upload, (loaded) => {
        upload.progress = (start + loaded) / file.size;
        target.onProgress?.();
      });
      if (upload.canceled) return;
      if (status === 200) {
        offset = data.received;
        failures = 0;
        upload.retrying = false;
        continue;
      }
      if (status === 409 && Number.isSafeInteger(data?.received)) offset = data.received;
      else if (status >= 400 && status < 500) throw new Error(data?.error ?? `The upload failed (code ${status}).`);

      failures += 1;
      if (failures > CHUNK_RETRIES) throw new Error(data?.error ?? 'The connection kept dropping during the upload. Try again.');
      upload.retrying = true;
      target.onProgress?.();
      await new Promise((resolve) => { setTimeout(resolve, failures * 1000); });
      if (upload.canceled) return;
    }

    upload.retrying = false;
    upload.processing = true;
    target.refresh?.();
    const result = await api(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
    target.upload = null;
    target.video = result.video;
    target.checks = result.checks;
    // Start from every usable account, so a previously blocked destination comes back for a better file.
    target.selected = new Set(appState.accounts
      .filter((account) => !account.needsReconnect && target.checks[account.platform]?.ok)
      .map((account) => account.id));
  } catch (err) {
    if (upload.canceled) return;
    forget();
    target.upload = null;
    target.uploadError = err instanceof TypeError ? 'The connection to the app dropped during the upload. Try again.' : err.message;
  }
  target.refresh?.();
}

function renderStage(refresh) {
  const pickFile = (file) => {
    if (file) uploadVideo(file);
  };

  if (draft.upload) {
    const percent = Math.round(draft.upload.progress * 100);
    return h('div', { class: 'stage' },
      h('div', { class: 'tile' },
        h('div', { class: 'upload-status' },
          h('p', { class: 'upload-label' }, uploadLabel(draft.upload)),
          h('progress', { class: 'progress', max: 100, value: percent, 'aria-label': 'Upload progress' }),
          !draft.upload.processing && h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => draft.upload?.cancel() }, 'Cancel upload'))));
  }

  if (draft.video) {
    const { info } = draft.video;
    return h('div', { class: 'stage' },
      h('div', { class: 'tile' },
        h('video', { src: draft.video.fileUrl, controls: true, playsInline: true, preload: 'metadata', width: 270, height: 480, 'aria-label': 'Video preview' })),
      h('p', { class: 'video-facts' },
        h('strong', {}, draft.video.originalName),
        `${formatDuration(info.durationSec)}, ${info.width}x${info.height}, ${formatBytes(draft.video.size)}`),
      h('button', {
        class: 'btn btn-secondary btn-small',
        type: 'button',
        onclick: () => {
          draft.video = null;
          draft.checks = null;
          draft.cover = emptyCover();
          refresh();
        },
      }, 'Replace video'));
  }

  const drop = h('label', {
    class: 'drop',
    ondragover: (event) => {
      event.preventDefault();
      drop.classList.add('dragging');
    },
    ondragleave: () => drop.classList.remove('dragging'),
    ondrop: (event) => {
      event.preventDefault();
      drop.classList.remove('dragging');
      pickFile(event.dataTransfer.files[0]);
    },
  },
  h('input', { type: 'file', accept: 'video/mp4,video/quicktime,.mp4,.mov', onchange: (event) => pickFile(event.target.files[0]) }),
  h('span', { class: 'drop-title' }, 'Drop a vertical video'),
  h('span', { class: 'btn btn-secondary btn-small drop-browse' }, 'Browse files'),
  h('span', { class: 'drop-note' }, 'MP4 or MOV, 9:16, 3 to 90 seconds fits every platform.'));

  return h('div', { class: 'stage' },
    h('div', { class: 'tile' }, drop),
    draft.uploadError && h('p', { class: 'stage-error', role: 'alert' }, draft.uploadError));
}

function destinationNotes(account) {
  if (account.needsReconnect) return [{ level: 'error', text: 'Needs to be reconnected on the Accounts page.' }];
  const check = draft.checks?.[account.platform];
  if (!check) return [];
  if (check.issues.length === 0) return [{ level: 'ok', text: 'This video meets the specs.' }];
  return check.issues;
}

function renderDestination(account, refreshAction) {
  const notes = destinationNotes(account);
  const blocked = notes.some((note) => note.level === 'error');
  const inputId = `dest-${account.id}`;
  const platform = PLATFORMS[account.platform];

  const extras = [];
  if (account.platform === 'youtube') {
    extras.push(
      h('div', { class: 'field' },
        h('label', { htmlFor: `title-${account.id}` }, 'YouTube title'),
        h('input', {
          type: 'text',
          id: `title-${account.id}`,
          maxLength: 100,
          value: draft.title ?? suggestedTitle(draft.caption),
          'data-youtube-title': true,
          oninput: (event) => {
            draft.title = event.target.value;
            draft.formError = null;
            refreshAction();
          },
        }),
        h('span', { class: 'field-hint' }, 'Filled from the first line of the caption. Vertical videos up to 3 minutes become Shorts automatically.')),
      h('label', { class: 'check-row' },
        h('input', {
          type: 'checkbox',
          checked: draft.madeForKids,
          onchange: (event) => { draft.madeForKids = event.target.checked; },
        }),
        'This video is made for kids'),
    );
  }
  const custom = draft.captions[account.id];
  extras.push(h('details', { open: custom != null },
    h('summary', {}, account.platform === 'youtube' ? 'Custom YouTube description' : `Custom ${platform.name} caption`),
    h('div', { class: 'field' },
      h('label', { htmlFor: `caption-${account.id}` }, `Text for ${account.name}`),
      h('textarea', {
        id: `caption-${account.id}`,
        rows: 3,
        value: custom ?? '',
        placeholder: 'Leave empty to use the main caption',
        oninput: (event) => {
          if (event.target.value) draft.captions[account.id] = event.target.value;
          else delete draft.captions[account.id];
        },
      }))));

  return h('div', { class: 'dest' },
    h('label', { class: `dest-head ${blocked ? 'disabled' : ''}`, htmlFor: inputId },
      platformMark(account.platform),
      h('span', { class: 'dest-name' }, platform.name, h('small', {}, account.name)),
      h('input', {
        class: 'switch',
        type: 'checkbox',
        role: 'switch',
        id: inputId,
        checked: draft.selected.has(account.id) && !blocked,
        disabled: blocked,
        onchange: (event) => {
          if (event.target.checked) draft.selected.add(account.id);
          else draft.selected.delete(account.id);
          refreshAction();
        },
      })),
    notes.length > 0 && h('ul', { class: 'dest-notes' },
      notes.map((note) => h('li', { class: `note-${note.level}` }, note.text))),
    !blocked && h('div', { class: 'dest-extra' }, extras));
}

function viewCompose() {
  draft ??= newDraft();
  const media = h('div', { class: 'stage-wrap' });
  const button = h('button', { class: 'btn btn-primary', type: 'submit' });
  const summary = h('p', { class: 'action-summary' });
  const formError = h('p', { class: 'form-error', role: 'alert' });
  const when = h('p', { class: 'field-hint' });

  function currentSelection() {
    return appState.accounts.filter((account) => draft.selected.has(account.id) && !destinationNotes(account).some((note) => note.level === 'error'));
  }

  function refreshAction() {
    const chosen = currentSelection();
    let why = null;
    if (draft.upload) why = 'Waiting for the upload to finish.';
    else if (!draft.video) why = 'Add a video to continue.';
    else if (draft.cover.saving) why = 'Saving the cover...';
    else if (chosen.length === 0) why = 'Turn on at least one account.';
    else if (!draft.publishNow && !Number.isFinite(draft.publishAt)) why = 'Set a publish time.';
    button.disabled = Boolean(why) || draft.submitting;
    if (draft.publishNow) {
      if (draft.submitting) button.textContent = 'Publishing...';
      else button.textContent = chosen.length > 0 ? `Publish to ${plural(chosen.length, 'account')} now` : 'Publish now';
    } else if (draft.submitting) button.textContent = 'Scheduling...';
    else button.textContent = chosen.length > 0 ? `Schedule to ${plural(chosen.length, 'account')}` : 'Schedule';
    summary.replaceChildren(why
      ? h('strong', {}, why)
      : h('strong', {}, draft.publishNow ? 'Right away' : formatWhen(draft.publishAt)));
    if (!why) summary.append(chosen.map((account) => PLATFORMS[account.platform].name).join(', '));
    formError.textContent = draft.formError ?? '';
    formError.hidden = !draft.formError;
  }

  function refreshWhen() {
    when.textContent = Number.isFinite(draft.publishAt)
      ? `${formatDay(draft.publishAt)} at ${formatTime(draft.publishAt)} ${zone}`
      : `Time zone ${zone}`;
  }

  const destinations = h('div');
  function refreshDestinations() {
    if (appState.accounts.length === 0) {
      destinations.replaceChildren(
        h('p', { class: 'account-note' }, 'No accounts are connected yet, so this video has nowhere to go.'),
        h('div', { class: 'account-connect' }, h('a', { class: 'btn btn-secondary', href: '#/accounts' }, 'Connect an account')),
      );
    } else {
      destinations.replaceChildren(...appState.accounts.map((account) => renderDestination(account, refreshAction)));
    }
  }

  const coverSlot = h('div');
  function refreshCover() {
    coverSlot.replaceChildren(...(draft.video ? [renderCover({
      h,
      api,
      target: draft,
      onBusy: refreshAction,
      seek: (ms) => {
        const player = media.querySelector('video');
        if (!player) return;
        player.pause();
        player.currentTime = ms / 1000;
      },
    })] : []));
  }

  function refresh() {
    media.replaceChildren(renderStage(refresh));
    refreshCover();
    refreshDestinations();
    refreshAction();
  }
  draft.refresh = refresh;
  // Progress fires constantly, so it updates in place: rebuilding would swallow clicks on Cancel upload.
  draft.onProgress = () => {
    const label = media.querySelector('.upload-label');
    const bar = media.querySelector('.progress');
    if (label) label.textContent = uploadLabel(draft.upload);
    if (bar) bar.value = Math.round(draft.upload.progress * 100);
  };

  const laterPanel = h('div', { class: 'field' },
    h('label', { htmlFor: 'air-time' }, 'Date and time'),
    h('input', {
      type: 'datetime-local',
      id: 'air-time',
      value: toLocalInput(draft.publishAt),
      oninput: (event) => {
        draft.publishAt = event.target.value ? new Date(event.target.value).getTime() : NaN;
        refreshWhen();
        refreshAction();
      },
    }),
    when);
  const nowHint = h('p', { class: 'field-hint' }, 'It goes out as soon as each platform has processed it, which can take a few minutes.');

  function refreshTiming() {
    laterPanel.hidden = draft.publishNow;
    nowHint.hidden = !draft.publishNow;
    draft.formError = null;
    refreshAction();
  }

  const timingOption = (publishNow, label) => h('label', { class: 'check-row' },
    h('input', {
      type: 'radio',
      name: 'publish-timing',
      checked: draft.publishNow === publishNow,
      onchange: () => {
        draft.publishNow = publishNow;
        refreshTiming();
      },
    }),
    label);

  const count = h('p', { class: 'field-foot' });
  function refreshCount() {
    count.textContent = `${draft.caption.length.toLocaleString('en-GB')} / ${IG_CAPTION_LIMIT.toLocaleString('en-GB')}`;
    count.classList.toggle('over', draft.caption.length > IG_CAPTION_LIMIT);
  }

  const form = h('form', {
    class: 'compose-form',
    novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      draft.submitting = true;
      draft.formError = null;
      refreshAction();
      try {
        const targets = currentSelection().map((account) => ({
          accountId: account.id,
          ...(draft.captions[account.id] ? { caption: draft.captions[account.id] } : {}),
          ...(account.platform === 'youtube' ? {
            title: draft.title ?? suggestedTitle(draft.caption),
            madeForKids: draft.madeForKids,
          } : {}),
        }));
        await api('/api/posts', {
          method: 'POST',
          body: {
            videoId: draft.video.id,
            caption: draft.caption,
            ...(draft.publishNow ? { publishNow: true } : { publishAt: draft.publishAt }),
            targets,
          },
        });
        toast(draft.publishNow ? `Publishing to ${plural(targets.length, 'account')} now.` : `Scheduled for ${formatWhen(draft.publishAt)}.`);
        draft = null;
        location.hash = '#/schedule';
      } catch (err) {
        draft.submitting = false;
        draft.formError = err.message;
        refreshAction();
      }
    },
  },
  h('section', { class: 'card field' },
    h('label', { htmlFor: 'caption', class: 'card-title' }, 'Caption'),
    h('textarea', {
      id: 'caption',
      rows: 4,
      value: draft.caption,
      placeholder: 'Write a caption. The first line also becomes the YouTube title.',
      oninput: (event) => {
        draft.caption = event.target.value;
        draft.formError = null;
        refreshAction();
        refreshCount();
        if (draft.title == null) {
          form.querySelectorAll('[data-youtube-title]').forEach((input) => { input.value = suggestedTitle(draft.caption); });
        }
      },
    }),
    count),
  h('fieldset', { class: 'card timing-card' },
    h('legend', { class: 'card-title' }, 'Publish time'),
    h('div', { class: 'timing-choices' },
      timingOption(false, 'Schedule for later'),
      timingOption(true, 'Publish now')),
    laterPanel,
    nowHint),
  coverSlot,
  h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, 'Publish to'),
    destinations),
  formError,
  h('div', { class: 'action-bar' }, summary, button));

  refreshCount();
  refreshWhen();
  refresh();
  refreshTiming();

  view.replaceChildren(
    pageHead('New post', 'One video, one publish time, every account you turn on.'),
    h('div', { class: 'compose' }, media, form),
  );
}

/* ---------- Schedule ---------- */

const STATUS = {
  waiting: { label: 'Queued', tone: 'active' },
  uploading: { label: 'Uploading', tone: 'active' },
  processing: { label: 'Processing', tone: 'active' },
  ready: { label: 'Ready', tone: 'active' },
  handed_off: { label: 'Scheduled', tone: 'active' },
  published: { label: 'Published', tone: 'ok' },
  failed: { label: 'Failed', tone: 'fail' },
  missed: { label: 'Missed', tone: 'fail' },
  canceled: { label: 'Canceled', tone: 'off' },
};
const ACTIVE = new Set(['waiting', 'uploading', 'processing', 'ready', 'handed_off']);
const NEEDS_ACTION = new Set(['failed', 'missed']);

function targetDetail(target) {
  const platform = PLATFORMS[target.platform].name;
  if (NEEDS_ACTION.has(target.status)) return target.error;
  if (target.error && ACTIVE.has(target.status)) {
    return `Temporary problem, retrying at ${target.nextRunAt ? formatTime(target.nextRunAt) : 'any moment'}. ${target.error}`;
  }
  switch (target.status) {
    case 'waiting':
      return target.nextRunAt > Date.now() ? `Uploads to ${platform} ${formatWhen(target.nextRunAt)}.` : 'Uploading shortly.';
    case 'ready':
      return `Already on ${platform}, goes live at ${formatTime(target.publishAt)}.`;
    case 'handed_off':
      return target.publishAt <= Date.now()
        ? `The publish time has passed, waiting for ${platform} to confirm.`
        : `Scheduled on ${platform}.`;
    default:
      return null;
  }
}

async function targetAction(path, successText) {
  try {
    await api(path, { method: 'POST' });
    toast(successText);
    await loadSchedule();
  } catch (err) {
    toast(err.message);
  }
}

function renderTarget(target) {
  const retrying = target.error && ACTIVE.has(target.status);
  const status = retrying ? { label: 'Retrying', tone: 'warn' } : STATUS[target.status];
  const detail = targetDetail(target);
  const platform = PLATFORMS[target.platform].name;
  const label = `${platform} ${target.accountName}`;

  return h('li', { class: 'target' },
    platformMark(target.platform),
    h('span', { class: 'target-account' }, h('span', { class: 'visually-hidden' }, `${platform} `), target.accountName),
    h('span', { class: 'target-side' },
      h('span', { class: `pill pill-${status.tone}` }, status.label),
      target.remoteUrl && target.status === 'published' && !appState.demo && h('a', { class: 'btn btn-secondary btn-small', href: target.remoteUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open the post on ${label}` }, 'Open'),
      NEEDS_ACTION.has(target.status) && h('button', {
        class: 'btn btn-secondary btn-small',
        type: 'button',
        'data-focus-key': `retry-${target.id}`,
        'aria-label': `${target.status === 'missed' ? 'Publish now' : 'Retry'} on ${label}`,
        onclick: () => targetAction(`/api/targets/${target.id}/retry`, `Running ${label} again.`),
      }, target.status === 'missed' ? 'Publish now' : 'Retry'),
      ACTIVE.has(target.status) && h('button', {
        class: 'btn btn-danger btn-small',
        type: 'button',
        'data-focus-key': `cancel-${target.id}`,
        'aria-label': `Cancel the post on ${label}`,
        onclick: async () => {
          const ok = await confirmAction({
            title: `Cancel the ${platform} post?`,
            text: target.status === 'handed_off'
              ? `The video already waiting on ${platform} will be deleted from there.`
              : 'This video will not go out on that account.',
            okLabel: 'Cancel post',
          });
          if (ok) targetAction(`/api/targets/${target.id}/cancel`, `Canceled the post on ${label}.`);
        },
      }, 'Cancel')),
    detail && h('span', { class: 'target-detail' }, detail),
    target.coverNote && h('span', { class: 'target-detail target-cover-note' }, target.coverNote));
}

function nodeClass(post) {
  if (post.targets.some((target) => NEEDS_ACTION.has(target.status))) return 'node node-issue';
  if (post.targets.some((target) => target.status === 'published')) return 'node node-live';
  if (post.targets.every((target) => target.status === 'canceled')) return 'node node-off';
  return 'node';
}

function renderSlot(post, nowMs) {
  const settled = post.targets.every((target) => !ACTIVE.has(target.status));
  return h('article', { class: `slot ${post.publishAt < nowMs ? 'slot-past' : ''}` },
    h('time', { class: 'slot-time', dateTime: new Date(post.publishAt).toISOString() }, formatTime(post.publishAt)),
    h('div', { class: 'rail', 'aria-hidden': 'true' }, h('span', { class: nodeClass(post) })),
    h('div', { class: 'card slot-card' },
      post.video.thumbUrl
        ? h('img', { class: 'thumb', src: post.video.thumbUrl, alt: '', width: 72, height: 128, loading: 'lazy' })
        : h('div', { class: 'thumb', 'aria-hidden': 'true' }),
      h('div', { class: 'slot-body' },
        h('p', { class: `slot-caption ${post.caption ? '' : 'empty'}` }, post.caption || 'No caption'),
        h('p', { class: 'slot-file' }, `${post.video.originalName}, ${formatDuration(post.video.durationSec)}`),
        h('ul', { class: 'target-list' }, post.targets.map(renderTarget)),
        settled && h('p', { class: 'slot-remove' },
          h('span', { class: 'slot-expiry' }, `Removed from Airslot on ${shortDayFormat.format(Math.max(...post.targets.map((target) => target.publishAt)) + appState.retentionDays * 86_400_000)}.`),
          h('button', {
            class: 'btn btn-secondary btn-small',
            type: 'button',
            'data-focus-key': `remove-${post.id}`,
            'aria-label': `Remove ${post.video.originalName} from the schedule`,
            onclick: async () => {
              const ok = await confirmAction({
                title: 'Remove from the schedule?',
                text: 'The record and the video file are deleted from this app. Posts that already went live stay on the platforms.',
                okLabel: 'Remove',
              });
              if (!ok) return;
              try {
                await api(`/api/posts/${post.id}`, { method: 'DELETE' });
                toast('Removed from the schedule.');
                await loadSchedule();
              } catch (err) {
                toast(err.message);
              }
            },
          }, 'Remove from schedule')))));
}

function renderAttention(posts) {
  const items = posts.flatMap((post) => post.targets
    .filter((target) => NEEDS_ACTION.has(target.status))
    .map((target) => ({ post, target })));
  if (items.length === 0) return null;
  return h('section', { class: 'card attention', 'aria-labelledby': 'attention-title' },
    h('h2', { class: 'card-title', id: 'attention-title' }, `Needs attention: ${items.length}`),
    items.map(({ post, target }) => h('div', {},
      h('p', { class: 'attention-context' }, `${formatWhen(post.publishAt)}, ${post.video.originalName}`),
      h('ul', { class: 'target-list', style: 'margin-top:6px' }, renderTarget(target)))));
}

function renderMonth(posts) {
  const today = new Date();
  schedule.month ??= new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const first = new Date(schedule.month);
  const year = first.getFullYear();
  const month = first.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = (first.getDay() + 6) % 7;

  const byDay = new Map();
  for (const post of posts) {
    const key = dayKey(post.publishAt);
    const entry = byDay.get(key) ?? { count: 0, failed: false };
    entry.count += 1;
    entry.failed ||= post.targets.some((target) => NEEDS_ACTION.has(target.status));
    byDay.set(key, entry);
  }

  const shift = (delta) => {
    schedule.month = new Date(year, month + delta, 1).getTime();
    renderSchedule();
  };

  const cells = [];
  for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    cells.push(h('span', { class: 'cal-dow', 'aria-hidden': 'true' }, name));
  }
  for (let i = 0; i < leadingBlanks; i += 1) cells.push(h('span', { 'aria-hidden': 'true' }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const ms = new Date(year, month, day).getTime();
    const key = dayKey(ms);
    const entry = byDay.get(key);
    const selected = schedule.selectedDay === key;
    const classes = ['day', entry && 'has-posts', entry?.failed && 'has-failed', key === dayKey(today.getTime()) && 'today'].filter(Boolean).join(' ');
    const description = entry ? `${plural(entry.count, 'video')}${entry.failed ? ', needs attention' : ''}` : 'no videos';
    cells.push(h('button', {
      class: classes,
      type: 'button',
      'data-focus-key': `day-${key}`,
      disabled: !entry,
      'aria-pressed': String(selected),
      'aria-label': `${formatDay(ms)}, ${description}`,
      onclick: () => {
        schedule.selectedDay = selected ? null : key;
        renderSchedule();
      },
    }, String(day), entry && h('small', {}, entry.failed ? `${entry.count}!` : String(entry.count))));
  }

  return h('section', { class: 'card cal', 'aria-label': 'Calendar' },
    h('div', { class: 'cal-head' },
      h('h2', { class: 'cal-title' }, monthFormat.format(first)),
      h('button', { class: 'icon-button cal-nav', type: 'button', 'data-focus-key': 'month-prev', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('left')),
      h('button', { class: 'icon-button cal-nav', type: 'button', 'data-focus-key': 'month-next', 'aria-label': 'Next month', onclick: () => shift(1) }, icon('right'))),
    h('div', { class: 'cal-grid' }, cells),
    schedule.selectedDay && h('button', {
      class: 'btn btn-secondary btn-small cal-clear',
      type: 'button',
      'data-focus-key': 'month-clear',
      onclick: () => {
        schedule.selectedDay = null;
        renderSchedule();
      },
    }, 'Show the full schedule'));
}

function renderTimeline(posts, nowMs) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const visible = schedule.selectedDay
    ? posts.filter((post) => dayKey(post.publishAt) === schedule.selectedDay)
    : posts.filter((post) => post.publishAt >= startOfToday);

  if (visible.length === 0) {
    return statePanel(
      'Nothing scheduled from today onward',
      'Earlier videos are still here, pick a day in the calendar to see them.',
      h('a', { class: 'btn btn-secondary', href: '#/new' }, 'Schedule a video'),
    );
  }

  const nodes = [];
  let currentDay = null;
  let nowPlaced = Boolean(schedule.selectedDay) && schedule.selectedDay !== dayKey(nowMs);
  const nowLine = () => h('div', { class: 'now' },
    h('span', { class: 'now-time' }, formatTime(nowMs)),
    h('div', { class: 'rail', 'aria-hidden': 'true' }, h('span', { class: 'node node-now' })),
    h('span', { class: 'now-line' }, 'Now'));

  for (const post of visible) {
    const key = dayKey(post.publishAt);
    if (key !== currentDay) {
      if (!nowPlaced && post.publishAt >= nowMs) {
        nodes.push(nowLine());
        nowPlaced = true;
      }
      nodes.push(h('h2', { class: 'day-title' }, formatDay(post.publishAt)));
      currentDay = key;
    }
    if (!nowPlaced && post.publishAt >= nowMs) {
      nodes.push(nowLine());
      nowPlaced = true;
    }
    nodes.push(renderSlot(post, nowMs));
  }
  if (!nowPlaced) nodes.push(nowLine());
  return h('div', {}, nodes);
}

function scheduleSummary(posts, nowMs) {
  const upcoming = posts.filter((post) => post.publishAt >= nowMs && post.targets.some((target) => ACTIVE.has(target.status))).length;
  const attention = posts.reduce((sum, post) => sum + post.targets.filter((target) => NEEDS_ACTION.has(target.status)).length, 0);
  const parts = [];
  if (upcoming) parts.push(`${plural(upcoming, 'video')} coming up`);
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  return parts.length ? `${parts.join(', ')}.` : 'What goes out, when, and how it went on each account.';
}

function renderSchedule() {
  if (!location.hash.startsWith('#/schedule')) return;
  const focusKey = document.activeElement?.dataset?.focusKey;
  const nowMs = Date.now();
  let sub = 'What goes out, when, and how it went on each account.';

  let content;
  if (schedule.error && !schedule.posts) {
    content = statePanel(
      "The schedule didn't load",
      `${schedule.error} Check your connection and try again.`,
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: loadSchedule }, 'Try loading again'),
      'state-error',
    );
  } else if (!schedule.posts) {
    content = statePanel('Loading the schedule...', 'Fetching your posts from the app.');
  } else if (schedule.posts.length === 0) {
    const noAccounts = appState.accounts.length === 0;
    content = statePanel(
      'No videos scheduled yet',
      noAccounts
        ? 'Connect an account first, then schedule your first video.'
        : 'Schedule your first video, and its status on each account shows up here.',
      noAccounts
        ? h('a', { class: 'btn btn-secondary', href: '#/accounts' }, 'Connect an account')
        : h('a', { class: 'btn btn-secondary', href: '#/new' }, 'Schedule a video'),
    );
  } else {
    sub = scheduleSummary(schedule.posts, nowMs);
    content = h('div', { class: 'schedule' },
      h('div', {}, renderAttention(schedule.posts), renderTimeline(schedule.posts, nowMs)),
      h('aside', { class: 'schedule-side' }, renderMonth(schedule.posts)));
  }

  view.replaceChildren(pageHead('Schedule', sub), content);
  if (focusKey) view.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

async function loadSchedule() {
  try {
    const { posts } = await api('/api/posts');
    const minute = Math.floor(Date.now() / 60_000);
    // The now-line has to keep moving even when no status changed.
    const changed = JSON.stringify(posts) !== JSON.stringify(schedule.posts) || minute !== schedule.renderedMinute;
    schedule.posts = posts;
    schedule.error = null;
    schedule.renderedMinute = minute;
    if (changed) renderSchedule();
  } catch (err) {
    schedule.error = err.message;
    if (!schedule.posts) renderSchedule();
    else toast(`Couldn't refresh the schedule. ${err.message}`);
  }
}

function viewSchedule() {
  renderSchedule();
  loadSchedule();
  const timer = setInterval(() => {
    if (!document.hidden) loadSchedule();
  }, POLL_MS);
  return () => clearInterval(timer);
}

/* ---------- Accounts ---------- */

const CONNECT_URLS = { facebook: '/auth/meta/start', instagram: '/auth/meta/start', youtube: '/auth/google/start' };

function renderAccountRow(account) {
  const platform = PLATFORMS[account.platform].name;
  return h('li', { class: 'account-row' },
    platformMark(account.platform),
    h('span', { class: 'account-name' }, account.name, h('small', {}, platform)),
    account.needsReconnect && !appState.demo && h('a', {
      class: 'btn btn-secondary btn-small',
      href: CONNECT_URLS[account.platform],
      'aria-label': `Reconnect ${platform} ${account.name}`,
    }, 'Reconnect'),
    h('button', {
      class: 'btn btn-danger btn-small',
      type: 'button',
      'aria-label': `Disconnect ${platform} ${account.name}`,
      onclick: async () => {
        const ok = await confirmAction({
          title: `Disconnect ${account.name}?`,
          text: "The app can't post to this account until you connect it again. Its history is removed from the schedule.",
          okLabel: 'Disconnect',
        });
        if (!ok) return;
        try {
          await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
          draft = null;
          toast(`Disconnected ${account.name}.`);
          await loadState();
          viewAccounts();
        } catch (err) {
          toast(err.message);
        }
      },
    }, 'Disconnect'),
    account.needsReconnect && h('span', { class: 'account-warning' }, 'Access has expired. Reconnect while logged in to the account that runs it.'));
}

const accountsAreFull = () => appState.accountLimit != null && appState.accounts.length >= appState.accountLimit;

function accountsSummary() {
  if (appState.accountLimit == null) return 'Where your videos can go.';
  const used = `${appState.accounts.length} of ${plural(appState.accountLimit, 'account')} connected.`;
  return accountsAreFull() ? `${used} To add another, disconnect one or ask your admin for more.` : `Where your videos can go. ${used}`;
}

function renderAccountGroup({ title, note, platforms, configured, startUrl, connectLabel, addLabel, guide }) {
  const accounts = appState.accounts.filter((account) => platforms.includes(account.platform));
  let action;
  if (appState.demo) {
    action = h('p', { class: 'field-hint' }, 'Connecting real accounts is turned off in demo mode. Run npm start to use your own.');
  } else if (accountsAreFull()) {
    action = h('p', { class: 'field-hint' }, "You have reached your account limit, so you can't add another here yet.");
  } else if (configured) {
    action = h('a', { class: accounts.length ? 'btn btn-secondary' : 'btn btn-primary', href: startUrl }, accounts.length ? addLabel : connectLabel);
  } else {
    action = h('p', { class: 'field-hint' }, appState.user.isAdmin
      ? 'Not ready to connect yet, because the server still needs its keys. The setup guide shows how to get them.'
      : 'Not ready to connect yet. Your admin still needs to finish setting this up.');
  }
  return h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, title),
    accounts.length > 0
      ? h('ul', { class: 'account-list' }, accounts.map(renderAccountRow))
      : h('p', { class: 'account-note' }, note),
    h('div', { class: 'account-connect' },
      action,
      h('a', { class: 'btn btn-secondary', href: guide }, 'How to connect')));
}

function viewAccounts() {
  view.replaceChildren(
    pageHead('Accounts', accountsSummary()),
    h('div', { class: 'accounts' },
      renderAccountGroup({
        title: 'Facebook and Instagram',
        note: 'Nothing connected yet. One Meta sign-in brings in every Facebook Page and its linked Instagram account.',
        platforms: ['facebook', 'instagram'],
        configured: appState.connect.meta,
        startUrl: '/auth/meta/start',
        connectLabel: 'Connect with Meta',
        addLabel: 'Add another account',
        guide: '#/guide/meta',
      }),
      renderAccountGroup({
        title: 'YouTube',
        note: 'No channel connected yet.',
        platforms: ['youtube'],
        configured: appState.connect.google,
        startUrl: '/auth/google/start',
        connectLabel: 'Connect a YouTube channel',
        addLabel: 'Add another channel',
        guide: '#/guide/youtube',
      })),
  );
}

/* ---------- Shell ---------- */

const ui = () => ({
  h,
  api,
  appState,
  toast,
  confirmAction,
  showSecret,
  copyText,
  pageHead,
  statePanel,
  formatStorage,
  formatDate: (ms) => shortDayFormat.format(ms),
  refreshState: async () => {
    await loadState();
    return appState;
  },
  signOut,
});

const ROUTES = {
  schedule: { view: viewSchedule, title: 'Schedule' },
  new: { view: viewCompose, title: 'New post' },
  accounts: { view: viewAccounts, title: 'Accounts' },
  guide: { view: (sub) => viewGuide(view, sub, ui()), title: 'Guide' },
  admin: { view: () => viewAdmin(view, ui()), title: 'Admin', adminOnly: true },
  profile: { view: () => viewProfile(view, ui()), title: 'Profile' },
};

const ACCESS_TITLES = { login: 'Log in', signup: 'Sign up', setup: 'Create the admin account' };

function paintShell() {
  const signedIn = Boolean(appState.user);
  document.body.classList.toggle('signed-out', !signedIn);
  document.getElementById('demo-banner').hidden = !session.demo;
  document.getElementById('admin-tab').hidden = !appState.user?.isAdmin;

  const legal = session.siteHost
    ? [
      h('a', { href: `https://${session.siteHost}/terms`, target: '_blank', rel: 'noopener' }, 'Terms of service'),
      h('a', { href: `https://${session.siteHost}/privacy`, target: '_blank', rel: 'noopener' }, 'Privacy policy'),
    ]
    : [];
  const footer = document.getElementById('footer');
  footer.replaceChildren(...(signedIn ? [h('span', {}, `All times are ${zone}.`)] : []), ...legal);
  footer.hidden = footer.childElementCount === 0;
}

async function loadState() {
  appState = await api('/api/state');
  paintShell();
  if (appState.flash) toast(appState.flash.text);
}

// Clears everything of the person who just left, so the next one on this browser starts empty.
function showLoggedOut() {
  stopView?.();
  stopView = null;
  appState = EMPTY_STATE;
  draft = null;
  schedule = emptySchedule();
  session = { ...session, user: null };
  paintShell();
  if (!location.hash.startsWith('#/signup')) location.replace('#/login');
  route();
}

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    session = await api('/api/session');
    showLoggedOut();
  } catch (err) {
    toast(err.message);
  }
}

async function enterApp() {
  session = await api('/api/session');
  accessNotice = null;
  await loadState();
  location.replace(`#/${ROUTES[location.hash.split('/')[1]] ? location.hash.split('/')[1] : 'schedule'}`);
  route();
}

function routeLoggedOut(name, sub) {
  let mode = name === 'signup' ? 'signup' : 'login';
  if (session.needsSetup) mode = 'setup';
  if (mode !== 'setup' && name !== mode) {
    location.replace(`#/${mode}`);
    return;
  }
  stopView?.();
  stopView = null;
  viewAccess(view, mode, sub, { h, api, session, notice: accessNotice, onSignedIn: enterApp });
  document.title = `${ACCESS_TITLES[mode]} | ${APP_NAME}`;
  window.scrollTo(0, 0);
}

function route() {
  const [, name, sub] = location.hash.split('/');
  if (!appState.user) {
    routeLoggedOut(name, sub);
    return;
  }
  if (!ROUTES[name] || (ROUTES[name].adminOnly && !appState.user.isAdmin)) {
    location.replace('#/schedule');
    return;
  }
  stopView?.();
  stopView = ROUTES[name].view(sub) ?? null;
  document.querySelectorAll('[data-route]').forEach((link) => {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${ROUTES[name].title} | ${APP_NAME}`;
  window.scrollTo(0, 0);
}

function startClock() {
  const clock = document.getElementById('clock');
  const tick = () => {
    clock.textContent = `${formatTime(Date.now())} ${zone}`;
  };
  tick();
  setInterval(tick, 1000);
}

function setupTheme() {
  const button = document.getElementById('theme-toggle');
  const root = document.documentElement;
  const isDark = () => root.dataset.theme === 'dark'
    || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const paint = () => {
    button.replaceChildren(icon(isDark() ? 'sun' : 'moon'));
    button.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  };
  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Private windows may block storage; the toggle still works for this visit.
    }
    paint();
  });
  paint();
}

async function start() {
  setupTheme();
  startClock();
  document.getElementById('logout-button').addEventListener('click', signOut);
  try {
    session = await api('/api/session');
    if (session.user) await loadState();
    else paintShell();
  } catch (err) {
    view.replaceChildren(statePanel(
      "The app isn't responding",
      err.message,
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => location.reload() }, 'Reload the page'),
      'state-error',
    ));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

start();
