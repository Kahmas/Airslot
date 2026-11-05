// The logged-out screens: log in, sign up with an invite code, and creating the first admin account.

const COPY = {
  login: {
    title: 'Log in',
    action: 'Log in',
    busy: 'Logging in...',
    url: '/api/auth/login',
  },
  signup: {
    title: 'Sign up',
    action: 'Create account',
    busy: 'Creating your account...',
    url: '/api/auth/signup',
  },
  setup: {
    title: 'Create the admin account',
    action: 'Create admin account',
    busy: 'Creating the account...',
    url: '/api/auth/signup',
  },
};

export function viewAccess(view, mode, sub, { h, api, session, notice, onSignedIn }) {
  const copy = COPY[mode];
  const signingUp = mode !== 'login';

  function field({ name, label, hint, ...attributes }) {
    const id = `access-${name}`;
    const input = h('input', { id, name, type: 'text', ...attributes });
    return {
      input,
      element: h('div', { class: 'field' },
        h('label', { htmlFor: id }, label),
        input,
        hint && h('span', { class: 'field-hint' }, hint)),
    };
  }

  const code = field({
    name: 'code',
    label: mode === 'setup' ? 'Setup code' : 'Invite code',
    hint: mode === 'setup' ? 'The APP_PASSWORD value in the server settings.' : 'Your admin gives you this. It works once.',
    autocomplete: 'off',
    autocapitalize: mode === 'setup' ? 'none' : 'characters',
    value: mode === 'signup' && sub ? decodeURIComponent(sub) : '',
  });
  code.input.setAttribute('spellcheck', 'false');

  const username = field({
    name: 'username',
    label: 'Username',
    hint: signingUp ? '3 to 32 characters: letters, numbers, dots, dashes, and underscores.' : null,
    autocomplete: 'username',
    autocapitalize: 'none',
  });
  username.input.setAttribute('spellcheck', 'false');

  const password = field({
    name: 'password',
    label: 'Password',
    type: 'password',
    hint: signingUp ? 'At least 10 characters.' : null,
    autocomplete: signingUp ? 'new-password' : 'current-password',
  });

  const showPassword = h('label', { class: 'check-row' },
    h('input', {
      type: 'checkbox',
      onchange: (event) => { password.input.type = event.target.checked ? 'text' : 'password'; },
    }),
    'Show password');

  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const button = h('button', { class: 'btn btn-primary auth-submit', type: 'submit' }, copy.action);
  let busy = false;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.textContent = copy.busy;
    error.hidden = true;
    try {
      const needsCode = mode === 'signup' ? session.needsInvite : session.needsSetupCode;
      await api(copy.url, {
        method: 'POST',
        body: {
          username: username.input.value.trim(),
          password: password.input.value,
          ...(signingUp && needsCode ? { code: code.input.value.trim() } : {}),
        },
      });
      await onSignedIn();
    } catch (err) {
      error.textContent = err instanceof TypeError ? "Couldn't reach the app. Check your connection and try again." : err.message;
      error.hidden = false;
      button.textContent = copy.action;
      busy = false;
    }
  }

  const fields = [];
  if (mode === 'setup' && session.needsSetupCode) fields.push(code.element);
  if (mode === 'signup' && session.needsInvite) fields.push(code.element);
  fields.push(username.element, password.element, showPassword);

  const legal = session.siteHost && signingUp && h('p', { class: 'auth-legal' },
    'By signing up, you agree to the ',
    h('a', { href: `https://${session.siteHost}/terms`, target: '_blank', rel: 'noopener' }, 'Terms of service'),
    ' and the ',
    h('a', { href: `https://${session.siteHost}/privacy`, target: '_blank', rel: 'noopener' }, 'Privacy policy'),
    '.');

  const links = [];
  if (mode === 'login') {
    links.push(h('p', {}, 'New here? ', h('a', { href: '#/signup' }, session.needsInvite ? 'Sign up with an invite code' : 'Sign up')));
    links.push(h('p', {}, 'Forgot your password? Ask your admin to reset it.'));
  }
  if (mode === 'signup') links.push(h('p', {}, 'Already have an account? ', h('a', { href: '#/login' }, 'Log in')));

  const intro = mode === 'setup'
    ? 'This is the first account on this server. It takes over everything already here, and it can invite other people.'
    : null;

  view.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-intro' },
      h('div', { class: 'auth-tile', 'aria-hidden': 'true' },
        h('span', { class: 'auth-now' }),
        ['IG', 'FB', 'YT'].map((mark) => h('span', { class: 'mark' }, mark))),
      h('div', {},
        h('p', { class: 'auth-lead' }, 'One video, one publish time, every account.'),
        h('p', { class: 'auth-sub' }, 'Schedule Reels and Shorts to Instagram, Facebook, and YouTube from one form.'))),
    h('form', { class: 'card auth-card', novalidate: true, onsubmit: submit },
      h('h1', { class: 'auth-title' }, copy.title),
      intro && h('p', { class: 'auth-note' }, intro),
      notice && h('p', { class: 'auth-note' }, notice),
      session.demo && mode === 'login' && h('p', { class: 'auth-note' }, 'Demo mode: log in with ', h('code', {}, 'demo'), ' and ', h('code', {}, 'demo-password'), '.'),
      fields,
      error,
      button,
      legal,
      links.length > 0 && h('div', { class: 'auth-links' }, links))));
}
