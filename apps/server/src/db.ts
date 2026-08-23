/**
 * Persistence.
 *
 * SQLite via node:sqlite (built into Node 22.5+): real tables and real SQL with
 * zero dependencies and no extra container. Only slow-changing state lives here
 * - users, sessions, tab metadata, permissions, audit. High-frequency data
 * (mouse moves, frames, presence) never touches the disk; see docs/architecture.md.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { id } from './ids.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import type { Role, TabPermission } from '@orbit/protocol';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  created_at: number;
  last_seen_at: number | null;
  last_tab_id: string | null;
  disabled: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

export interface TabRow {
  id: string;
  browser_id: string;
  target_id: string | null;
  label: string | null;
  url: string;
  title: string;
  created_at: number;
  closed_at: number | null;
  created_by: string | null;
}

let db!: DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','user','viewer')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  last_tab_id   TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS browser_instances (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  restarts   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tabs (
  id         TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  target_id  TEXT,
  label      TEXT,
  url        TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at  INTEGER,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS tabs_open ON tabs(closed_at);

CREATE TABLE IF NOT EXISTS tab_users (
  tab_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view','control','admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, user_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT
);

-- One row per URL rather than per visit: a visit counter plus a last-seen time
-- is all the address bar needs to rank suggestions, and it keeps the table small
-- without a pruning job.
CREATE TABLE IF NOT EXISTS history (
  url    TEXT PRIMARY KEY,
  title  TEXT NOT NULL DEFAULT '',
  at     INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS history_at ON history(at);

CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  user_id    TEXT,
  tab_id     TEXT,
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_events(at);
`;

export function openDatabase(): void {
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(SCHEMA);

  // Bootstrap admin on an empty database only, so the env password cannot
  // silently reset a real deployment's credentials on restart.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n === 0) {
    createUser(config.adminUsername, config.adminPassword, 'admin', config.adminUsername);
    log.warn('bootstrapped admin account from environment', { username: config.adminUsername });
  }
  const purged = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
  if (purged) log.info('purged expired sessions', { count: purged });
  log.info('database ready', { path: config.dbPath, users: n || 1 });
}

export function closeDatabase(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
}

// --- users -----------------------------------------------------------------

export function createUser(username: string, password: string, role: Role, displayName?: string): UserRow {
  const row: UserRow = {
    id: id('user'),
    username: username.trim().toLowerCase(),
    display_name: displayName?.trim() || username.trim(),
    password_hash: hashPassword(password),
    role,
    created_at: Date.now(),
    last_seen_at: null,
    last_tab_id: null,
    disabled: 0,
  };
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, created_at, disabled)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(row.id, row.username, row.display_name, row.password_hash, row.role, row.created_at);
  invalidateColorIndex();
  return row;
}

export const getUserByName = (username: string) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase()) as UserRow | undefined;

export const getUser = (userId: string) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

/**
 * Position of each user in creation order, so every user gets a distinct colour.
 * Cached because it is read on every presence broadcast; invalidated whenever
 * the user set changes.
 */
let colorIndexCache: Map<string, number> | null = null;

export function userColorIndex(userId: string): number {
  if (!colorIndexCache) {
    colorIndexCache = new Map();
    const rows = db.prepare('SELECT id FROM users ORDER BY created_at, id').all() as unknown as { id: string }[];
    rows.forEach((r, i) => colorIndexCache!.set(r.id, i));
  }
  return colorIndexCache.get(userId) ?? 0;
}

export const invalidateColorIndex = () => {
  colorIndexCache = null;
};

export const listUsers = () =>
  db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as UserRow[];

export function authenticate(username: string, password: string): UserRow | null {
  const user = getUserByName(username);
  // Verify even when the user is missing: constant-ish work regardless of
  // whether the account exists, so timing does not leak valid usernames.
  const ok = verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.disabled) return null;
  return user;
}

export function setUserPassword(userId: string, password: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // force re-login everywhere
}

export const setUserRole = (userId: string, role: Role) =>
  void db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

export const touchUser = (userId: string, lastTabId: string | null) =>
  void db
    .prepare('UPDATE users SET last_seen_at = ?, last_tab_id = COALESCE(?, last_tab_id) WHERE id = ?')
    .run(Date.now(), lastTabId, userId);

export const deleteUser = (userId: string) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  invalidateColorIndex();
};

// --- sessions --------------------------------------------------------------

export function createSession(userId: string, userAgent?: string, ip?: string): SessionRow {
  const row: SessionRow = {
    id: id('sess'),
    user_id: userId,
    created_at: Date.now(),
    expires_at: Date.now() + config.sessionTtlMs,
    user_agent: userAgent?.slice(0, 255) ?? null,
    ip: ip?.slice(0, 64) ?? null,
  };
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.user_id, row.created_at, row.expires_at, row.user_agent, row.ip);
  return row;
}

export function getSession(sessionId: string): (SessionRow & { user: UserRow }) | null {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    deleteSession(sessionId);
    return null;
  }
  const user = getUser(s.user_id);
  if (!user || user.disabled) return null;
  return { ...s, user };
}

export const deleteSession = (sessionId: string) =>
  void db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

export const deleteUserSessions = (userId: string) =>
  void db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

/** Sliding expiry so an active user is not logged out mid-session. */
export const extendSession = (sessionId: string) =>
  void db
    .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
    .run(Date.now() + config.sessionTtlMs, sessionId);

// --- browser instances -----------------------------------------------------

export function recordBrowserStart(browserId: string): void {
  db.prepare(
    `INSERT INTO browser_instances (id, started_at, status, restarts) VALUES (?, ?, 'running', 0)
     ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, status = 'running',
       restarts = browser_instances.restarts + 1, stopped_at = NULL`,
  ).run(browserId, Date.now());
}

export const recordBrowserStatus = (browserId: string, status: string) =>
  void db
    .prepare('UPDATE browser_instances SET status = ?, stopped_at = CASE WHEN ? IN (\'stopped\',\'crashed\') THEN ? ELSE NULL END WHERE id = ?')
    .run(status, status, Date.now(), browserId);

// --- tabs ------------------------------------------------------------------

export function insertTab(row: {
  id: string;
  browserId: string;
  targetId: string | null;
  label: string | null;
  url: string;
  title: string;
  createdBy: string | null;
}): void {
  db.prepare(
    `INSERT INTO tabs (id, browser_id, target_id, label, url, title, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.browserId, row.targetId, row.label, row.url, row.title, Date.now(), row.createdBy);
}

export const updateTabMeta = (tabId: string, url: string, title: string) =>
  void db.prepare('UPDATE tabs SET url = ?, title = ? WHERE id = ?').run(url, title, tabId);

export const updateTabTarget = (tabId: string, targetId: string | null) =>
  void db.prepare('UPDATE tabs SET target_id = ? WHERE id = ?').run(targetId, tabId);

export const renameTab = (tabId: string, label: string | null) =>
  void db.prepare('UPDATE tabs SET label = ? WHERE id = ?').run(label, tabId);

export const markTabClosed = (tabId: string) => {
  db.prepare('UPDATE tabs SET closed_at = ? WHERE id = ?').run(Date.now(), tabId);
  db.prepare('DELETE FROM tab_users WHERE tab_id = ?').run(tabId);
};

/** Open tabs, used to rebuild the session after a Chromium crash or restart. */
export const listOpenTabs = () =>
  db.prepare('SELECT * FROM tabs WHERE closed_at IS NULL ORDER BY created_at').all() as unknown as TabRow[];

export const getTabRow = (tabId: string) =>
  db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId) as TabRow | undefined;

// --- tab permissions -------------------------------------------------------

export const grantTab = (tabId: string, userId: string, permission: TabPermission) =>
  void db
    .prepare(
      `INSERT INTO tab_users (tab_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tab_id, user_id) DO UPDATE SET permission = excluded.permission`,
    )
    .run(tabId, userId, permission, Date.now());

export const revokeTab = (tabId: string, userId: string) =>
  void db.prepare('DELETE FROM tab_users WHERE tab_id = ? AND user_id = ?').run(tabId, userId);

export const getTabGrant = (tabId: string, userId: string) =>
  (db.prepare('SELECT permission FROM tab_users WHERE tab_id = ? AND user_id = ?').get(tabId, userId) as
    | { permission: TabPermission }
    | undefined)?.permission ?? null;

export const listTabGrants = (tabId: string) =>
  db.prepare('SELECT user_id, permission FROM tab_users WHERE tab_id = ?').all(tabId) as unknown as {
    user_id: string;
    permission: TabPermission;
  }[];

// --- bookmarks -------------------------------------------------------------

export interface BookmarkRow {
  id: string;
  url: string;
  title: string;
  created_at: number;
  created_by: string | null;
}

export function addBookmark(url: string, title: string, userId: string | null): BookmarkRow {
  const row: BookmarkRow = { id: id('bmk'), url, title: title.slice(0, 300), created_at: Date.now(), created_by: userId };
  db.prepare(
    `INSERT INTO bookmarks (id, url, title, created_at, created_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title`,
  ).run(row.id, row.url, row.title, row.created_at, row.created_by);
  return (db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(url) as unknown as BookmarkRow) ?? row;
}

export const listBookmarks = () =>
  db.prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all() as unknown as BookmarkRow[];

export const getBookmarkByUrl = (url: string) =>
  db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(url) as BookmarkRow | undefined;

export const removeBookmark = (bookmarkId: string) =>
  void db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId);

// --- history ---------------------------------------------------------------

/** Upsert a visit. Called on navigation, so it must stay cheap. */
export function recordVisit(url: string, title: string): void {
  if (!url || url === 'about:blank' || url.startsWith('chrome')) return;
  db.prepare(
    `INSERT INTO history (url, title, at, visits) VALUES (?, ?, ?, 1)
     ON CONFLICT(url) DO UPDATE SET
       at = excluded.at,
       visits = history.visits + 1,
       -- Keep the better title: pages often report an empty one mid-load.
       title = CASE WHEN length(excluded.title) > 0 THEN excluded.title ELSE history.title END`,
  ).run(url, title.slice(0, 300), Date.now());
}

export interface HistoryRow {
  url: string;
  title: string;
  at: number;
  visits: number;
}

export const recentHistory = (limit = 100) =>
  db.prepare('SELECT * FROM history ORDER BY at DESC LIMIT ?').all(Math.min(limit, 500)) as unknown as HistoryRow[];

/**
 * Suggestions for the address bar, ranked by visit count then recency - the
 * cheap half of what browsers call frecency, which is enough to put the site you
 * always visit at the top.
 */
/**
 * Escape, rather than strip, LIKE wildcards: stripping turns a query of "%" into
 * an empty pattern that matches every row.
 */
const likePattern = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const searchHistory = (query: string, limit = 8) => {
  const like = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM history WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY visits DESC, at DESC LIMIT ?`,
    )
    .all(like, like, Math.min(limit, 25)) as unknown as HistoryRow[];
};

export const searchBookmarks = (query: string, limit = 5) => {
  const like = likePattern(query);
  return db
    .prepare(
      `SELECT * FROM bookmarks WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(like, like, Math.min(limit, 25)) as unknown as BookmarkRow[];
};

export const clearHistory = () => void db.prepare('DELETE FROM history').run();

/** Most recently closed tab, for "reopen closed tab". */
export const lastClosedTab = () =>
  db.prepare('SELECT * FROM tabs WHERE closed_at IS NOT NULL AND url != \'\' ORDER BY closed_at DESC LIMIT 1').get() as
    | TabRow
    | undefined;

// --- audit -----------------------------------------------------------------

/**
 * Deliberately coarse: logins, tab lifecycle, admin actions and permission
 * changes. Input events are never audited to the database - that would be
 * thousands of writes a second for no forensic value.
 */
export function audit(action: string, ctx: { userId?: string | null; tabId?: string | null; detail?: unknown } = {}): void {
  try {
    db.prepare('INSERT INTO audit_events (id, at, user_id, tab_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('aud'),
      Date.now(),
      ctx.userId ?? null,
      ctx.tabId ?? null,
      action,
      ctx.detail === undefined ? null : JSON.stringify(ctx.detail).slice(0, 2000),
    );
  } catch (err) {
    log.warn('audit write failed', { action, err: err as Error });
  }
}

export const recentAudit = (limit = 100) =>
  db.prepare('SELECT * FROM audit_events ORDER BY at DESC LIMIT ?').all(Math.min(limit, 500)) as unknown as {
    id: string;
    at: number;
    user_id: string | null;
    tab_id: string | null;
    action: string;
    detail: string | null;
  }[];

/** Test hook: run against an in-memory database. */
export function openInMemoryForTests(): void {
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
}
