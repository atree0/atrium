// Database layer — node:sqlite (built into Node >= 22.5, zero native deps).
// Schema is versioned: `migrate()` applies numbered steps once, so existing
// installations upgrade safely (plain CREATE TABLE IF NOT EXISTS can't).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.ATRIUM_DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const DATA_DIR = dataDir;
export const UPLOAD_DIR = path.join(dataDir, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'atrium.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  status_text   TEXT NOT NULL DEFAULT '',
  status_emoji  TEXT NOT NULL DEFAULT '',
  is_bot        INTEGER NOT NULL DEFAULT 0,
  is_remote     INTEGER NOT NULL DEFAULT 0,       -- shadow user for a federated peer
  remote_url    TEXT,
  remote_id     INTEGER,
  is_deactivated INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  icon       TEXT NOT NULL DEFAULT '',
  allowed_domains TEXT NOT NULL DEFAULT '',      -- comma-separated email domains for auto-join
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  max_uses     INTEGER NOT NULL DEFAULT 0,        -- 0 = unlimited
  uses         INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER,                           -- NULL = never
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  topic        TEXT NOT NULL DEFAULT '',
  purpose      TEXT NOT NULL DEFAULT '',
  is_private   INTEGER NOT NULL DEFAULT 0,
  is_dm        INTEGER NOT NULL DEFAULT 0,
  dm_key       TEXT,                              -- sorted member ids, for DM uniqueness
  is_archived  INTEGER NOT NULL DEFAULT 0,
  is_shared    INTEGER NOT NULL DEFAULT 0,        -- shared with federated workspaces
  fed_origin_url       TEXT,                      -- set on mirrors: server owning the channel
  fed_origin_channel_id INTEGER,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_ws_name
  ON channels(workspace_id, name) WHERE is_dm = 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm_key
  ON channels(workspace_id, dm_key) WHERE is_dm = 1;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  muted        INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  text        TEXT NOT NULL DEFAULT '',
  thread_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  attachments TEXT NOT NULL DEFAULT '[]',         -- JSON array
  mentions    TEXT NOT NULL DEFAULT '[]',         -- JSON array of user ids
  fed_ref     TEXT,                               -- "https://origin/#42" on relayed copies
  edited_at   INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS pins (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by  INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS custom_emoji (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS apps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id   INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  bot_user_id    INTEGER NOT NULL REFERENCES users(id),
  bot_token      TEXT NOT NULL UNIQUE,
  signing_secret TEXT NOT NULL,
  request_url    TEXT NOT NULL DEFAULT '',        -- events API callback
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_subscriptions (
  app_id   INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event    TEXT NOT NULL,
  PRIMARY KEY (app_id, event)
);

CREATE TABLE IF NOT EXISTS slash_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  command     TEXT NOT NULL,                      -- without leading slash
  url         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (app_id, command)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS federation_invites (
  code         TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL
);

-- A connection links one local workspace to one remote Atrium server.
-- token_out: we present it when calling the remote; token_in: we verify it
-- on incoming federation calls. The remote stores the same pair swapped.
CREATE TABLE IF NOT EXISTS federation_connections (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id          INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  remote_url            TEXT NOT NULL,
  remote_workspace_name TEXT NOT NULL DEFAULT '',
  token_out             TEXT NOT NULL,
  token_in              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            INTEGER NOT NULL,
  UNIQUE (workspace_id, remote_url)
);

-- Maps a shared channel (origin or mirror) to its counterpart on each
-- connected remote server.
CREATE TABLE IF NOT EXISTS federation_channel_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  connection_id     INTEGER NOT NULL REFERENCES federation_connections(id) ON DELETE CASCADE,
  remote_channel_id INTEGER NOT NULL,
  UNIQUE (channel_id, connection_id)
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`);

// ---- migrations ------------------------------------------------------------
// Numbered steps for changes CREATE TABLE IF NOT EXISTS can't express
// (columns on pre-existing tables, backfills). Each runs once, in order.
// NOTE: indexes/triggers depending on migrated columns are created AFTER
// migrations, at the bottom of this file.

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, ddl) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const MIGRATIONS = [
  {
    version: 1,
    up() {
      // Columns introduced in schema v2, for databases created before it.
      addColumn('users', 'status_emoji', "TEXT NOT NULL DEFAULT ''");
      addColumn('users', 'is_remote', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('users', 'remote_url', 'TEXT');
      addColumn('users', 'remote_id', 'INTEGER');
      addColumn('users', 'is_deactivated', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('channels', 'is_shared', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('channels', 'fed_origin_url', 'TEXT');
      addColumn('channels', 'fed_origin_channel_id', 'INTEGER');
      addColumn('channel_members', 'starred', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('channel_members', 'muted', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('messages', 'fed_ref', 'TEXT');
    },
  },
  {
    version: 2,
    up() {
      // Databases created before the FTS feature shipped hold messages that
      // were never indexed (the triggers only cover new writes). The FTS
      // table is normally created post-migration, so create it here if this
      // is the first boot of an FTS-capable build, then rebuild the index.
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
               USING fts5(text, content='messages', content_rowid='id')`);
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    },
  },
  {
    version: 3,
    up() {
      // Workspace setting: anyone registering with an email at one of these
      // comma-separated domains joins the workspace automatically.
      addColumn('workspaces', 'allowed_domains', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 4,
    up() {
      // Manual presence: a user who set themselves away renders as such even
      // while connected (isOnline() in realtime.js respects this flag).
      addColumn('users', 'away', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
];

export function migrate() {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up();
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(m.version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} failed: ${err.message}`);
    }
  }
}
migrate();

// Indexes and FTS that depend on migrated columns (must run post-migration).
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_remote
  ON users(remote_url, remote_id) WHERE is_remote = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_fed_mirror
  ON channels(fed_origin_url, fed_origin_channel_id) WHERE fed_origin_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_fed_ref
  ON messages(fed_ref) WHERE fed_ref IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`);

// Prepared-statement helpers. `get`/`all` return plain objects; `run` returns
// the driver's result ({ changes, lastInsertRowid }).
export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

// Multi-write helper: wraps fn in a transaction, rolls back on throw.
export function transaction(fn) {
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

export const now = () => Date.now();

export default db;
