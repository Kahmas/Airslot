import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const USER_TABLES = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    storage_limit_bytes INTEGER,
    account_limit INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users (id),
    created_at INTEGER NOT NULL,
    used_by TEXT REFERENCES users (id),
    used_at INTEGER
  );
`;

const ACCOUNTS_COLUMNS = `
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users (id),
    platform TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at INTEGER,
    needs_reconnect INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, platform, remote_id)
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (${ACCOUNTS_COLUMNS});
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    info TEXT NOT NULL,
    has_thumb INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    user_id TEXT REFERENCES users (id),
    has_cover INTEGER NOT NULL DEFAULT 0,
    cover_size INTEGER NOT NULL DEFAULT 0,
    cover_offset_ms INTEGER,
    cover_token TEXT
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos (id),
    caption TEXT NOT NULL,
    publish_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    user_id TEXT REFERENCES users (id)
  );
  CREATE TABLE IF NOT EXISTS targets (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    platform TEXT NOT NULL,
    caption TEXT NOT NULL,
    title TEXT,
    made_for_kids INTEGER NOT NULL DEFAULT 0,
    publish_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '{}',
    remote_id TEXT,
    remote_url TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS targets_due ON targets (status, next_run_at);
  CREATE INDEX IF NOT EXISTS accounts_user ON accounts (user_id);
  CREATE INDEX IF NOT EXISTS videos_user ON videos (user_id);
  CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
`;

export const ACTIVE_STATUSES = ['waiting', 'uploading', 'processing', 'ready', 'handed_off'];
const ACTIVE_SQL = ACTIVE_STATUSES.map((status) => `'${status}'`).join(',');
const PATCHABLE = new Set(['status', 'stage', 'remote_id', 'remote_url', 'error', 'attempts', 'next_run_at', 'publish_at', 'caption', 'title']);

const TARGET_SELECT = `
  SELECT t.*, v.file_name, v.id AS video_id, v.has_cover, v.cover_offset_ms, v.cover_token, a.name AS account_name, p.user_id AS owner_id
  FROM targets t
  JOIN posts p ON p.id = t.post_id
  JOIN videos v ON v.id = p.video_id
  JOIN accounts a ON a.id = t.account_id
`;

export const coverFile = (videoId) => `${videoId}.cover.jpg`;

// Every file a video leaves on disk, for whoever removes it.
export const videoFiles = (video) => [video.file_name, `${video.id}.jpg`, coverFile(video.id)];

// Thrown when a write loses to a rule the caller reports to the person, such as a taken username.
export class StoreConflict extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function parseTarget(row) {
  return row ? { ...row, stage: JSON.parse(row.stage) } : null;
}

// Databases from before accounts had owners. Rows keep a NULL owner until the first admin claims them.
function migrateToUsers(db, dbPath) {
  const columns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name);
  if (columns.length === 0 || columns.includes('user_id')) return;

  const backup = `${dbPath}.before-users`;
  if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);

  // The foreign key switch only takes effect outside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE accounts_next (${ACCOUNTS_COLUMNS});
      INSERT INTO accounts_next (id, platform, remote_id, name, token, refresh_token, token_expires_at, needs_reconnect, created_at)
        SELECT id, platform, remote_id, name, token, refresh_token, token_expires_at, needs_reconnect, created_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_next RENAME TO accounts;
      ALTER TABLE videos ADD COLUMN user_id TEXT REFERENCES users (id);
      ALTER TABLE posts ADD COLUMN user_id TEXT REFERENCES users (id);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function addColumns(db, table, definitions) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, type] of Object.entries(definitions)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function createStore(dbPath, vault, now = Date.now) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(USER_TABLES);
  // A NULL limit means the server's default applies.
  addColumns(db, 'users', { storage_limit_bytes: 'INTEGER', account_limit: 'INTEGER' });
  migrateToUsers(db, dbPath);
  db.exec(SCHEMA);
  addColumns(db, 'videos', {
    has_cover: 'INTEGER NOT NULL DEFAULT 0',
    cover_size: 'INTEGER NOT NULL DEFAULT 0',
    cover_offset_ms: 'INTEGER',
    cover_token: 'TEXT',
  });

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function insertTargets(postId, publishAt, targets) {
    const stamp = now();
    const insert = db.prepare(`
      INSERT INTO targets (id, post_id, account_id, platform, caption, title, made_for_kids, publish_at, status, next_run_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `);
    for (const target of targets) {
      insert.run(randomUUID(), postId, target.accountId, target.platform, target.caption, target.title ?? null, target.madeForKids ? 1 : 0, publishAt, stamp, stamp);
    }
  }

  function publicAccount(row) {
    return {
      id: row.id,
      platform: row.platform,
      name: row.name,
      needsReconnect: Boolean(row.needs_reconnect),
    };
  }

  function openAccount(row) {
    return row ? { ...row, token: vault.open(row.token), refresh_token: vault.open(row.refresh_token) } : null;
  }

  function insertUser(username, passwordHash, isAdmin) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new StoreConflict('username');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, passwordHash, isAdmin ? 1 : 0, now());
    return id;
  }

  return {
    close: () => db.close(),

    countUsers() {
      return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },

    // The first admin also takes ownership of anything created before accounts had owners.
    createFirstAdmin({ username, passwordHash }) {
      return transaction(() => {
        if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new StoreConflict('setup-done');
        const id = insertUser(username, passwordHash, true);
        for (const table of ['accounts', 'videos', 'posts']) {
          db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(id);
        }
        return id;
      });
    },

    createUser({ username, passwordHash, inviteCode = null }) {
      return transaction(() => {
        const id = insertUser(username, passwordHash, false);
        if (inviteCode != null) {
          const used = db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL').run(id, now(), inviteCode);
          if (used.changes !== 1) throw new StoreConflict('invite');
        }
        return id;
      });
    },

    getUser(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
    },

    getUserByUsername(username) {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null;
    },

    setPasswordHash(userId, passwordHash) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    },

    setUserDisabled(userId, disabled) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
    },

    setStorageLimit(userId, limitBytes) {
      db.prepare('UPDATE users SET storage_limit_bytes = ? WHERE id = ?').run(limitBytes, userId);
    },

    setAccountLimit(userId, limit) {
      db.prepare('UPDATE users SET account_limit = ? WHERE id = ?').run(limit, userId);
    },

    listUsers() {
      return db.prepare(`
        SELECT u.id, u.username, u.is_admin, u.disabled, u.created_at, u.storage_limit_bytes, u.account_limit,
          (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS account_count,
          (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
          (SELECT COALESCE(SUM(v.size + v.cover_size), 0) FROM videos v WHERE v.user_id = u.id) AS used_bytes
        FROM users u ORDER BY u.created_at, u.username
      `).all();
    },

    createSession(tokenHash, userId, expiresAt) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(tokenHash, userId, expiresAt, now());
    },

    // Returns nothing for an expired session or a disabled person, so either one locks out at once.
    getSessionUser(tokenHash) {
      return db.prepare(`
        SELECT u.id, u.username, u.is_admin, u.storage_limit_bytes, u.account_limit, s.expires_at
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
      `).get(tokenHash, now()) ?? null;
    },

    renewSession(tokenHash, expiresAt) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash);
    },

    deleteSession(tokenHash) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    },

    deleteUserSessions(userId, exceptHash = null) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, exceptHash);
    },

    createInvite(code, createdBy) {
      db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').run(code, createdBy, now());
    },

    inviteIsUsable(code) {
      return Boolean(db.prepare('SELECT 1 FROM invites WHERE code = ? AND used_by IS NULL').get(code));
    },

    listInvites() {
      return db.prepare(`
        SELECT i.code, i.created_at, i.used_at, u.username AS used_by_name
        FROM invites i LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.used_by IS NOT NULL, i.created_at DESC
      `).all();
    },

    revokeInvite(code) {
      return db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run(code).changes === 1;
    },

    upsertAccount({ userId, platform, remote_id, name, token, refresh_token = null, token_expires_at = null }) {
      const existing = db.prepare('SELECT id, refresh_token FROM accounts WHERE user_id IS ? AND platform = ? AND remote_id = ?').get(userId, platform, remote_id);
      const sealedRefresh = refresh_token ? vault.seal(refresh_token) : existing?.refresh_token ?? null;
      if (existing) {
        db.prepare('UPDATE accounts SET name = ?, token = ?, refresh_token = ?, token_expires_at = ?, needs_reconnect = 0 WHERE id = ?')
          .run(name, vault.seal(token), sealedRefresh, token_expires_at, existing.id);
        return existing.id;
      }
      const id = randomUUID();
      db.prepare('INSERT INTO accounts (id, user_id, platform, remote_id, name, token, refresh_token, token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, platform, remote_id, name, vault.seal(token), sealedRefresh, token_expires_at, now());
      return id;
    },

    listAccounts(userId) {
      return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY platform, name').all(userId).map(publicAccount);
    },

    countAccounts(userId) {
      return db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(userId).n;
    },

    hasAccount(userId, platform, remoteId) {
      return Boolean(db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND platform = ? AND remote_id = ?').get(userId, platform, remoteId));
    },

    // For the scheduler, which works on behalf of whoever owns the post.
    getAccount(id) {
      return openAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
    },

    getAccountFor(userId, id) {
      return openAccount(db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id, userId));
    },

    // TikTok hands out a new refresh token with every access token, so that one is saved too when given.
    saveAccessToken(id, token, expiresAt, refreshToken = null) {
      if (refreshToken) {
        db.prepare('UPDATE accounts SET token = ?, token_expires_at = ?, refresh_token = ? WHERE id = ?')
          .run(vault.seal(token), expiresAt, vault.seal(refreshToken), id);
      } else {
        db.prepare('UPDATE accounts SET token = ?, token_expires_at = ? WHERE id = ?').run(vault.seal(token), expiresAt, id);
      }
    },

    markNeedsReconnect(id) {
      db.prepare('UPDATE accounts SET needs_reconnect = 1 WHERE id = ?').run(id);
    },

    countActiveTargets(accountId) {
      return db.prepare(`SELECT COUNT(*) AS n FROM targets WHERE account_id = ? AND status IN (${ACTIVE_SQL})`).get(accountId).n;
    },

    deleteAccount(id) {
      transaction(() => {
        db.prepare('DELETE FROM targets WHERE account_id = ?').run(id);
        db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      });
    },

    insertVideo({ id, userId, file_name, original_name, size, info, has_thumb }) {
      db.prepare('INSERT INTO videos (id, user_id, file_name, original_name, size, info, has_thumb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, file_name, original_name, size, JSON.stringify(info), has_thumb ? 1 : 0, now());
    },

    getVideoFor(userId, id) {
      const row = db.prepare('SELECT * FROM videos WHERE id = ? AND user_id = ?').get(id, userId);
      return row ? { ...row, info: JSON.parse(row.info) } : null;
    },

    usedBytes(userId) {
      return db.prepare('SELECT COALESCE(SUM(size + cover_size), 0) AS n FROM videos WHERE user_id = ?').get(userId).n;
    },

    setVideoCover(id, { size, offsetMs, token }) {
      db.prepare('UPDATE videos SET has_cover = 1, cover_size = ?, cover_offset_ms = ?, cover_token = ? WHERE id = ?')
        .run(size, offsetMs, token, id);
    },

    clearVideoCover(id) {
      db.prepare('UPDATE videos SET has_cover = 0, cover_size = 0, cover_offset_ms = NULL, cover_token = NULL WHERE id = ?').run(id);
    },

    videoHasPost(id) {
      return Boolean(db.prepare('SELECT 1 FROM posts WHERE video_id = ?').get(id));
    },

    // The video behind a cover link, only while an Instagram post may still need to fetch it.
    videoForOpenCoverLink(token) {
      return db.prepare(`
        SELECT v.id FROM videos v
        JOIN posts p ON p.video_id = v.id
        JOIN targets t ON t.post_id = p.id
        WHERE v.cover_token = ? AND v.has_cover = 1 AND t.platform = 'instagram' AND t.status IN (${ACTIVE_SQL})
        LIMIT 1
      `).get(token) ?? null;
    },

    // TikTok fetches the video itself. Its link works only while that send is still under way.
    videoForOpenMediaLink(token) {
      return db.prepare(`
        SELECT v.file_name FROM targets t
        JOIN posts p ON p.id = t.post_id
        JOIN videos v ON v.id = p.video_id
        WHERE t.platform = 'tiktok' AND t.status IN ('waiting', 'processing') AND json_extract(t.stage, '$.mediaToken') = ?
        LIMIT 1
      `).get(token) ?? null;
    },

    // Uploaded videos that never made it into a post, such as ones replaced in the form.
    removeUnusedVideos(userId, olderThan) {
      const rows = db.prepare(`
        SELECT v.id, v.file_name FROM videos v
        LEFT JOIN posts p ON p.video_id = v.id
        WHERE v.user_id = ? AND v.created_at < ? AND p.id IS NULL
      `).all(userId, olderThan);
      for (const row of rows) db.prepare('DELETE FROM videos WHERE id = ?').run(row.id);
      return rows;
    },

    createPost({ userId, videoId, caption, publishAt, targets }) {
      const postId = randomUUID();
      transaction(() => {
        db.prepare('INSERT INTO posts (id, user_id, video_id, caption, publish_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(postId, userId, videoId, caption, publishAt, now());
        insertTargets(postId, publishAt, targets);
      });
      return postId;
    },

    // Accounts added to a post that is already on the schedule go out at its publish time.
    addTargets(postId, targets) {
      const { publish_at: publishAt } = db.prepare('SELECT publish_at FROM posts WHERE id = ?').get(postId);
      transaction(() => insertTargets(postId, publishAt, targets));
    },

    updatePost(id, { caption, publishAt }) {
      db.prepare('UPDATE posts SET caption = ?, publish_at = ? WHERE id = ?').run(caption, publishAt, id);
    },

    // Every destination of one post, with what the scheduler needs to act on it.
    postTargetsFull(postId) {
      return db.prepare(`${TARGET_SELECT} WHERE t.post_id = ? ORDER BY t.platform, a.name`).all(postId).map(parseTarget);
    },

    listPosts(userId) {
      const posts = db.prepare(`
        SELECT p.*, v.original_name, v.has_thumb, v.has_cover, v.info
        FROM posts p JOIN videos v ON v.id = p.video_id
        WHERE p.user_id = ?
        ORDER BY p.publish_at
      `).all(userId);
      const targets = db.prepare(`
        SELECT t.*, a.name AS account_name FROM targets t
        JOIN accounts a ON a.id = t.account_id
        JOIN posts p ON p.id = t.post_id
        WHERE p.user_id = ?
        ORDER BY t.platform, a.name
      `).all(userId);
      const byPost = Map.groupBy(targets, (target) => target.post_id);
      return posts.map((post) => ({ ...post, targets: (byPost.get(post.id) ?? []).map(parseTarget) }));
    },

    getPostFor(userId, id) {
      return db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(id, userId) ?? null;
    },

    postTargets(postId) {
      return db.prepare('SELECT status FROM targets WHERE post_id = ?').all(postId);
    },

    // Returns the video record when no other post uses it, so the caller can remove its files.
    deletePost(id) {
      const post = db.prepare('SELECT video_id FROM posts WHERE id = ?').get(id);
      if (!post) return null;
      db.prepare('DELETE FROM posts WHERE id = ?').run(id);
      const others = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE video_id = ?').get(post.video_id).n;
      if (others > 0) return null;
      const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(post.video_id);
      db.prepare('DELETE FROM videos WHERE id = ?').run(post.video_id);
      return video;
    },

    // Posts left with no destination after an account was disconnected.
    emptyPostIds(userId) {
      return db.prepare(`
        SELECT p.id FROM posts p LEFT JOIN targets t ON t.post_id = p.id
        WHERE p.user_id = ? AND t.id IS NULL
      `).all(userId).map((row) => row.id);
    },

    // Posts with nothing left to do on any account, whose latest publish time is before the cutoff.
    expiredPostIds(cutoff) {
      return db.prepare(`
        SELECT t.post_id AS id FROM targets t
        GROUP BY t.post_id
        HAVING MAX(t.publish_at) < ? AND SUM(t.status IN (${ACTIVE_SQL})) = 0
      `).all(cutoff).map((row) => row.id);
    },

    // A disabled person's work pauses here. Their account and data stay in place.
    dueTargets(at, limit) {
      return db.prepare(`
        ${TARGET_SELECT}
        LEFT JOIN users u ON u.id = p.user_id
        WHERE t.status IN (${ACTIVE_SQL}) AND t.next_run_at <= ? AND COALESCE(u.disabled, 0) = 0
        ORDER BY t.next_run_at LIMIT ?
      `).all(at, limit).map(parseTarget);
    },

    getTarget(id) {
      return parseTarget(db.prepare(`${TARGET_SELECT} WHERE t.id = ?`).get(id));
    },

    getTargetFor(userId, id) {
      return parseTarget(db.prepare(`${TARGET_SELECT} WHERE t.id = ? AND p.user_id = ?`).get(id, userId));
    },

    patchTarget(id, patch) {
      const keys = Object.keys(patch).filter((key) => PATCHABLE.has(key));
      const values = keys.map((key) => (key === 'stage' ? JSON.stringify(patch[key]) : patch[key]));
      const assignments = [...keys.map((key) => `${key} = ?`), 'updated_at = ?'].join(', ');
      db.prepare(`UPDATE targets SET ${assignments} WHERE id = ?`).run(...values, now(), id);
    },

    // Counts everything that has aired or will air within 24 hours of `at`, to respect platform caps.
    // A post being moved leaves itself out, since its old time is about to go.
    countNear(accountId, at, windowMs, excludePostId = null) {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM targets
        WHERE account_id = ? AND status NOT IN ('failed', 'canceled', 'missed') AND ABS(publish_at - ?) < ? AND post_id IS NOT ?
      `).get(accountId, at, windowMs, excludePostId).n;
    },

    // YouTube's upload allowance belongs to the whole Google project, so everyone here shares it.
    countYouTubeUploadsSince(since) {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM targets t JOIN posts p ON p.id = t.post_id
        WHERE t.platform = 'youtube' AND t.status != 'canceled' AND p.created_at >= ?
      `).get(since).n;
    },
  };
}
