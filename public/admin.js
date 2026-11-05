const GB = 1024 ** 3;

export function viewAdmin(view, ui) {
  const { h, api, appState, toast, confirmAction, showSecret, copyText, pageHead, statePanel, formatStorage, formatDate } = ui;
  let data = null;
  let loadError = null;
  let active = true;

  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  async function run(action, success) {
    try {
      const result = await action();
      if (success) toast(success);
      await load();
      return result;
    } catch (err) {
      toast(err.message);
      return null;
    }
  }

  function renderInvites() {
    const open = data.invites.filter((invite) => !invite.usedBy);
    const used = data.invites.filter((invite) => invite.usedBy);
    return h('section', { class: 'card', 'aria-labelledby': 'invites-title' },
      h('div', { class: 'card-head' },
        h('div', {},
          h('h2', { class: 'card-title', id: 'invites-title' }, 'Invite codes'),
          h('p', { class: 'card-sub' }, data.signupOpen
            ? 'Sign-up is open, so anyone with the address can join without a code.'
            : 'Each code creates one account, then stops working.')),
        h('button', {
          class: 'btn btn-secondary',
          type: 'button',
          'data-focus-key': 'invite-create',
          onclick: () => run(() => api('/api/admin/invites', { method: 'POST' }), 'Invite code created.'),
        }, 'Create invite code')),
      open.length === 0
        ? h('p', { class: 'account-note' }, 'No unused codes. Create one to invite someone.')
        : h('ul', { class: 'admin-list' }, open.map((invite) => h('li', { class: 'invite-row' },
          h('code', { class: 'invite-code' }, invite.code),
          h('button', {
            class: 'btn btn-secondary btn-small',
            type: 'button',
            'aria-label': `Copy the sign-up link for ${invite.code}`,
            onclick: (event) => copyText(`${appState.baseUrl}/#/signup/${invite.code}`, event.currentTarget, toast),
          }, 'Copy link'),
          h('button', {
            class: 'btn btn-danger btn-small',
            type: 'button',
            'aria-label': `Remove ${invite.code}`,
            onclick: async () => {
              const ok = await confirmAction({ title: 'Remove this invite code?', text: `${invite.code} stops working right away.`, okLabel: 'Remove code' });
              if (ok) run(() => api(`/api/admin/invites/${invite.code}`, { method: 'DELETE' }), 'Invite code removed.');
            },
          }, 'Remove')))),
      used.length > 0 && h('details', { class: 'admin-used' },
        h('summary', {}, `Used codes: ${used.length}`),
        h('ul', { class: 'admin-list' }, used.map((invite) => h('li', { class: 'invite-row invite-used' },
          h('code', { class: 'invite-code' }, invite.code),
          h('span', {}, `${invite.usedBy}, ${formatDate(invite.usedAt)}`))))));
  }

  // Resolves with the parsed value, null for the default, or undefined when the dialog is closed without saving.
  function askLimit({ title, text, label, hint, value, parse, invalid }) {
    const dialog = document.getElementById('limit');
    const form = dialog.querySelector('form');
    const input = document.getElementById('limit-input');
    const error = document.getElementById('limit-error');
    document.getElementById('limit-title').textContent = title;
    document.getElementById('limit-text').textContent = text;
    document.getElementById('limit-label').textContent = label;
    document.getElementById('limit-hint').textContent = hint;
    input.value = value;
    error.hidden = true;

    return new Promise((resolve) => {
      let answer;
      const submit = (event) => {
        const typed = input.value.trim();
        const parsed = typed === '' ? null : parse(typed);
        if (parsed === undefined) {
          event.preventDefault();
          error.textContent = invalid;
          error.hidden = false;
          input.focus();
          return;
        }
        answer = parsed;
      };
      const cancel = () => dialog.close();
      form.addEventListener('submit', submit);
      document.getElementById('limit-cancel').addEventListener('click', cancel);
      dialog.addEventListener('close', () => {
        form.removeEventListener('submit', submit);
        document.getElementById('limit-cancel').removeEventListener('click', cancel);
        resolve(answer);
      }, { once: true });
      dialog.showModal();
      input.select();
    });
  }

  const askStorageLimit = (person) => askLimit({
    title: `Storage limit for ${person.username}`,
    text: `They use ${formatStorage(person.usedBytes)} now, and the server has ${formatStorage(data.freeBytes)} free. A lower limit keeps their videos and only stops new uploads.`,
    label: 'Storage limit in GB',
    hint: `Leave empty to use the default of ${formatStorage(data.defaultLimitBytes)}.`,
    value: person.customLimit ? String(Math.round((person.limitBytes / GB) * 100) / 100) : '',
    invalid: 'Type a number of gigabytes, such as 5 or 1.5.',
    parse: (typed) => {
      const gigabytes = Number(typed.replace(',', '.'));
      return Number.isFinite(gigabytes) && gigabytes >= 0 ? Math.round(gigabytes * GB) : undefined;
    },
  });

  const askAccountLimit = (person) => askLimit({
    title: `Account limit for ${person.username}`,
    text: `They have ${plural(person.accountCount, 'account')} connected. Each Facebook Page, Instagram account, and YouTube channel counts as one. A lower limit keeps what is connected and only stops new ones.`,
    label: 'Number of accounts',
    hint: `Leave empty to use the default of ${data.defaultAccountLimit}.`,
    value: person.customAccountLimit ? String(person.accountLimit) : '',
    invalid: 'Type a whole number, such as 3.',
    parse: (typed) => (/^\d+$/.test(typed) ? Number(typed) : undefined),
  });

  function renderPerson(person) {
    const isSelf = person.id === appState.user.id;
    const isFull = person.limitBytes != null && person.usedBytes >= person.limitBytes;
    let storage = `${formatStorage(person.usedBytes)} used`;
    if (person.limitBytes != null) {
      storage = `${formatStorage(person.usedBytes)} of ${formatStorage(person.limitBytes)} used${person.customLimit ? '' : ' (default limit)'}`;
    }
    return h('li', { class: 'person-row' },
      h('p', { class: 'person-name' },
        person.username,
        isSelf && h('span', { class: 'pill pill-active' }, 'You'),
        person.isAdmin && h('span', { class: 'pill pill-active' }, 'Admin'),
        person.disabled && h('span', { class: 'pill pill-fail' }, 'Turned off'),
        isFull && h('span', { class: 'pill pill-warn' }, 'Storage full')),
      h('p', { class: 'person-meta' },
        `${person.accountLimit == null ? plural(person.accountCount, 'account') : `${person.accountCount} of ${plural(person.accountLimit, 'account')}`}, ${plural(person.postCount, 'post')}, ${storage}. Joined ${formatDate(person.createdAt)}.`),
      !isSelf && h('div', { class: 'person-actions' },
        h('button', {
          class: 'btn btn-secondary btn-small',
          type: 'button',
          'data-focus-key': `accounts-${person.id}`,
          'aria-label': `Change the account limit for ${person.username}`,
          onclick: async () => {
            const limit = await askAccountLimit(person);
            if (limit === undefined) return;
            run(() => api(`/api/admin/users/${person.id}/account-limit`, { method: 'POST', body: { limit } }), `Account limit saved for ${person.username}.`);
          },
        }, 'Account limit'),
        h('button', {
          class: 'btn btn-secondary btn-small',
          type: 'button',
          'data-focus-key': `limit-${person.id}`,
          'aria-label': `Change the storage limit for ${person.username}`,
          onclick: async () => {
            const limitBytes = await askStorageLimit(person);
            if (limitBytes === undefined) return;
            run(() => api(`/api/admin/users/${person.id}/storage`, { method: 'POST', body: { limitBytes } }), `Storage limit saved for ${person.username}.`);
          },
        }, 'Storage limit'),
        h('button', {
          class: 'btn btn-secondary btn-small',
          type: 'button',
          'data-focus-key': `reset-${person.id}`,
          'aria-label': `Reset the password for ${person.username}`,
          onclick: async () => {
            const ok = await confirmAction({
              title: `Reset the password for ${person.username}?`,
              text: 'Their current password stops working and they are logged out. You get a new password to send them.',
              okLabel: 'Reset password',
            });
            if (!ok) return;
            const result = await run(() => api(`/api/admin/users/${person.id}/reset-password`, { method: 'POST' }));
            if (result) {
              showSecret({
                title: `New password for ${person.username}`,
                text: "Send this to them privately. It won't be shown again. They can change it on their Profile page.",
                value: result.password,
              });
            }
          },
        }, 'Reset password'),
        person.disabled
          ? h('button', {
            class: 'btn btn-secondary btn-small',
            type: 'button',
            'data-focus-key': `toggle-${person.id}`,
            'aria-label': `Turn on ${person.username}`,
            onclick: () => run(() => api(`/api/admin/users/${person.id}/enable`, { method: 'POST' }), `${person.username} can log in again.`),
          }, 'Turn on')
          : h('button', {
            class: 'btn btn-danger btn-small',
            type: 'button',
            'data-focus-key': `toggle-${person.id}`,
            'aria-label': `Turn off ${person.username}`,
            onclick: async () => {
              const ok = await confirmAction({
                title: `Turn off ${person.username}?`,
                text: "They are logged out and can't log in. Posts waiting here are paused. Posts already handed to Facebook or YouTube stay scheduled there. Nothing is deleted.",
                okLabel: 'Turn off',
              });
              if (ok) run(() => api(`/api/admin/users/${person.id}/disable`, { method: 'POST' }), `${person.username} is turned off.`);
            },
          }, 'Turn off')));
  }

  function renderPeople() {
    return h('section', { class: 'card', 'aria-labelledby': 'people-title' },
      h('h2', { class: 'card-title', id: 'people-title' }, `People: ${data.users.length}`),
      h('p', { class: 'card-sub' }, `${formatStorage(data.freeBytes)} free on the server. Finished posts and their videos are removed ${plural(appState.retentionDays, 'day')} after their publish time.`),
      h('ul', { class: 'admin-list' }, data.users.map(renderPerson)));
  }

  function render() {
    if (!active || !location.hash.startsWith('#/admin')) return;
    const focusKey = document.activeElement?.dataset?.focusKey;
    let content;
    if (loadError && !data) {
      content = statePanel(
        "This page didn't load",
        loadError,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: load }, 'Try loading again'),
        'state-error',
      );
    } else if (!data) {
      content = statePanel('Loading...', 'Fetching people and invite codes.');
    } else {
      content = h('div', { class: 'admin' }, renderInvites(), renderPeople());
    }
    view.replaceChildren(pageHead('Admin', 'Who can use this server, and how much space they take.'), content);
    if (focusKey) view.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  async function load() {
    try {
      data = await api('/api/admin/overview');
      loadError = null;
    } catch (err) {
      loadError = err.message;
      if (data) toast(`Couldn't refresh this page. ${err.message}`);
    }
    render();
  }

  render();
  load();
  return () => { active = false; };
}
