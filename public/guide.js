import { copyText } from './clipboard.js';

// The in-app guide. Addresses come from the running server, so what people copy is always right for this install.
// It walks through every screen people met while connecting real accounts, including the ones that went wrong.

const SECTIONS = {
  meta: 'Facebook & Instagram',
  youtube: 'YouTube',
  problems: 'Problems',
};

const ADMIN_SECTIONS = {
  'setup-meta': 'Setup: Meta',
  'setup-google': 'Setup: Google',
};

const META_PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];

export function viewGuide(view, sub, { h, appState, toast }) {
  const isAdmin = appState.user.isAdmin;
  const sections = isAdmin ? { ...SECTIONS, ...ADMIN_SECTIONS } : SECTIONS;
  const section = sections[sub] ? sub : 'meta';
  const b = (text) => h('strong', {}, text);
  const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

  const copyRow = (text, label) => h('div', { class: 'copy-row' },
    h('code', {}, text),
    h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'aria-label': `Copy ${label}`, onclick: (event) => copyText(text, event.currentTarget, toast) }, 'Copy'));

  const steps = (...items) => h('ol', { class: 'steps' }, items.map((item) => h('li', {}, item)));
  const bullets = (...items) => h('ul', { class: 'guide-list' }, items.map((item) => h('li', {}, item)));
  const note = (...children) => h('p', { class: 'guide-note' }, children);
  const sub3 = (text) => h('h3', { class: 'part-sub' }, text);

  // What to check after a step, what to do when the screen differs, and what not to press.
  const see = (...children) => h('p', { class: 'step-note step-see' }, b('You should see: '), children);
  const ifSee = (seen, ...children) => h('p', { class: 'step-note step-if' }, b(`If you see ${seen}: `), children);
  const dont = (...children) => h('p', { class: 'step-note step-dont' }, b("Don't: "), children);

  // Numbers the parts and builds the list at the top, so a long guide can be jumped through.
  function guidePage(lead, parts) {
    const visible = parts.filter(Boolean);
    const toc = h('nav', { class: 'card guide-toc', 'aria-labelledby': 'guide-toc-title' },
      h('h2', { class: 'card-title', id: 'guide-toc-title' }, 'In this guide'),
      h('ol', { class: 'toc-list' }, visible.map((part, index) => h('li', {},
        h('button', {
          class: 'toc-link',
          type: 'button',
          onclick: () => {
            const target = document.getElementById(`part-${index + 1}`);
            target.scrollIntoView();
            target.focus({ preventScroll: true });
          },
        }, part.title)))));
    return [
      lead,
      toc,
      visible.map((part, index) => h('section', { class: 'card part', id: `part-${index + 1}`, tabindex: '-1' },
        h('h2', { class: 'card-title' }, `Part ${index + 1}: ${part.title}`),
        part.intro && h('p', { class: 'part-intro' }, part.intro),
        part.body)),
    ];
  }

  const beforeYouStart = (...body) => h('section', { class: 'card part' },
    h('h2', { class: 'card-title' }, 'Before you start'),
    body);

  const serverKeys = (rows) => [
    h('dl', { class: 'keys' }, rows.flatMap(([name, where]) => [h('dt', {}, h('code', {}, name)), h('dd', {}, where)])),
    note(b('Keep the secret values private. '), "Don't paste them into a group chat or a support message. If someone else manages your server, send them through a password manager. Everything below happens on the server."),
    steps(
      ['Log in to your server and open the settings file:', copyRow('sudo nano /etc/airslot/airslot.env', 'the command that opens the settings file')],
      'Use the arrow keys to reach each line, and type the value right after its equals sign, with no spaces.',
      [dont('change any other line in this file.')],
      ['Save with ', b('Ctrl+O'), ', then ', b('Enter'), ', then leave with ', b('Ctrl+X'), '.'],
      ['Restart Airslot so it reads the new values:', copyRow('sudo systemctl restart airslot', 'the restart command')],
      ['Open the ', h('a', { href: '#/accounts' }, 'Accounts page'), ' and reload it.', see('a connect button instead of "Not ready to connect yet".')],
    ),
  ];

  function limitNote() {
    if (appState.accountLimit == null) return null;
    return note(b(`Your limit is ${appState.accountLimit} ${appState.accountLimit === 1 ? 'account' : 'accounts'}, and you have ${appState.accounts.length} connected. `), 'Each Facebook Page, Instagram account, and YouTube channel counts as one. Your admin can raise it.');
  }

  function connectAction(configured, url, label, setupSection) {
    if (appState.demo) return note('Connecting real accounts is turned off in demo mode.');
    if (configured) return h('a', { class: 'btn btn-primary', href: url }, label);
    if (isAdmin) return note(b('The button appears here once the keys are on the server. '), h('a', { href: `#/guide/${setupSection}` }, 'Follow the setup guide'), ', then reload this page.');
    return note(b('This is not ready yet. '), 'Your admin still needs to finish setting it up.');
  }

  function statusLine(platforms, configured) {
    const names = appState.accounts.filter((account) => platforms.includes(account.platform)).map((account) => account.name);
    if (names.length > 0) {
      return h('p', { class: 'guide-status' },
        h('span', { class: 'pill pill-ok' }, 'Connected'),
        h('span', {}, `${names.join(', ')}. To add one more, go to the "Add another account" part.`));
    }
    return h('p', { class: 'guide-status' },
      h('span', { class: 'pill pill-active' }, 'Not connected'),
      h('span', {}, configured ? 'Start at Part 1 and follow each part in order.' : 'Connecting is not ready yet on this server.'));
  }

  function metaGuide() {
    return guidePage([
      statusLine(['facebook', 'instagram'], appState.connect.meta),
      note("You only do this once. One Meta sign-in connects your Facebook Page and its linked Instagram account together. Menu names on Meta's sites change from time to time, so yours may differ slightly."),
      beforeYouStart(
        h('p', { class: 'part-intro' }, 'Meta only lets apps post to a Facebook Page and to a professional Instagram account linked to that Page. Most trouble comes from one of these not being ready, so this guide checks each one first.'),
        h('dl', { class: 'keys' },
          h('dt', {}, 'Facebook profile'), h('dd', {}, 'Your personal account. Airslot cannot post here.'),
          h('dt', {}, 'Facebook Page'), h('dd', {}, 'A separate page for a brand or creator, run from your profile. Airslot posts here.'),
          h('dt', {}, 'Professional Instagram account'), h('dd', {}, 'An Instagram account set to Business or Creator. Airslot cannot post to a personal one.')),
        sub3('Have these ready'),
        bullets(
          'The Facebook login you will keep using. Use this same account in every part.',
          'Your Instagram login, and the Instagram app on your phone.',
        )),
    ], [
      {
        title: 'Check your Facebook Page',
        intro: 'The Facebook account you use must run the Page itself.',
        body: [
          steps(
            ['Log in to Facebook with the account you will keep using, then open ', link('your Pages', 'https://www.facebook.com/pages/?category=your_pages'), '.'],
            'Find your situation below.',
          ),
          sub3('Your Page is listed'),
          note('Nothing to do. Go to Part 2.'),
          sub3('The list is empty, and you have no Page yet'),
          steps(
            ['Open ', link('the Create a Page screen', 'https://www.facebook.com/pages/create'), '.'],
            ['Type a ', b('Page name'), ' and pick a ', b('Category'), ', then click ', b('Create Page'), '.'],
            'The remaining questions can be skipped. You can fill them in later.',
          ),
          sub3('The Page exists, but another Facebook account runs it'),
          steps(
            'Ask the person who runs it to log in to Facebook and switch to the Page.',
            ['They open ', b('Settings'), ', ', b('Page setup'), ', ', b('Page access'), ', then click ', b('Add New'), '.'],
            ['They type your Facebook name, turn on ', b('Full control'), ', and confirm.'],
            'Accept the invitation from your Facebook notifications.',
          ),
          see('your Page in the list at ', link('your Pages', 'https://www.facebook.com/pages/?category=your_pages'), ' before you go on.'),
        ],
      },
      {
        title: 'Make your Instagram account professional',
        intro: "Do this in the Instagram app on your phone. Keep your existing account. You don't need a new one.",
        body: [
          steps(
            ['Open your profile, tap the three-line menu at the top, then ', b('Account type and tools'), '.'],
            'Read the option on that screen:',
          ),
          sub3('It says Switch to professional account'),
          steps(
            'Tap it, then tap through the introduction screens.',
            'Pick any category. It can be hidden from your profile.',
            ['Choose ', b('Business'), ' or ', b('Creator'), '. Either one works with Airslot.'],
            'The app may offer to connect a Page or invite friends here. You can skip these, because Part 3 covers the link.',
          ),
          note(b('Good to know: '), 'a professional account cannot be private, so a private account becomes public when you switch.'),
          sub3('It says Switch to personal account'),
          note('Your account is already professional. ', b("Don't tap it. "), 'Go to Part 3.'),
        ],
      },
      {
        title: 'Link Instagram to your Page',
        intro: 'This is the step that is easiest to miss. Airslot finds your Instagram account through the Page it is linked to.',
        body: [
          sub3('From Facebook on a computer'),
          steps(
            'Log in with the same Facebook account, click your profile picture at the top right, and switch to your Page.',
            ['Open ', b('Settings'), ', ', b('Linked accounts'), ', then ', b('Instagram'), '.'],
            ['Click ', b('Connect account'), '. Log in to Instagram if asked, and follow the steps.'],
            see('your Instagram username shown as connected on that screen.'),
          ),
          sub3('If that menu is not there, use the Instagram app'),
          steps(
            ['Open your profile and tap ', b('Edit profile'), '.'],
            ['Under the public business information, tap ', b('Page'), '.'],
            [b('Connect'), ' your existing Page, and log in to Facebook if asked.'],
          ),
          ifSee('the Instagram account is already linked to another Page', 'use that Page in Airslot, or disconnect it there first. Each Instagram account links to one Page.'),
        ],
      },
      !isAdmin && {
        title: 'Accept your tester invitation',
        intro: "Meta only lets people with a role on Airslot's Meta app sign in until the app has passed Meta's review. Ask your admin whether this has happened. If it has, skip this part.",
        body: steps(
          'Send your admin the name of your Facebook account, and ask them to add you as a tester.',
          ['Once they have, open ', link('developers.facebook.com/requests', 'https://developers.facebook.com/requests'), ' while logged in to that Facebook account.'],
          ['Register if it asks you to, then click ', b('Accept'), ' on the Airslot request.'],
        ),
      },
      {
        title: 'Connect',
        intro: 'Meta shows several screens. Go through them slowly, because the choices on the first two decide what Airslot can reach.',
        body: [
          h('p', { class: 'part-action' }, connectAction(appState.connect.meta, '/auth/meta/start', 'Connect with Meta', 'setup-meta')),
          steps(
            ['Click the button above. Log in to Facebook if asked, and check that the name on screen is the account that runs your Page.',
              ifSee('Edit previous settings', 'click it, so you can choose your Page and Instagram account again.')],
            ['On the Pages screen, choose ', b('Opt in to current Pages only'), ', tick your Page, and click ', b('Continue'), '.',
              dont(`choose "Opt in to all current and future Pages". That screen moves on even when you have no Page, and Airslot then finds nothing.`),
              ifSee('"You don\'t have any Pages"', 'close the window and go back to Part 1.')],
            ['On the Instagram screen, choose ', b('Opt in to current Instagram accounts only'), ', tick your account, and click ', b('Continue'), '.',
              dont('click "Create Instagram account". You don\'t need a new account.'),
              ifSee('"You don\'t have any Instagram accounts"', 'close the window, go back to Parts 2 and 3, then connect again.')],
            ['Leave every permission on. Airslot needs all of them, and posting can fail if one is off.'],
            ['Click ', b('Save'), ', then ', b('Got it'), '.'],
          ),
          see('the message "Connected 1 Facebook Page, 1 Instagram account" in the corner, and both listed on the ', h('a', { href: '#/accounts' }, 'Accounts page'), '.'),
          ifSee('"Meta returned no Facebook Page"', 'connect again and make sure your Page is ticked in the list.'),
          ifSee('"no Instagram account linked to them"', 'the Page connected, but Instagram did not. Go back to Parts 2 and 3, then connect again.'),
        ],
      },
      {
        title: 'Check it with a test post',
        intro: 'Do this once, with a video you are happy to publish.',
        body: [
          steps(
            ['Open ', h('a', { href: '#/new' }, 'New post'), ', add a vertical video, and set the publish time at least 20 minutes ahead.'],
            'Turn on your Facebook and Instagram accounts, then schedule it.',
            ['Watch the status on the ', h('a', { href: '#/schedule' }, 'Schedule page'), '. Instagram stays on ', b('Queued'), ' until 15 minutes before the publish time, which is normal.'],
          ),
          see(b('Published'), ' on both after the publish time. The ', b('Open'), ' button takes you to each post.'),
          note('Then open both posts from a logged-out browser or another account, to check that other people can see them.'),
        ],
      },
      {
        title: 'Add another account',
        intro: 'One Airslot login can hold accounts from different Facebook logins, for example a second email with its own Page and Instagram. Your first accounts stay connected.',
        body: [
          limitNote(),
          steps(
            'Make sure the other Facebook login runs a Page, with a professional Instagram account linked to it. Parts 1 to 3 cover this.',
            [isAdmin
              ? ['Add that Facebook login as a tester on the Meta app, as the Setup: Meta guide shows. It must accept the request at ', link('developers.facebook.com/requests', 'https://developers.facebook.com/requests'), '.']
              : ['Ask your admin to add that Facebook login as a tester, then accept the request at ', link('developers.facebook.com/requests', 'https://developers.facebook.com/requests'), '. Skip this if Airslot has passed Meta\'s review.']],
            ['Log out of your first account on ', link('Facebook', 'https://www.facebook.com'), ' in this browser. Meta connects whichever account is logged in.',
              dont('skip this. If you stay logged in, Meta only asks about your first account again.')],
            ['Open the ', h('a', { href: '#/accounts' }, 'Accounts page'), ', click ', b('Add another account'), ', and log in with the other Facebook login.'],
            ['Choose ', b('Opt in to current Pages only'), ' and ', b('Opt in to current Instagram accounts only'), ', tick the accounts, and click ', b('Save'), '.'],
          ),
          see('the new Page and Instagram account listed on the Accounts page, along with your first ones.'),
          note(b('When scheduling: '), 'every connected account starts switched on in New post, so turn off the ones this video is not for.'),
        ],
      },
    ]);
  }

  function youtubeGuide() {
    return guidePage([
      statusLine(['youtube'], appState.connect.google),
      note("You only do this once. Menu names on Google's sites change from time to time, so yours may differ slightly."),
      beforeYouStart(
        h('p', { class: 'part-intro' }, 'Airslot posts to one YouTube channel for each sign-in. A vertical or square video up to 3 minutes becomes a Short on its own.'),
        sub3('Have this ready'),
        bullets('The Google account that owns your channel. If you have several Google accounts, use the same one in every part.')),
    ], [
      {
        title: 'Check your YouTube channel',
        intro: 'A Google account does not have a channel until you make one, and Airslot needs a channel to post to.',
        body: [
          steps(
            ['Open ', link('YouTube', 'https://www.youtube.com'), ' and log in with the Google account you will use.'],
            'Click your profile picture at the top right.',
            ['If the menu shows ', b('View your channel'), ', you already have one. Go to Part 2.'],
            ['If it shows ', b('Create a channel'), ', click it, fill in the name and handle, then click ', b('Create channel'), '.'],
          ),
          note('An empty channel is fine. Airslot does not need subscribers or older videos, and you can change the name and picture later.'),
        ],
      },
      {
        title: 'Connect',
        intro: 'Google shows a few screens, and one of them looks like a warning.',
        body: [
          h('p', { class: 'part-action' }, connectAction(appState.connect.google, '/auth/google/start', 'Connect a YouTube channel', 'setup-google')),
          steps(
            ['Click the button above and choose the Google account that owns the channel. If it is not listed, click ', b('Use another account'), '.'],
            [ifSee('"Google hasn\'t verified this app"', 'click ', b('Advanced'), ' at the bottom left, then ', b('Go to Airslot'), '. Google shows this until it has verified Airslot, and it may label the link "unsafe".')],
            ['On the access screen, tick every box for YouTube if there are boxes, then click ', b('Continue'), '. Airslot needs this access to upload, schedule, and cancel your videos.'],
            'Google sends you back to Airslot.',
          ),
          see('the message "Connected YouTube channel" with your channel name, and the channel on the ', h('a', { href: '#/accounts' }, 'Accounts page'), '.'),
          ifSee('"This Google account doesn\'t have a YouTube channel yet"', 'you chose an account with no channel. Go back to Part 1, or connect again with the right account.'),
          ifSee('"Access blocked" from Google', 'stop and tell your admin. The Google project has to be published first.'),
        ],
      },
      {
        title: 'Check it with a test post',
        intro: 'Do this once, with a video you are happy to publish.',
        body: [
          steps(
            ['Open ', h('a', { href: '#/new' }, 'New post'), ', add a vertical video, and set the publish time at least 20 minutes ahead.'],
            'Turn on your YouTube channel and check the title, which comes from the first line of the caption.',
            'Schedule it.',
            ['Open ', link('YouTube Studio', 'https://studio.youtube.com'), ', then ', b('Content'), '.'],
          ),
          see('the video listed as private with your publish date. YouTube makes it public at that time, and the Schedule page then shows ', b('Published'), '.'),
        ],
      },
      {
        title: 'Add another account',
        intro: 'One Airslot login can hold channels from different Google accounts. Your first channel stays connected.',
        body: [
          limitNote(),
          steps(
            'Make sure the other Google account has its own channel. Part 1 covers this.',
            ['Open the ', h('a', { href: '#/accounts' }, 'Accounts page'), ' and click ', b('Add another channel'), '.'],
            ['Google asks which account to use. Choose the other one, or click ', b('Use another account'), ' if it is not listed.'],
            'Go through the same screens as in Part 2.',
          ),
          see('the new channel listed on the Accounts page, along with your first one.'),
          note(b('When scheduling: '), 'every connected account starts switched on in New post, so turn off the ones this video is not for.'),
        ],
      },
    ]);
  }

  function setupMetaGuide() {
    return guidePage([
      note("Only an admin does this, once. It creates the Meta app that everyone on this server connects through. Menu names on Meta's sites change from time to time, so yours may differ slightly."),
      beforeYouStart(
        sub3('Have these ready'),
        bullets(
          'The Facebook account that runs your Page. Use it for every part.',
          'Access to the server, to save the keys in Part 4.',
        )),
    ], [
      {
        title: 'Register as a Meta developer',
        intro: 'Skip this part if you already see your apps on the Meta for Developers site.',
        body: steps(
          ['Open ', link('Meta for Developers', 'https://developers.facebook.com/apps'), ' while logged in to the Facebook account that runs your Page.'],
          ['Click ', b('Get Started'), ' at the top right, then ', b('Register'), ', and accept the terms.'],
          'Verify your phone number and email if asked.',
          ['If it asks about your role, choose ', b('Developer'), '. The choice does not change what you can do.'],
          [see('the ', b('Apps'), ' page.'), dont('click "Build your first Meta VR app". It has nothing to do with this.'), ifSee('a request for a card or documents', 'stop and check why. Setting up Airslot did not need either.')],
        ),
      },
      {
        title: 'Create the Meta app',
        intro: 'This app is the official permission that lets Airslot post for people.',
        body: steps(
          ['Click ', b('Create App'), '. Type ', b('Airslot'), ' as the app name, add your email, and click ', b('Next'), '.'],
          ['On the use case screen, click ', b('Others'), ' under ', b('Filter by'), ', choose ', b('Other'), ' at the very bottom, and click ', b('Next'), '.',
            note('Meta may label it "This option is going away soon". It is still the right one, because it gives access to Facebook Login for Business, which uploading from a file requires.'),
            dont('choose "Authenticate and request data from users with Facebook Login", "Create an app without a use case", "Manage messaging & content on Instagram", or "Manage everything on your Page". None of them give Airslot what it needs.')],
          ['Choose the ', b('Business'), ' type, then ', b('Next'), '.'],
          ['If asked about a ', b('Business portfolio'), ', choose not to connect one yet.'],
          ['Click ', b('Create app'), ', and type your Facebook password if asked.'],
          [see('the app dashboard, with ', b('App Mode'), ' set to ', b('Development'), ' and the ', b('App ID'), ' at the top. Leave it on Development for now.')],
        ),
      },
      {
        title: 'Set up the login',
        intro: null,
        body: steps(
          ['In the product list, find ', b('Facebook Login for Business'), ' and click ', b('Set up'), '. If a Quickstart screen opens, ignore it.'],
          ['In the left menu, open ', b('Settings'), ' under that product. Under ', b('Valid OAuth Redirect URIs'), ', paste this address and click ', b('Save changes'), ':',
            copyRow(`${appState.baseUrl}/auth/meta/callback`, 'the Meta redirect address')],
          ['In the left menu, open ', b('Configurations'), ', then ', b('Create configuration'), '. Name it ', b('Airslot'), ' and click ', b('Next'), '.'],
          ['Leave ', b('Login variation'), ' on ', b('General'), ' and click ', b('Next'), '. A note about business portfolios can be ignored.'],
          ['Under ', b('Access token'), ', choose ', b('User access token'), '. If there is an expiry choice, pick the longest or ', b('Never'), '.',
            dont('choose "System user". Airslot\'s sign-in uses a user token.')],
          ['If there is an ', b('Assets'), ' screen, tick ', b('Pages'), ' and ', b('Instagram accounts'), '.'],
          ['Under ', b('Select permissions'), ', search for and tick all five:',
            h('div', { class: 'copy-list' }, META_PERMISSIONS.map((name) => copyRow(name, name))),
            ifSee('no permissions starting with instagram_', 'add the Instagram product to the app, then make the configuration again.')],
          ['Click ', b('Create'), ', note the ', b('Configuration ID'), ' it shows, then click ', b('Got it'), '.'],
        ),
      },
      {
        title: 'Put the keys on the server',
        intro: 'You now have three values to add.',
        body: serverKeys([
          ['META_APP_ID', ['At the top of the Meta app page, next to ', b('App ID'), '.']],
          ['META_APP_SECRET', [b('App settings'), ', ', b('Basic'), ', ', b('App secret'), ', then ', b('Show'), '. Facebook may ask for your password. This one is secret.']],
          ['META_CONFIG_ID', ['The ', b('Configuration ID'), ' from Part 3.']],
        ]),
      },
      {
        title: 'Connect your own account',
        intro: null,
        body: [
          note('Follow the ', h('a', { href: '#/guide/meta' }, 'Facebook & Instagram guide'), ' from Part 1. If it connects, the keys are right.'),
          ifSee('"URL blocked"', 'the redirect address was not saved, or has a typo. Go back to Part 3.'),
          ifSee('"Meta returned no Facebook Page" after signing in', "the keys are fine, and the problem is the account's Page. See Part 1 of that guide."),
        ],
      },
      {
        title: 'Let other people connect',
        intro: 'While the app is in Development, Meta only lets people with a role on the app sign in.',
        body: [
          steps(
            ['Open ', b('App roles'), ', then ', b('Roles'), ', in the left menu of the Meta app.'],
            ['Click ', b('Add People'), ', choose ', b('Testers'), ', and enter the person\'s Facebook account.'],
            ['They accept the request at ', link('developers.facebook.com/requests', 'https://developers.facebook.com/requests'), '.'],
          ),
          note(b('To let anyone connect without a role, '), 'Meta requires App Review for the five permissions above and Business Verification, and then the app can switch to Live.'),
        ],
      },
    ]);
  }

  function setupGoogleGuide() {
    const site = appState.siteHost;
    return guidePage([
      note("Only an admin does this, once. It creates the Google project that everyone on this server connects through. Menu names on Google's sites change from time to time, so yours may differ slightly."),
      beforeYouStart(
        sub3('Have these ready'),
        bullets(
          'The Google account that owns your channel. Use it for every part.',
          'Access to the server, to save the keys in Part 6.',
        )),
    ], [
      {
        title: 'Create a Google Cloud project',
        intro: 'This is free, and it is what lets Airslot talk to YouTube.',
        body: steps(
          ['Open ', link('Google Cloud Console', 'https://console.cloud.google.com'), ' and log in.'],
          ['Click the project picker at the top, then ', b('New project'), '. Name it ', b('Airslot'), ' and click ', b('Create'), '.'],
          'Open the project picker again and select Airslot. Check its name stays at the top of the page in the following steps.',
          ['Open the ', link('YouTube Data API v3 page', 'https://console.cloud.google.com/apis/library/youtube.googleapis.com'), ' and click ', b('Enable'), '.'],
        ),
      },
      {
        title: 'Set up the permission screen',
        intro: null,
        body: steps(
          ['Search for ', b('Google Auth Platform'), ' at the top of the page, and open it.'],
          ['Click ', b('Get started'), '. Name the app ', b('Airslot'), ', pick your email as support, and click ', b('Next'), '.'],
          ['Under ', b('Audience'), ', choose ', b('External'), ' and click ', b('Next'), '. The Internal option is only for Google Workspace. The note about starting in testing mode is normal, and Part 4 changes it.'],
          ['Add your contact email, click ', b('Next'), ', accept the policy, and click ', b('Create'), '.'],
        ),
      },
      {
        title: 'Complete the Branding page',
        intro: 'Google keeps the Publish app button off until this is filled in.',
        body: site
          ? steps(
            ['Open ', b('Branding'), ' in the left menu.'],
            ['Paste these three addresses into the matching fields:',
              h('dl', { class: 'keys' },
                h('dt', {}, 'Application home page'), h('dd', {}, copyRow(`https://${site}/`, 'the home page address')),
                h('dt', {}, 'Application privacy policy link'), h('dd', {}, copyRow(`https://${site}/privacy`, 'the privacy policy address')),
                h('dt', {}, 'Application terms of service link'), h('dd', {}, copyRow(`https://${site}/terms`, 'the terms address')))],
            ['Add ', b(site), ' under ', b('Authorized domains'), '.'],
            ['Check that ', b('Developer contact information'), ' has your email.'],
            ['Click ', b('Save'), '.', dont('upload a logo. Adding one makes Google review the app.')],
          )
          : note(b('The public pages are not switched on yet. '), 'Google needs a home page and privacy policy anyone can open. Use the "Public home page and privacy policy" steps in README.md.'),
      },
      {
        title: 'Publish the app',
        intro: "Don't skip this. While the status stays on Testing, sign-ins expire every 7 days, and YouTube posts fail until people reconnect.",
        body: [
          steps(
            ['Open ', b('Audience'), ' in the left menu.'],
            ['Find ', b('Publishing status'), ' at the top, and click ', b('Publish app'), '. Reload the page if you can\'t see it.'],
            ['In the window that opens, such as ', b('Push to production?'), ', click ', b('Confirm'), '.'],
          ),
          see(b('In production'), ' as the status.'),
          ifSee('that Publish app can\'t be clicked', 'the Branding page is still missing something. Go back to Part 3, then reload this page.'),
        ],
      },
      {
        title: 'Create the OAuth client',
        intro: null,
        body: steps(
          ['Open ', b('Clients'), ' in the left menu, then ', b('Create client'), '.'],
          ['Choose ', b('Web application'), ', and name it ', b('Airslot'), '.'],
          ['Under ', b('Authorized redirect URIs'), ', click ', b('Add URI'), ' and paste this address:',
            copyRow(`${appState.baseUrl}/auth/google/callback`, 'the Google redirect address'),
            dont('put it under Authorized JavaScript origins. Leave that part empty.')],
          ['Click ', b('Create'), ', and save the ', b('Client ID'), ' and ', b('Client Secret'), ' somewhere safe. The secret may only show once.'],
        ),
      },
      {
        title: 'Put the keys on the server',
        intro: 'You now have two values to add.',
        body: serverKeys([
          ['GOOGLE_CLIENT_ID', ['The ', b('Client ID'), ' from Part 5.']],
          ['GOOGLE_CLIENT_SECRET', ['The ', b('Client Secret'), ' from Part 5. This one is secret.']],
        ]),
      },
      {
        title: 'Connect your own channel',
        intro: null,
        body: [
          note('Follow the ', h('a', { href: '#/guide/youtube' }, 'YouTube guide'), ' from Part 1. If it connects, the keys are right.'),
          ifSee('"redirect_uri_mismatch"', 'the address in the OAuth client is different. Copy it from Part 5 again. It has to match exactly.'),
        ],
      },
      {
        title: 'Let other people connect',
        intro: 'Until Google verifies the app, it caps how many people can sign in, and everyone sees the unverified warning.',
        body: bullets(
          ['An unverified app can have up to ', b('100 users'), ' in its lifetime, and that number does not go back down.'],
          ['To remove the cap and the warning, open ', b('Verification Center'), ' in Google Auth Platform and submit the app.'],
          ['Everyone on this server shares one YouTube allowance of ', b('100 uploads a day'), '. Airslot stops new YouTube posts when it runs out. To raise it, apply through the ', link('YouTube quota form', 'https://support.google.com/youtube/contact/yt_api_form'), '.'],
        ),
      },
    ]);
  }

  function problemsGuide() {
    const fix = (seen, why, todo) => h('div', { class: 'fix' },
      h('h3', { class: 'part-sub' }, seen),
      h('p', { class: 'fix-why' }, why),
      h('p', {}, todo));
    return [
      note('Find the message you see. Most problems happen once, while connecting an account.'),
      h('section', { class: 'card part' },
        h('h2', { class: 'card-title' }, 'Connecting Facebook and Instagram'),
        fix('App not active, or the app isn\'t available to you', 'Meta only lets people with a role on the app sign in until the app has passed its review.', isAdmin ? 'Add the person as a tester. See the last part of the Setup: Meta guide.' : 'Ask your admin to add you as a tester, then accept the request at developers.facebook.com/requests.'),
        fix("You don't have any Pages", 'This Facebook account does not run a Page.', 'Create a Page, or ask whoever runs it to give you Full control. See Part 1 of the Facebook & Instagram guide.'),
        fix("You don't have any Instagram accounts, or Create Instagram account", 'The account is still personal, or is not linked to your Page.', "Don't create a new account. Follow Parts 2 and 3 of the Facebook & Instagram guide, then connect again."),
        fix('Meta returned no Facebook Page for this account', 'No Page was chosen during sign-in. This happens when "Opt in to all current and future Pages" was chosen on an account with no Page.', 'Connect again, click Edit previous settings if it appears, and choose Opt in to current Pages only. Your Page must be listed and ticked.'),
        fix('no Instagram account linked to them', 'The Page connected, but Instagram did not.', 'Link Instagram to that Page, then connect again. See Part 3 of the Facebook & Instagram guide.'),
        fix('Instagram is not in the list, though it is linked', 'It may be linked to another Page, or run by another Facebook account.', 'Open Linked accounts on your Page and check which Instagram account it shows.'),
        isAdmin && fix('URL blocked', 'The redirect address was not saved, or has a typo.', 'Paste it again under Valid OAuth Redirect URIs, then click Save changes.'),
        isAdmin && fix('No permissions starting with instagram_', 'The Instagram product may not be on the Meta app yet.', 'Add the Instagram product, then make the configuration again.')),
      h('section', { class: 'card part' },
        h('h2', { class: 'card-title' }, 'Connecting YouTube'),
        fix("Google hasn't verified this app", 'Google shows this until it has verified Airslot.', 'Click Advanced, then Go to Airslot.'),
        fix("This Google account doesn't have a YouTube channel yet", 'The account has no channel.', 'Create the channel first, or sign in with the account that owns it.'),
        fix('Access blocked', 'The Google project may still be on Testing, or may have reached its limit of 100 users.', isAdmin ? 'Open Audience in Google Auth Platform and check the status. See the Setup: Google guide.' : 'Tell your admin.'),
        isAdmin && fix("Publish app can't be clicked", 'The Branding page is not complete.', 'Fill in the home page, privacy policy, and terms links. See Part 3 of the Setup: Google guide.'),
        isAdmin && fix('redirect_uri_mismatch', 'The address in the OAuth client is different.', 'Copy the address from Part 5 of the Setup: Google guide again. It has to match exactly.'),
        isAdmin && fix('People have to reconnect every week', 'The app is still on Testing.', 'Open Audience in Google Auth Platform and click Publish app.')),
      h('section', { class: 'card part' },
        h('h2', { class: 'card-title' }, 'Uploading and scheduling'),
        fix("This file can't be read as a video", 'The file is damaged, or is not really a video.', 'Export it again as MP4.'),
        fix("didn't accept the cover, so it picked its own", 'The platform refused the cover, and the rest of the post went out as planned.', isAdmin
          ? 'Read the reason in the note. YouTube needs a verified channel at youtube.com/verify and may limit custom covers on Shorts. Facebook may need more permissions on the Meta app.'
          : 'Read the reason in the note. YouTube needs a verified channel at youtube.com/verify and may limit custom covers on Shorts. If it mentions permissions, tell your admin.'),
        fix('A switch turns off by itself', 'The video does not fit that platform, for example it is not 9:16, or is over 90 seconds for Facebook.', 'Read the reason under the account name. The other platforms still work.'),
        fix('YouTube title is required', 'The caption and the title are both empty.', 'Fill in the YouTube title.'),
        fix('storage left', 'Your videos have used up your space on the server. Posts already scheduled are not affected.', 'Remove finished posts from the schedule, or wait for them to be removed automatically. Posts that went live stay on the platforms. If you need more space, ask your admin.'),
        isAdmin && fix('The server is out of disk space', 'The server disk is full, whatever each person\'s limit says.', 'Remove old videos, lower some storage limits on the Admin page, or add disk space.'),
        fix("today's YouTube upload allowance", 'Everyone on this server shares one daily allowance.', 'Try YouTube again tomorrow. The other accounts still work.')),
      h('section', { class: 'card part' },
        h('h2', { class: 'card-title' }, 'After scheduling'),
        fix('Access to this account has expired', 'The permission ran out or was removed.', 'Click Reconnect beside the account on the Accounts page, while logged in to the Facebook or Google account that runs it. Then click Retry on the failed post.'),
        fix('Not ready to connect yet', 'The keys are not on the server yet, or Airslot has not restarted since.', isAdmin ? 'Finish the "Put the keys on the server" part of the setup guide, including the restart.' : 'Ask your admin to finish the setup.'),
        fix('A finished post is gone from the schedule', `Airslot removes finished posts and their videos ${appState.retentionDays} ${appState.retentionDays === 1 ? 'day' : 'days'} after their publish time, to save storage.`, 'Nothing changes on the platforms: posts that went live are still there. To post the video again, upload it again.'),
        fix('Retrying', 'A platform had a temporary problem.', 'Wait. Airslot tries a few more times, and shows Failed with the reason if it still does not work.'),
        fix('Missed', 'The publish time passed more than 2 hours ago while the post could not go out.', 'Click Publish now if you still want it, or Cancel if not.'),
        fix('YouTube is still holding the video as private', 'The Google project may need an audit by YouTube.', isAdmin ? 'Apply for the YouTube audit. The video can stay private until this is sorted out.' : 'Tell your admin. The video can stay private until this is sorted out.')),
      h('section', { class: 'card part' },
        h('h2', { class: 'card-title' }, 'Your Airslot account'),
        fix('Forgot your password', 'There is no email on your account to send a reset to.', 'Ask your admin to reset it, then change it on the Profile page.'),
        fix('Your limit of ... left out', 'You have connected as many accounts as you are allowed. Each Facebook Page, Instagram account, and YouTube channel counts as one.', isAdmin ? 'Raise that person\'s limit on the Admin page.' : 'Disconnect an account you no longer use, or ask your admin for a higher limit.'),
        fix('That invite code is not valid', 'Each code works once, and an admin can remove one.', 'Ask your admin for a new code.'),
        fix('This account is turned off', 'An admin turned off your account.', 'Contact your admin.')),
    ];
  }

  const content = {
    meta: metaGuide,
    youtube: youtubeGuide,
    problems: problemsGuide,
    'setup-meta': setupMetaGuide,
    'setup-google': setupGoogleGuide,
  }[section]();

  view.replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, 'Guide'),
      h('p', { class: 'page-sub' }, 'How to connect your accounts, screen by screen.')),
    h('div', { class: 'guide' },
      h('nav', { class: 'subtabs', 'aria-label': 'Guide sections' },
        Object.entries(sections).map(([key, label]) => h('a', {
          href: `#/guide/${key}`,
          'aria-current': key === section ? 'page' : null,
        }, label))),
      content),
  );
}
