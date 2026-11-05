// The Cover card on New post. A cover lives on the server beside its video, so what is shown here is what gets sent.

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const emptyCover = () => ({ mode: 'auto', atMs: 0, url: null, saving: false, error: null, next: null, repaint: null });

const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function renderCover({ h, api, target, onBusy, seek }) {
  const { cover, video } = target;
  const coverApi = `/api/videos/${video.id}/cover`;
  const lastMs = Math.max(0, Math.floor(video.info.durationSec * 1000) - 100);

  // One save at a time, and only the newest waiting one, so dragging can't leave an older frame in place.
  async function drain() {
    if (cover.saving) return;
    cover.saving = true;
    cover.repaint?.();
    onBusy();
    while (cover.next) {
      const request = cover.next;
      cover.next = null;
      try {
        const saved = await request();
        cover.url = saved ? `${saved.cover.url}?t=${Date.now()}` : null;
        cover.error = null;
      } catch (err) {
        cover.error = err.message;
        if (!cover.url) cover.mode = 'auto';
      }
    }
    cover.saving = false;
    cover.repaint?.();
    onBusy();
  }

  function save(request) {
    cover.next = request;
    drain();
  }

  const saveFrame = () => save(() => api(coverApi, { method: 'POST', body: { atMs: cover.atMs } }));
  const clearCover = () => save(async () => {
    await api(coverApi, { method: 'DELETE' });
    return null;
  });

  const time = h('span', { class: 'cover-time' });
  const range = h('input', {
    type: 'range',
    id: 'cover-frame',
    min: 0,
    max: lastMs,
    step: 100,
    value: cover.atMs,
    oninput: () => {
      cover.atMs = Number(range.value);
      time.textContent = clock(cover.atMs);
      seek(cover.atMs);
    },
    onchange: saveFrame,
  });

  const fileInput = h('input', {
    type: 'file',
    id: 'cover-file',
    class: 'visually-hidden',
    accept: 'image/jpeg,image/png',
    onchange: () => {
      const [file] = fileInput.files;
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        cover.error = 'Cover images can be at most 8 MB.';
        cover.repaint?.();
        return;
      }
      save(() => api(coverApi, { method: 'PUT', file }));
    },
  });

  const framePanel = h('div', { class: 'field cover-panel' },
    h('label', { htmlFor: 'cover-frame' }, 'Frame at ', time),
    range,
    h('span', { class: 'field-hint' }, 'Drag to the frame you want. The video preview follows.'));

  const imagePanel = h('div', { class: 'cover-panel' },
    h('label', { class: 'btn btn-secondary btn-small file-button', htmlFor: 'cover-file' }, 'Choose image', fileInput),
    h('p', { class: 'field-hint' }, 'JPG or PNG, up to 8 MB. A 9:16 image fits best.'));

  function choose(mode) {
    cover.mode = mode;
    cover.error = null;
    if (mode === 'frame') {
      seek(cover.atMs);
      saveFrame();
    } else if (cover.url) {
      // An image is only in place once one is chosen, so an earlier cover must not go out meanwhile.
      clearCover();
    }
    cover.repaint?.();
  }

  const radios = {};
  const option = (mode, label) => {
    radios[mode] = h('input', { type: 'radio', name: 'cover-mode', value: mode, onchange: () => choose(mode) });
    return h('label', { class: 'check-row' }, radios[mode], label);
  };

  const preview = h('img', { class: 'cover-preview', alt: 'The chosen cover', width: 54, height: 96 });
  const status = h('p', { class: 'field-hint', role: 'status' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  function statusText() {
    if (cover.saving) return 'Saving the cover...';
    if (cover.mode === 'auto') return 'Each platform picks its own cover.';
    if (!cover.url) return 'No image chosen yet, so each platform picks its own.';
    return cover.mode === 'frame' ? `The frame at ${clock(cover.atMs)} is your cover.` : 'Your image is the cover.';
  }

  function paint() {
    for (const [mode, radio] of Object.entries(radios)) radio.checked = cover.mode === mode;
    time.textContent = clock(cover.atMs);
    framePanel.hidden = cover.mode !== 'frame';
    imagePanel.hidden = cover.mode !== 'image';
    preview.hidden = !cover.url;
    if (cover.url && preview.getAttribute('src') !== cover.url) preview.src = cover.url;
    status.textContent = statusText();
    error.textContent = cover.error ?? '';
    error.hidden = !cover.error;
  }
  cover.repaint = paint;

  const card = h('fieldset', { class: 'card cover-card' },
    h('legend', { class: 'card-title' }, 'Cover'),
    h('div', { class: 'cover-top' },
      h('div', { class: 'cover-choices' },
        option('auto', 'Let each platform choose'),
        option('frame', 'Pick a frame from the video'),
        option('image', 'Upload an image')),
      preview),
    framePanel,
    imagePanel,
    status,
    error,
    h('p', { class: 'field-hint' }, 'Instagram uses your cover on Reels. Facebook and YouTube use it when they allow it, and the Schedule page tells you if one refuses. The post goes out either way. The YouTube Shorts feed plays the video instead of showing a cover.'));
  paint();
  return card;
}
