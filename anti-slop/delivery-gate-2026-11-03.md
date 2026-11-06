# Delivery Gate, 3 November 2026 (redesign)

Reading this as: a video-first publishing app for a small content team, in a crisp contemporary app language, dial ENERGY 2 / RHYTHM 2 / MOTION 2.

The owner asked for a more modern look and let Claude choose the direction. Direction chosen by an AI tends toward default taste, so this has not been tested against the owner's own preference.

## Why each major decision (R-31)

- **Color:** cool graphite neutrals so video stays the most colorful thing on screen, plus one orange-red accent for putting a video on air.
- **Layout:** Schedule is built around "what goes out when, and what failed", so failures sit on top and the day runs down a timeline. New post keeps the video in view beside the form.
- **Typography:** Plus Jakarta Sans, a contemporary geometric sans from Indonesian foundry Tokotype, whose large x-height keeps small status text readable.
- **Spacing:** 16px between related cards, 24 to 32px between regions, so grouping reads without extra rules.
- **Cards:** used because each post is a self-contained unit with its own actions. They vary in role: form sections, timeline posts, and a calendar panel.
- **Icons:** only where a word would be worse: plus on New post, sun and moon on the theme button, chevrons on the month controls. All hand-written inline SVG, not an imported library.
- **Platform marks:** IG, FB, and YT monograms, so status rows scan quickly without reproducing brand logos.
- **Status pills:** real publishing status, always with the word, never color alone.
- **Identity motif:** the rounded 9:16 tile, plus the vertical timeline with its Now marker.
- **Theme:** follows the system with a working toggle. Dark suits video work, but nothing forces it.

## Block 1: Hard Gate

- R-02 PASS: a search for the em dash character across project files returned nothing.
- R-03 PASS: no overflow at 375px or 320px, measured with scrollWidth. Interactive targets under 44px at 375px: 0 on Schedule, New post, and Accounts.
- R-17 PASS: no statistics. The Schedule summary counts the user's real posts.
- R-18 PASS: no testimonials.
- R-23 PASS: the product name, Airslot, was chosen by the owner and is set as text. No logo, avatar, or generated image.
- R-24 PASS: Schedule, Accounts, and New post all exist.
- R-25 PASS: 36 text pairs at 4.5:1 or better and 10 control pairs at 3:1 or better across both themes, measured with a script.
- R-26 PASS: every control has a real action, see the click-through.
- R-27 PASS: empty and error states observed in the browser. The loading state was confirmed by reading the code, because it passes too quickly to observe.
- R-28 PASS: no FAQ.
- R-32 PASS: Tab order follows the visual order with a 2px focus ring, Enter activates controls, Escape closes the dialog.
- R-33 PASS: no script patches source files.
- R-34 PASS: light and dark viewed on Schedule, New post, and Accounts. Toggled by click and by Enter.
- R-35 PASS: the app ran and each control was exercised, see the click-through.
- R-36 PASS: no security, compliance, or performance claims.
- R-37 PASS: direction chosen through the "Claude picks" path, with the warning given.
- R-38 PASS: demo accounts are named as demo, with a demo banner on every page.
- R-39 PASS: pointer cursor on controls, labels on fields, alt on images, one h1, landmarks, lang, a title per page, zoom not blocked. Switches use a native checkbox with role=switch.
- R-40 PASS: images and video carry dimensions, no third-party scripts, no performance number reported (not measured).

## Block 2: Purpose-Gate

- R-01 PASS: no gradients or glow.
- R-04 PASS: four small icons with the reasons above.
- R-06 PASS: typeface reason written above. No wide-tracked uppercase. Monospace only for variable names such as META_APP_ID.
- R-07 PASS: no background pattern.
- R-08 PASS: chevrons only on month navigation, where they indicate direction.
- R-09 PASS: pills carry real status only.
- R-10 PASS: no glassmorphism.
- R-12 PASS: shadow only on the three things that sit above the page: the sticky action bar, the dialog, and toasts.
- R-13 PASS: no glow.
- R-14 PASS: cards differ by role and content.
- R-19 PASS: motion only confirms a state change: control transitions, the switch thumb, and the dialog and toast entrance. Off under prefers-reduced-motion. No scroll effects.
- R-22 PASS: no illustrations. The dashed tile in empty states is the product's own 9:16 motif.

## Block 3: Liveliness

- Dials declared: yes, ENERGY 2 / RHYTHM 2 / MOTION 2.
- Output matches the dials: yes. Short state transitions only, and each page has its own composition.
- One focal point per screen: yes. New post has the tile and the action bar, Schedule has the attention panel or the timeline, Accounts has its list.
- Whitespace as structure: yes.
- One deliberate accent: yes. Orange-red on the two publish actions and the Now marker, today's calendar ring, and the focus ring. Failure uses a separate crimson so it is not confused with the accent.
- Identity motif: yes, the 9:16 tile and the timeline.
- Design Read before building: yes.

## Block 4: Craftsmanship and Quality Locks

- C-1 PASS: decisions have reasons, see above.
- C-2 PASS: no dead controls.
- C-3 PASS: no stat cards or charts. Sections follow what the screens need.
- C-4 PASS: tested at three widths, both themes, error states, and by keyboard.
- C-5 PASS: no claims.
- R-05 PASS: not the sidebar, stat row, and table template.
- R-11 PASS: three radii: 8px controls, 14px cards, 20px video tile. Only status pills and switches are fully round.
- R-15 PASS: specific actions such as "Schedule to 3 accounts" and "Publish now".
- R-16 PASS: no marketing buzzwords.
- R-20 PASS: the timeline and vertical tiles give it character, though the direction is AI-chosen.
- R-21 PASS: follows the system, with a working toggle.
- R-29 PASS: graphite neutrals, one accent, and status colors for green, amber, and crimson.
- R-30 PASS: not a copy of a specific product.
- R-31 PASS: reasons written above.

## UI Skill Checklist

All yes. The accent is limited to the moments listed in Block 3, and every status dot and pill marks a real state. No decorative emoji. No invented numbers.

## Click-through (R-35)

Run in demo mode on port 3100.

- Schedule, Accounts, New post, wordmark: navigate, with the title and current marker updating.
- Pick a file: 91 MB and 23 MB files uploaded and checked.
- Drop a file on the tile: uploaded.
- Cancel upload: returns to the drop area, with no partial file left on the server.
- Connection dropped mid-upload: shows "Connection dropped, retrying..." and finishes. A 95 MB file went in two pieces and arrived intact.
- A file that isn't a video: "This file can't be read as a video", action disabled with "Add a video to continue."
- Horizontal 100-second video: Facebook switched off with three reasons, Instagram and YouTube stay on.
- Replace video: returns to the drop area, and a better file brings Facebook back on.
- Switching pages during an upload: progress and the result still appear.
- Caption: fills the YouTube title and updates the character count.
- Publish time: the date line and action bar update.
- Destination switches: the button count changes, and with none on it disables with "Turn on at least one account."
- Custom caption: expands.
- Schedule to 3 accounts by Enter: goes to Schedule with a toast.
- Empty caption with YouTube on: server answers 422 with the title message, shown as a form error.
- Retry and Publish now: run again, and the attention panel clears.
- Cancel: dialog opens, status becomes Canceled.
- Remove from schedule: dialog opens, the post disappears.
- Calendar day: filters to that day. Show the full schedule: clears the filter.
- Previous and next month: the month title changes.
- Try loading again after a failed load: the error clears and the list returns. A failed background refresh keeps the list and shows a toast.
- Disconnect: dialog opens, the account is removed, and the group shows its empty note. Keep it and Escape: closes without changes.
- Theme button: light and dark, by click and by Enter.
- Connect without keys, in real mode: Accounts explains which values to add.
- Console: only the deliberate 422 and 409 responses, and connection errors from restarting the server during testing.

Guide page, added 4 November 2026, reusing the same tokens and motif:

- Guide in the top menu: opens with the current marker and title updated. Facebook & Instagram, YouTube, Problems: switch sections, and an unknown section falls back to the first.
- How to connect on Accounts: opens the matching guide section.
- Copy with a real click: shows "Copied." and returns focus to the button. The clipboard API was refused in the test pane, and the backup copy command handled it.
- Status line, addresses, and connect buttons checked in four states: demo, connected, keys set, no keys. No "[object" text leaked.
- R-03: no overflow at 375px and 320px, and 0 targets under 44px at 375px on all three sections.
- R-34: viewed in dark and light. R-02: no em dash in `public/guide.js`. R-23: no logos, only text and the existing monograms.

Not clicked: the Open link (hidden in demo mode) and real Meta or Google sign-in (needs the owner's keys). The sign-in flow is covered by `test/api.test.js` against the stand-in server.

## Accounts, added 4 November 2026

Log in, Sign up, Create the admin account, Profile, and Admin. They reuse the same tokens, type, and motif.

Why each decision (R-31):

- **Log in layout:** the form is the only thing to do there, so it is the focal point. The left side uses the product's own 9:16 tile with the Now marker from the schedule, not an illustration. On phones the tile is removed and the form comes first.
- **Accent:** now also on Log in, Create account, and Create admin account, because each is the one main action on its screen. Admin actions such as Create invite code stay neutral, so the accent stays rare inside the app.
- **Top menu:** Profile is a plain tab, because a username in the bar would not fit on a phone beside the New post button.
- **Show password:** a labeled checkbox instead of an eye icon, so it needs no explanation and no extra icon.
- **New password dialog:** the password shows once, with its copy confirmation inside the dialog, because a toast would sit behind the backdrop. The value is cleared from the page on close.

Gate results for these screens:

- R-02 PASS: no em dash in `src`, `public`, `site`, `deploy`, `scripts`, `test`, the README, or `.env.example`.
- R-03 PASS: no overflow at 375px or 320px on Log in, Sign up, Schedule, New post, Accounts, all five Guide sections at 375px and two at 320px, Admin, and Profile, measured with scrollWidth. No control under 44px at 375px, after fixing what the first measurement found: default buttons at 40px, the wordmark at 26px, and auth links at 43px.
- R-25 PASS: `contrast.mjs` reports 0 pairs below threshold. The new screens only use existing token pairs.
- R-26 and R-35 PASS: see the click-through below.
- R-27 PASS: loading, error, and empty states exist on Admin. The empty invite list and failed forms were observed. The Admin loading and load-failure states were confirmed by reading the code, because they pass too quickly to observe.
- R-32 PASS: Tab order on Log in runs username, password, Show password, Log in, Sign up, with a 2px focus ring. Enter submits. Escape closes the dialog. Focus returns to the button after a dialog closes and the list redraws.
- R-34 PASS: viewed in dark and light.
- R-36 PASS: the privacy policy states facts about storage, such as hashed passwords and encrypted tokens, and makes no claim of being secure.
- R-38 PASS: the demo login is labeled as demo mode and only shows in demo mode.
- R-39 PASS: every input has a label, measured in the browser.

Click-through (R-35), in demo mode on port 3100 and on a rehearsal copy of an old database on port 3200:

- Log in with empty fields, a wrong password, then the right one: error, error, Schedule opens.
- Show password: switches the field's type.
- Sign up with a short password, then a long one: error from the server, then the account is created and logged in.
- Invite link `#/signup/CODE`: fills in the code.
- Create invite code: new row, focus stays on the button. Copy link: "Copied." Remove: dialog opens, Escape keeps the code.
- Member view: no Admin tab, `#/admin` goes to Schedule, the server answers 403, and setup guides are hidden even by direct address.
- Reset password: dialog, then the one-time password dialog, then Done clears it and returns focus. The new password logged in.
- Turn off: dialog, "Turned off" pill, and the button becomes Turn on. Turn on: back to normal.
- Change password: wrong current password shows an error, the right one shows a toast and clears the fields.
- Log out: back to Log in, with the menu hidden and the server answering 401.
- Session ended elsewhere: the next request returns to Log in with "Your session ended. Log in again."
- Upload through the page and schedule: worked with the login cookie. Logged in as another person: no posts, no accounts, the video file answers 404, and canceling that post answers 404.
- Rehearsal of the upgrade: a database made by the previous version's own code opens with its accounts and post intact. The setup code screen refuses a wrong code, accepts the right one, and the new admin sees the old accounts, post, and thumbnail.
- Thumbnail after switching people in one browser: this showed the browser's cached copy. Fixed by making the browser check with the server each time, and covered by a test.
- Console: only the deliberate 401, 403, and 422 responses. No server errors.

Detailed guide and Log out move, added the same day:

- Log out moved to the top of Profile, because the owner could not find it at the bottom.
- Each guide gained a Before you start card, a clickable list of parts, and labeled notes under steps: "You should see", "If you see", and "Don't". The label carries the meaning, and color is only a second signal. Measured 5.3:1 or better in both themes.
- The steps come from the screens the owner went through while setting up, including the wrong turns. The tester invitation part has not been walked through by a real second person yet.
- No screenshots of Meta or Google screens, because they go out of date and would reproduce other companies' interfaces (R-23).
- Clicked: Part link in the list (scrolls and moves focus), Log out in its new place. Member view: no setup tabs, the tester part is present, and admin-only problems are hidden.
- R-03: no overflow at 375px and 320px on all five sections and Profile. No control under 44px at 375px. R-02: no em dash.

Log out in the top bar, added the same day: the owner looked for it there, so it sits beside the theme button from 361px up. At 320px there is no room beside New post, so it stays at the top of Profile. Measured with no overflow at 1280, 765, 375, and 320px, and the top bar now wraps at 860px, because at 765px New post was touching the edge. Clicked: logs out and hides itself on the login page.

Found on the live site afterward: the button did nothing and also showed on the login page, because the page was new while the browser kept the old script and stylesheet. Cloudflare rewrites their cache lifetime to 4 hours, and `no-cache` did not change that, as measured with curl. Fixed by serving them from an address that changes with their content.

Storage limits and automatic removal, added the same day:

- Admin: Storage limit opens a dialog with one field. It accepts 5, 1.5, and 1,5, refuses words with a message inside the dialog, and an empty field returns to the default. Focus returns to the button. The row shows "(default limit)" until one is set, and a "Storage full" pill when reached, with the word and not only color.
- Schedule: a finished post shows the date it will be removed, so nothing disappears without warning. Profile, Admin, the Guide, the privacy policy, and the terms all state the 7 days.
- No overflow at 375px on Admin and Schedule. Test pane note: the dialog's close event waits for a rendered frame, so it stalled while the pane was hidden and fired as soon as a frame ran. People can only press the button in a visible page.

Cover card on New post, added 4 November 2026 (click-through in the next section of this list):

- Layout: it sits in the form column instead of under the video, because the video column stays in view while scrolling on a computer, so the preview follows the slider. Phones get a small saved preview in the card, because the video has scrolled away there.
- Controls: labeled radios instead of tabs, a native slider, and a real file input inside a labeled button. All work by keyboard.
- Honesty: the card says Facebook and YouTube may refuse, and that the Shorts feed shows no cover, because those are what the platforms document.
- Clicked in demo mode: Pick a frame by click, then 25 presses of the arrow key on the slider (the video followed to 0:02, and the saved preview matched). Upload an image with a fake PNG (refused, error shown, back to automatic), a 9 MB file (refused in the browser), and a real PNG (preview shown). Scheduling with that image: the schedule shows the cover.
- R-03: no overflow at 375px and 320px in all three modes. No control in the card under 44px at 375px. R-34: viewed in light on a phone width and dark on a computer width. Console: only the deliberate 401, 404, and 415 answers, plus connection errors from restarting the server during testing. No server errors.
- Not clicked: real Instagram, Facebook, and YouTube. Against them, only a real post can show what each one accepts.

Publish now, added 4 November 2026: a second labeled radio in the Publish time card. The date field gives way to one line saying processing can take a few minutes, and the action button changes to "Publish to 3 accounts now". There is no extra confirmation step, because choosing the radio and pressing a button that says "now" are already two deliberate actions.

Account limits, added 5 November 2026: the Admin row gained an Account limit button that reuses the Storage limit dialog, and the row reads "2 of 3 accounts". The Accounts page states the count in its subtitle instead of adding a meter, because it is a small whole number. A group with no accounts drops its connect button when there is no room, since the button could only fail.

Clearer account buttons, added 5 November 2026: the owner pointed out that "Connect with Meta again" could mean either adding or reconnecting. Now a group says "Add another account" or "Add another channel", and "Reconnect" appears only beside an account whose access expired, so each button says what it does. Viewed as a new person, a person with an expired account, and a person at their limit. No overflow at 320px, and no control under 44px.

Use another browser profile, added 5 November 2026: the owner pointed out that people keep accounts in separate browser profiles, and that logging out is a chore. The button makes a link and shows it, so the copy can still be done by hand if the browser refuses, and the confirmation page in the other profile names the receiving login before anything happens. Addresses that depend on who is logged in now show Open and Copy, while the one remaining plain link goes to a form that doesn't. Clicked through in a preview with connecting on: making the link, the confirmation page, Continue, the Connected page, the used link refused, and the first window updating by itself. The first version of the confirmation page spread its text across the screen, seen in a screenshot and fixed. Real Meta and Google sign-in from a second profile not clicked, because that needs the owner's accounts.

Not clicked: the Copy button inside the new password dialog after its last change, the storage bar with a real limit (covered by `test/isolation.test.js`), and real Meta or Google sign-in as a second person, which needs the Meta role and the live server.

TikTok drafts, added 7 November 2026: TikTok only lets a tool like this send a draft to the inbox, so every place that mentions TikTok says the person posts it from the TikTok app, instead of promising a publish time it can't keep. The Accounts page has a TikTok group with the same buttons as the others. New post shows one line under the TikTok switch. On the Schedule page a draft in the inbox reads "In inbox", with the words and not only a color, and has a Copy caption button, because TikTok takes no caption from apps. Cancel there says TikTok can't take a draft back. Viewed in demo mode, with a real post that the stand-in TikTok fetched from the media link and moved to the inbox. No overflow at 320px on Schedule, Accounts, New post, and both TikTok guides. Copy caption is 44px tall. Not clicked: real TikTok sign-in and the TikTok app, which need the owner's TikTok developer app.

TikTok guide from the real screens, 7 November 2026: the owner went through the TikTok setup step by step with screenshots, and the guide now follows what TikTok showed. It needs an organization first, and the app type has to be changed from Mini game. TikTok refuses terms and privacy addresses until the domain is verified. Production won't save without a review video, so everything happens in the sandbox. The video arrives in the Inbox tab of the TikTok app, not under Drafts or in TikTok Studio. A real draft went from Airslot to that inbox, was posted, and showed Published. No overflow at 320px on both TikTok guides and Problems.
