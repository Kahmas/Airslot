# Airslot

[![Tests](https://github.com/Kahmas/Airslot/actions/workflows/test.yml/badge.svg)](https://github.com/Kahmas/Airslot/actions/workflows/test.yml)

Schedule one vertical video to Instagram Reels, Facebook Reels, and YouTube Shorts with one click. TikTok is not included yet.

People sign up with an invite code, a username, and a password, and each person only sees their own accounts, videos, and posts.

## Requirements

- Node.js 22.13 or newer
- FFmpeg (`ffmpeg` and `ffprobe` available from the terminal)

```bash
npm install
```

## Try it without real accounts

Demo mode uses simulated accounts and platforms, so nothing is actually posted.

```bash
npm run demo
```

Open http://localhost:3100 and log in with `demo` and `demo-password`. Demo data is erased each time demo mode restarts.

## Run with real accounts

1. Copy `.env.example` to `.env`.
2. Follow the two sections below to fill in the Meta and Google keys.
3. Start the app, open http://localhost:3000, and create the admin account.

```bash
npm start
```

## People and invite codes

The first account created becomes the admin. It takes over any data from before accounts existed, and it can invite other people from the **Admin** page. When the app is reachable from outside this machine, creating that first account needs the setup code, which is the `APP_PASSWORD` value. The setup code does nothing after that.

| Setting | What it does | Default |
|---|---|---|
| `SIGNUP_OPEN=true` | Lets anyone sign up without an invite code | Off |
| `USER_STORAGE_MB` | The default for how much video each person can keep, in MB. Admin accounts have no limit, and an admin can set a different limit per person on the Admin page. | 10240 |
| `USER_ACCOUNT_LIMIT` | The default for how many accounts each person can connect. Each Facebook Page, Instagram account, and YouTube channel counts as one. Admin accounts have no limit, and an admin can set a different limit per person on the Admin page. | 3 |
| `POST_RETENTION_DAYS` | Days after the publish time before a finished post and its video leave this server. Posts on the platforms are not touched. The privacy policy and terms state 7 days, so update them if you change this. | 7 |

What the app does for you:

- Each invite code creates one account. An admin can remove a code that hasn't been used.
- An admin can turn someone off, which logs them out and pauses their queue. Posts already handed to Facebook or YouTube stay scheduled there. Nothing is deleted.
- An admin can reset someone's password. There is no email on an account, so this is the only way back in for a member.
- If the admin loses their own password, run `sudo /opt/airslot/reset-password USERNAME` on the server. Locally, run `node src/reset-password.js USERNAME`.
- Login attempts are limited per username and per address, and sign-up attempts per address.
- A video that never became a post is removed after about a day, the next time that person starts an upload.
- One login can hold accounts from several Facebook logins and Google accounts. **Use another browser profile** on the Accounts page makes a link to paste into the browser profile where the other account is logged in, so nobody has to log out. It needs no Airslot login there, works once, lasts 15 minutes, and names the Airslot login that receives the account before anything happens. Whoever follows it attaches their account to the person who made it, so it should not be shared. The Guide shows the steps. Past the account limit, a sign-in connects what fits and names what it left out. Connecting an existing account again only refreshes it, so it still works at the limit, and a lower limit leaves connected accounts in place.
- When someone's storage is full, new uploads are refused with a message, and posts already scheduled still go out. A limit lower than what someone already uses keeps their videos and only stops new uploads. The limits can add up to more than the disk holds, so watch the free space shown on the Admin page.

What the platforms require before other people can connect:

- **Meta:** while the app is in Development, only people with a role on it can sign in, and Meta says test posts can only be seen by role users, so check a post from a logged-out browser. Add people as testers. Meta allows your employees or people who agreed to test on your behalf, and most apps can have up to 50. Letting anyone connect needs App Review for the five permissions and Business Verification.
- **Google:** an unverified app can have up to 100 users in its lifetime, and everyone sees a warning. Verification removes both.
- **YouTube:** uploads count against the whole Google project, so everyone on the server shares one allowance. The app stops new YouTube posts once 100 have been created in 24 hours.

### Facebook and Instagram

Account requirements:

- Instagram must be a Business or Creator account, linked to a Facebook Page.
- The Facebook destination must be a Page. The API can't post to personal profiles.

Steps in [Meta for Developers](https://developers.facebook.com/apps) (menu names may differ slightly):

1. Create a Business app.
2. Add the **Facebook Login for Business** product. Direct file uploads are only available through this product.
3. Create a login configuration with these permissions, then copy its ID to `META_CONFIG_ID`:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`
4. Add the redirect URI: `http://localhost:3000/auth/meta/callback`
5. Copy the App ID and App Secret to `META_APP_ID` and `META_APP_SECRET`.
6. In this app, open **Accounts** and click **Connect with Meta**.

Sign in with a Facebook account that has a role (admin, developer, or tester) on the Meta app. According to the [Instagram Platform documentation](https://developers.facebook.com/docs/instagram-platform/overview/), an app that only serves your own accounts only needs Standard Access. App Review and Business Verification apply to Advanced Access, which is for serving other people's accounts.

### YouTube

Steps in [Google Cloud Console](https://console.cloud.google.com):

1. Create a project and enable **YouTube Data API v3**.
2. Set up the OAuth consent screen with the External user type.
3. **Change the publishing status to In production.** While it stays in Testing, [sign-in access expires every 7 days](https://developers.google.com/identity/protocols/oauth2) and scheduled posts fail until you reconnect. Google may warn that the app is unverified when you sign in, which is expected for your own app.
4. Create a Web application OAuth client with the redirect URI `http://localhost:3000/auth/google/callback`
5. Copy the Client ID and Client Secret to `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. In this app, open **Accounts** and click **Connect a YouTube channel**.

The app requests the `youtube.force-ssl` scope, because that one scope covers uploading, checking status, and deleting a video when a post is canceled.

**Risk of videos locked as private.** Google's documentation disagrees with itself about API projects that haven't been audited: the [`videos.insert` reference](https://developers.google.com/youtube/v3/docs/videos/insert) says they aren't restricted, while the [YouTube help page](https://support.google.com/youtube/answer/7300965?hl=en) still describes videos locked as private with no appeal. If this happens, the Schedule page marks the post as failed, and the project needs to apply for a YouTube audit.

## First real test

Schedule one test video about 20 minutes ahead, then check:

- Instagram: the Reel appears on the profile right at the publish time.
- Facebook: the Reel shows as scheduled in Meta Business Suite, then goes live at the publish time.
- YouTube: the video shows as private with a schedule in YouTube Studio, then turns public at the publish time.

If something fails, the platform's message appears on the Schedule page and in the terminal running the app.

## How publishing runs

| Platform | When the video is sent | If the app is off at the publish time |
|---|---|---|
| Instagram | 15 minutes before the publish time, then published on time | Doesn't go out |
| Facebook | Right after scheduling, using Facebook's own scheduler (up to 29 days ahead) | Still goes out, unless it was scheduled less than 11 minutes ahead |
| YouTube | A day before the publish time (right away if sooner), using YouTube's own scheduler | Still goes out, if the app was on when the upload was due |

New post can also **Publish now**. The video then goes to each platform right away and goes live once that platform has processed it. There is no earlier stage to cancel on YouTube, because the video goes public as soon as it is ready.

YouTube also limits how many videos one channel can upload in about 24 hours, Studio uploads included. Uploading a day ahead spreads a week of posts over the week. When the limit still hits, the app tries again every 3 hours and only shows **Failed** when the publish time would pass first.

A post that is less than 2 hours late still goes out as soon as the app is back on. Beyond that it is marked **Missed** and waits for you to press **Publish now**, so content never goes out late without you knowing.

Because Instagram depends on the app running, regular use calls for a server that stays on.

## Running on a server

`deploy/install.sh` sets Airslot up on Ubuntu next to whatever else runs there. It only writes to `/opt/airslot`, `/etc/airslot`, `/var/lib/airslot` and the `airslot.service` unit, creates an `airslot` system user, and adds FFmpeg, curl and xz through apt if they are missing. It uses its own copy of Node and picks a free port between 3180 and 3199.

Build the package on your own machine and copy it over:

```bash
npm run package
```

```
scp airslot.tar.gz USER@SERVER:/tmp/
```

Then on the server:

```
mkdir -p ~/airslot-install && tar -xzf /tmp/airslot.tar.gz -C ~/airslot-install && cd ~/airslot-install
bash deploy/install.sh --check
sudo bash deploy/install.sh --base-url https://airslot.example.com
```

`--check` only reads and changes nothing. The install generates `APP_PASSWORD`, the setup code for the first admin account. The app refuses to start without one when `BASE_URL` isn't this machine, or when `HOST` is set to listen beyond it.

The first time the app starts after being upgraded from a version without accounts, it keeps a copy of the database as `airslot.db.before-users` in the data folder. Queued posts keep running until the admin account is created and takes them over.

| Task | Command |
|---|---|
| See the setup code | `sudo grep '^APP_PASSWORD=' /etc/airslot/airslot.env` |
| Reset a lost password | `sudo /opt/airslot/reset-password USERNAME` |
| Change settings | `sudo nano /etc/airslot/airslot.env`, then restart |
| Restart | `sudo systemctl restart airslot` |
| Check it's running | `systemctl status airslot` |
| Read the log | `journalctl -u airslot -f` |
| Update | Copy and extract a new package, then `sudo bash deploy/install.sh` |

Updates keep the settings and data, and leave the last version in `/opt/airslot/app.previous`.

Add redirect URIs in Meta and Google to match `BASE_URL`, and back up `/var/lib/airslot`. It holds the database, the videos, and `secret.key`. Without `secret.key`, account tokens can't be opened and every account must be reconnected.

### Public home page and privacy policy

Google and Meta need a home page and privacy policy anyone can open without an account. The app can serve those three fixed pages on a second hostname, which reaches nothing else:

```
sudo bash deploy/install.sh --site-host example.com --contact-email you@example.com
```

Route that hostname to the same port through the tunnel. The pages are at `/`, `/privacy`, and `/terms`, written in `site/`. Read them before publishing, because they describe how you run the app and show your contact address publicly.

### With no public IP: Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) lets a server with no public IP take traffic, because `cloudflared` opens the connection outward. No inbound port is needed, and Cloudflare provides the HTTPS.

1. Add your domain to Cloudflare and switch its nameservers to the two Cloudflare gives you. [Keeping your current DNS host](https://developers.cloudflare.com/dns/zone-setups/partial-setup/index/) requires a Business plan.
2. In Cloudflare Zero Trust, create a tunnel and run its install command on the server. Treat the token in that command like a password.
3. Add a published application route to the tunnel, pointing at the port the install printed, such as `http://localhost:3180`.
4. Open the address and create the admin account with the setup code.

Cloudflare Access isn't needed, because the app has its own login. Leaving it on would ask every person for a Cloudflare email code first. While moving an existing install to accounts, keep it on until the admin account works, then remove the Access application.

The app only listens on the server itself unless `HOST` says otherwise, so only `cloudflared` can reach it directly.

`cloudflared` needs [outbound access on port 7844](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/).

Videos upload in 50 MiB pieces, because the Cloudflare Free plan [refuses request bodies over 100 MB](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/). A dropped connection retries the piece rather than restarting the file. Sending videos on from the server to Instagram, Facebook, and YouTube doesn't pass through Cloudflare, so this limit doesn't apply there.

### Without a tunnel

Set `HOST=0.0.0.0` and put HTTPS in front with a reverse proxy, because passwords and session cookies travel over this connection. Login attempt limits then count by the proxy's address, because `CF-Connecting-IP` is only trusted when the app listens locally.

## Covers

New post has a Cover card: let each platform choose, pick a frame, or upload a JPG or PNG up to 8 MB. Covers are saved as a JPEG of at most 1080x1920 and 2 MB, and count toward storage.

| Platform | How the cover is sent | Known limits |
|---|---|---|
| Instagram | A frame as `thumb_offset`. An image as `cover_url`, from a link under `/covers/` that needs no login and closes once no Instagram post needs it. | Instagram must be able to reach `BASE_URL`, so uploaded images don't work on a local install. |
| Facebook | `POST /{video-id}/thumbnails` with `is_preferred`, after the Reel has processed. | Meta's reference lists `pages_read_user_content` and `pages_manage_engagement`, which the Airslot login configuration doesn't request. Whether a Reel needs them is unconfirmed. |
| YouTube | `thumbnails.set`, after the video has processed. | The channel must be verified. YouTube Help says Shorts covers can currently only be added in Studio on a computer, so the API may refuse. The Shorts feed plays the video and shows no cover. |

A refused cover never stops the post. It goes out with the platform's own cover, and the Schedule page shows the reason.

## Video specs that fit every platform

MP4, H.264, AAC audio at 48 kHz, 9:16 (1080x1920), 24 to 60 fps, 3 to 90 seconds, up to 300 MB.

The app checks this on upload. A platform the video doesn't fit is switched off automatically, with the reason shown. Vertical or square videos up to 3 minutes become Shorts on YouTube automatically.

## Tests

```bash
npm test
```

The tests run the real app against the stand-in server in `test/mock-platforms.js`, and need FFmpeg to create sample videos. They show that the app speaks each platform's documented format, not that the platform will accept a given post.

`deploy/install.sh` has its own test, which runs it against fake system commands in a scratch folder:

```bash
npm run test:install
```

Both run on GitHub Actions for every push.

## Project layout

| Path | What it holds |
|---|---|
| `src/` | The server: login, uploads, covers, scheduling, and admin |
| `src/platforms/` | How videos reach Instagram, Facebook, and YouTube |
| `public/` | The app's pages, with no build step |
| `site/` | The public home page, privacy policy, and terms |
| `deploy/` | The Ubuntu install script |
| `scripts/` | Demo mode and the server package builder |
| `test/` | Tests and the stand-in platforms |
| `anti-slop/` | Design decisions and checks for the interface |

Never commit `.env`, `data/`, or `secret.key`. They hold keys, account tokens, and people's videos, and `.gitignore` keeps them out.
