export function viewProfile(view, { h, api, appState, toast, pageHead, formatStorage, refreshState, signOut }) {
  const { user } = appState;

  const storageLine = h('p', { class: 'storage-line' });
  const storageBar = h('progress', { class: 'progress', 'aria-label': 'Storage used' });

  function paintStorage({ usedBytes, limitBytes }) {
    if (limitBytes == null) {
      storageLine.textContent = `${formatStorage(usedBytes)} used. Admin accounts have no limit.`;
      storageBar.hidden = true;
      return;
    }
    storageLine.textContent = `${formatStorage(usedBytes)} of ${formatStorage(limitBytes)} used.`;
    storageBar.max = limitBytes;
    storageBar.value = Math.min(usedBytes, limitBytes);
  }
  paintStorage(appState.storage);
  refreshState().then((state) => paintStorage(state.storage)).catch(() => {});

  const current = h('input', { id: 'password-current', name: 'current', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { id: 'password-next', name: 'next', type: 'password', autocomplete: 'new-password' });
  const show = h('label', { class: 'check-row' },
    h('input', {
      type: 'checkbox',
      onchange: (event) => {
        const type = event.target.checked ? 'text' : 'password';
        current.type = type;
        next.type = type;
      },
    }),
    'Show passwords');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-secondary', type: 'submit' }, 'Change password');
  let saving = false;

  const form = h('form', {
    class: 'card stack',
    novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      save.textContent = 'Changing...';
      error.hidden = true;
      try {
        await api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
        form.reset();
        current.type = 'password';
        next.type = 'password';
        toast('Password changed. Other devices have been logged out.');
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
      save.textContent = 'Change password';
      saving = false;
    },
  },
  h('h2', { class: 'card-title' }, 'Change password'),
  h('div', { class: 'field' }, h('label', { htmlFor: 'password-current' }, 'Current password'), current),
  h('div', { class: 'field' },
    h('label', { htmlFor: 'password-next' }, 'New password'),
    next,
    h('span', { class: 'field-hint' }, 'At least 10 characters.')),
  show,
  error,
  h('div', {}, save));

  view.replaceChildren(
    pageHead('Profile', `Logged in as ${user.username}.`),
    h('div', { class: 'profile' },
      h('section', { class: 'card profile-session' },
        h('p', { class: 'field-hint' }, 'Scheduled posts still go out after you log out.'),
        h('button', { class: 'btn btn-secondary profile-logout', type: 'button', onclick: signOut }, 'Log out')),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'Storage'),
        storageLine,
        storageBar,
        h('p', { class: 'field-hint storage-note' }, `Finished posts and their videos are removed from Airslot ${appState.retentionDays} ${appState.retentionDays === 1 ? 'day' : 'days'} after their publish time, or sooner if you remove them from the schedule. Posts that went live stay on the platforms, so keep your own copy of any video you may want to post again.`)),
      form),
  );
}
