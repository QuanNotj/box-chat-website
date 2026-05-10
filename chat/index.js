import express from 'express';
import { createServer } from 'node:http';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number.parseInt(process.env.PORT || '2096', 10);
const DB_PATH = process.env.DB_PATH || 'chat.db';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEFAULT_AVATAR =
  'https://i.postimg.cc/S4TFj4Hq/9779bf16-2dd9-4643-8ecb-ada6f07dba37.jpg';
const DEFAULT_BANNER = '';
const MAX_MESSAGE_LENGTH = 1000;
const MAX_BIO_LENGTH = 180;
const MAX_NAME_LENGTH = 32;
const MIN_NAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_NAME_LENGTH = 120;
const MAX_LINK_PREVIEW_BYTES = 260 * 1024;
const LINK_PREVIEW_TIMEOUT_MS = 1200;
const PASSWORD_ITERATIONS = 120000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = 'sha256';
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 8;
const HISTORY_PAGE_SIZE = 40;
const AUTO_MUTE_MS = 30 * 1000;
const MOD_MUTE_MS = 10 * 60 * 1000;
const DEFAULT_STATUS = 'active';
const USER_STATUSES = new Set(['active', 'busy', 'gaming', 'offline', 'invisible']);
const AUTO_MOD_LINK_LIMIT = Number.parseInt(process.env.AUTO_MOD_LINK_LIMIT || '3', 10) || 3;
const AUTO_MOD_EMOJI_LIMIT = Number.parseInt(process.env.AUTO_MOD_EMOJI_LIMIT || '18', 10) || 18;
const DEFAULT_AUTO_MOD_WORDS = [
  'dcm',
  'dm',
  'dmm',
  'dit',
  'dit me',
  'du ma',
  'con cac',
  'clm'
];
const AUTO_MOD_WORDS = (process.env.AUTO_MOD_WORDS || '')
  .split(',')
  .map((word) => word.trim())
  .filter(Boolean);
if (!AUTO_MOD_WORDS.length) {
  AUTO_MOD_WORDS.push(...DEFAULT_AUTO_MOD_WORDS);
}
const NORMALIZED_AUTO_MOD_WORDS = AUTO_MOD_WORDS
  .map((word) => normalizeModerationText(word))
  .filter(Boolean);
const REACTION_EMOJIS = new Set([
  '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '👏', '🙌', '🔥',
  '💯', '🤯', '😱', '🥺', '😆', '😅', '🤔', '🙏', '👌', '😎'
]);

const SELECT_MESSAGE_COLUMNS = `
  id,
  user_id AS userId,
  client_offset AS clientOffset,
  user,
  text,
  image_url AS imageUrl,
  image_name AS imageName,
  image_type AS imageType,
  link_url AS linkUrl,
  link_title AS linkTitle,
  link_description AS linkDescription,
  link_image AS linkImage,
  color,
  avatar,
  created_at AS createdAt,
  deleted_at AS deletedAt,
  deleted_by AS deletedBy,
  deleted_reason AS deletedReason,
  reply_to_id AS replyToId,
  edited_at AS editedAt,
  pinned_at AS pinnedAt,
  pinned_by AS pinnedBy
`;
const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (
    client_offset,
    user_id,
    user,
    text,
    image_url,
    image_name,
    image_type,
    link_url,
    link_title,
    link_description,
    link_image,
    color,
    avatar,
    created_at,
    reply_to_id
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SELECT_LATEST_MESSAGES_SQL = `
  SELECT ${SELECT_MESSAGE_COLUMNS}
  FROM messages
  ORDER BY id DESC
  LIMIT ?
`;
const SELECT_OLDER_MESSAGES_SQL = `
  SELECT ${SELECT_MESSAGE_COLUMNS}
  FROM messages
  WHERE id < ?
  ORDER BY id DESC
  LIMIT ?
`;
const SELECT_MESSAGE_BY_ID_SQL = `
  SELECT ${SELECT_MESSAGE_COLUMNS}
  FROM messages
  WHERE id = ?
`;
const MARK_MESSAGE_DELETED_SQL = `
  UPDATE messages
  SET deleted_at = ?, deleted_by = ?, deleted_reason = 'admin_delete'
  WHERE id = ? AND deleted_at IS NULL
`;
const REVOKE_OWN_MESSAGE_SQL = `
  UPDATE messages
  SET deleted_at = ?, deleted_by = ?, deleted_reason = 'revoke', pinned_at = NULL, pinned_by = NULL
  WHERE id = ? AND user_id = ? AND deleted_at IS NULL
`;
const HARD_CLEAR_CHAT_SQL = `
  DELETE FROM message_edits;
  DELETE FROM message_reactions;
  DELETE FROM messages;
  DELETE FROM sqlite_sequence WHERE name IN ('messages', 'message_reactions', 'message_edits');
`;
const SELECT_PINNED_MESSAGES_SQL = `
  SELECT ${SELECT_MESSAGE_COLUMNS}
  FROM messages
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL
  ORDER BY pinned_at DESC
  LIMIT 5
`;
const SELECT_MEDIA_MESSAGES_SQL = `
  SELECT ${SELECT_MESSAGE_COLUMNS}
  FROM messages
  WHERE image_url IS NOT NULL AND image_url <> '' AND deleted_at IS NULL
  ORDER BY id DESC
  LIMIT ?
`;
const UPDATE_MESSAGE_TEXT_SQL = `
  UPDATE messages
  SET
    text = ?,
    edited_at = ?,
    link_url = ?,
    link_title = ?,
    link_description = ?,
    link_image = ?
  WHERE id = ? AND user_id = ? AND deleted_at IS NULL
`;
const UPDATE_MESSAGE_LINK_PREVIEW_SQL = `
  UPDATE messages
  SET link_url = ?, link_title = ?, link_description = ?, link_image = ?
  WHERE id = ? AND deleted_at IS NULL
`;
const INSERT_MESSAGE_EDIT_SQL = `
  INSERT INTO message_edits (message_id, user_id, old_text, new_text, edited_at)
  VALUES (?, ?, ?, ?, ?)
`;
const SELECT_MESSAGE_EDITS_SQL = `
  SELECT
    id,
    message_id AS messageId,
    user_id AS userId,
    old_text AS oldText,
    new_text AS newText,
    edited_at AS editedAt
  FROM message_edits
  WHERE message_id = ?
  ORDER BY id ASC
`;
const TOGGLE_MESSAGE_PIN_SQL = `
  UPDATE messages
  SET pinned_at = ?, pinned_by = ?
  WHERE id = ? AND deleted_at IS NULL
`;
const INSERT_USER_SQL = `
  INSERT INTO users (
    username,
    username_key,
    password_hash,
    password_salt,
    color,
    avatar,
    banner,
    bio,
    status,
    created_at,
    last_login_at,
    last_active_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SELECT_USER_BY_KEY_SQL = `
  SELECT
    id,
    username,
    username_key AS usernameKey,
    password_hash AS passwordHash,
    password_salt AS passwordSalt,
    color,
    avatar,
    banner,
    bio,
    status,
    muted_until AS mutedUntil,
    created_at AS createdAt,
    last_login_at AS lastLoginAt,
    last_active_at AS lastActiveAt
  FROM users
  WHERE username_key = ?
`;
const SELECT_USER_BY_ID_SQL = `
  SELECT
    id,
    username,
    username_key AS usernameKey,
    password_hash AS passwordHash,
    password_salt AS passwordSalt,
    color,
    avatar,
    banner,
    bio,
    status,
    muted_until AS mutedUntil,
    created_at AS createdAt,
    last_login_at AS lastLoginAt,
    last_active_at AS lastActiveAt
  FROM users
  WHERE id = ?
`;
const UPDATE_USER_LOGIN_SQL = `
  UPDATE users
  SET last_login_at = ?, last_active_at = ?
  WHERE id = ?
`;
const UPDATE_USER_PROFILE_SQL = `
  UPDATE users
  SET username = ?, username_key = ?, color = ?, avatar = ?, banner = ?, bio = ?, status = ?
  WHERE id = ?
`;
const UPDATE_USER_ACTIVITY_SQL = `
  UPDATE users
  SET last_active_at = ?
  WHERE id = ?
`;
const UPDATE_USER_PASSWORD_SQL = `
  UPDATE users
  SET password_hash = ?, password_salt = ?
  WHERE id = ?
`;
const UPDATE_USER_MUTE_SQL = `
  UPDATE users
  SET muted_until = ?
  WHERE id = ?
`;
const UPDATE_MESSAGES_PROFILE_SQL = `
  UPDATE messages
  SET user = ?, color = ?, avatar = ?
  WHERE user_id = ?
`;
const UPSERT_REACTION_SQL = `
  INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(message_id, user_id)
  DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
`;
const DELETE_REACTION_SQL = `
  DELETE FROM message_reactions
  WHERE message_id = ? AND user_id = ? AND emoji = ?
`;
const SELECT_REACTION_SQL = `
  SELECT emoji
  FROM message_reactions
  WHERE message_id = ? AND user_id = ?
`;
const SELECT_USER_MESSAGE_COUNT_SQL = `
  SELECT COUNT(1) AS count
  FROM messages
  WHERE user_id = ?
`;

async function openDatabase() {
  const failures = [];

  try {
    const sqlite3Module = await import('sqlite3');
    const sqliteModule = await import('sqlite');
    const sqlite3 = sqlite3Module.default || sqlite3Module;
    const database = await sqliteModule.open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });

    await database.get('SELECT 1 AS ok');

    return {
      driver: 'sqlite3',
      exec: (sql) => database.exec(sql),
      all: (sql, ...params) => database.all(sql, ...params),
      get: (sql, ...params) => database.get(sql, ...params),
      run: (sql, ...params) => database.run(sql, ...params),
      close: () => database.close()
    };
  } catch (error) {
    failures.push(`sqlite3: ${error.message}`);
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(DB_PATH);

    return {
      driver: 'node:sqlite',
      exec(sql) {
        database.exec(sql);
      },
      all(sql, ...params) {
        return database.prepare(sql).all(...params);
      },
      get(sql, ...params) {
        return database.prepare(sql).get(...params);
      },
      run(sql, ...params) {
        return database.prepare(sql).run(...params);
      },
      close() {
        database.close();
      }
    };
  } catch (error) {
    failures.push(`node:sqlite: ${error.message}`);
  }

  throw new Error(`No usable SQLite driver found. ${failures.join(' | ')}`);
}

const db = await openDatabase();
await db.exec('PRAGMA journal_mode = WAL');
await db.exec('PRAGMA foreign_keys = ON');

async function ensureColumn(table, column, definition) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrateDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      color TEXT,
      avatar TEXT,
      banner TEXT,
      bio TEXT,
      status TEXT,
      muted_until TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      last_active_at TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(message_id, user_id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS message_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      old_text TEXT,
      new_text TEXT,
      edited_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      user TEXT,
      text TEXT,
      color TEXT,
      avatar TEXT
    );
  `);

  await ensureColumn('messages', 'user_id', 'INTEGER');
  await ensureColumn('messages', 'image_url', 'TEXT');
  await ensureColumn('messages', 'image_name', 'TEXT');
  await ensureColumn('messages', 'image_type', 'TEXT');
  await ensureColumn('messages', 'link_url', 'TEXT');
  await ensureColumn('messages', 'link_title', 'TEXT');
  await ensureColumn('messages', 'link_description', 'TEXT');
  await ensureColumn('messages', 'link_image', 'TEXT');
  await ensureColumn('messages', 'created_at', 'TEXT');
  await ensureColumn('messages', 'deleted_at', 'TEXT');
  await ensureColumn('messages', 'deleted_by', 'TEXT');
  await ensureColumn('messages', 'deleted_reason', 'TEXT');
  await ensureColumn('messages', 'reply_to_id', 'INTEGER');
  await ensureColumn('messages', 'edited_at', 'TEXT');
  await ensureColumn('messages', 'pinned_at', 'TEXT');
  await ensureColumn('messages', 'pinned_by', 'TEXT');
  await ensureColumn('users', 'muted_until', 'TEXT');
  await ensureColumn('users', 'banner', 'TEXT');
  await ensureColumn('users', 'bio', 'TEXT');
  await ensureColumn('users', 'status', 'TEXT');
  await ensureColumn('users', 'last_active_at', 'TEXT');

  await db.run(`
    UPDATE messages
    SET created_at = datetime('now')
    WHERE created_at IS NULL OR created_at = ''
  `);

  await db.run(`
    UPDATE users
    SET status = ?
    WHERE status IS NULL OR status = ''
  `, DEFAULT_STATUS);

  await db.run(`
    UPDATE users
    SET last_active_at = COALESCE(last_login_at, created_at, datetime('now'))
    WHERE last_active_at IS NULL OR last_active_at = ''
  `);

  const imageRows = await db.all(`
    SELECT
      id,
      image_name AS imageName,
      image_type AS imageType,
      image_url AS imageUrl
    FROM messages
    WHERE image_url IS NOT NULL AND image_url <> ''
  `);

  for (const row of imageRows) {
    const nextName = normalizeUploadedImageName(row.imageName, row.imageType, row.imageUrl);
    if (row.imageName !== nextName) {
      await db.run('UPDATE messages SET image_name = ? WHERE id = ?', nextName, row.id);
    }
  }
}

await migrateDatabase();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 3 * 1024 * 1024,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000
  }
});

const onlineUsers = new Map();
const admins = new Set();
const typingUsers = new Map();
const rateLimits = new Map();

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return name.slice(0, MAX_NAME_LENGTH);
}

function normalizeAccountName(value) {
  const name = normalizeName(value);
  if (!name || name.length < MIN_NAME_LENGTH) return null;
  return name;
}

function getUsernameKey(username) {
  return String(username || '').normalize('NFC').toLowerCase();
}

function normalizePassword(value) {
  const password = String(value || '');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return password;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(
    password,
    salt,
    PASSWORD_ITERATIONS,
    PASSWORD_KEY_LENGTH,
    PASSWORD_DIGEST
  ).toString('hex');

  return { hash, salt };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.passwordSalt);
  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function clampText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeBio(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_BIO_LENGTH);
}

function normalizeStatus(value, fallback = DEFAULT_STATUS) {
  const status = String(value || '').trim().toLowerCase();
  return USER_STATUSES.has(status) ? status : fallback;
}

function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s:/._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countLinks(value) {
  return (String(value || '').match(/https?:\/\/[^\s<>"']+/gi) || []).length;
}

function countEmojis(value) {
  return (String(value || '').match(/\p{Extended_Pictographic}/gu) || []).length;
}

function hasBlockedWord(normalizedText, word) {
  if (word.includes(' ')) {
    return normalizedText.includes(word);
  }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedText);
}

function moderateText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: true };

  const normalized = normalizeModerationText(raw);
  for (const word of NORMALIZED_AUTO_MOD_WORDS) {
    if (hasBlockedWord(normalized, word)) {
      return { ok: false, error: 'Tin nhắn chứa từ khóa bị chặn bởi auto moderation.' };
    }
  }

  if (countLinks(raw) > AUTO_MOD_LINK_LIMIT) {
    return { ok: false, error: `Tin nhắn có quá nhiều link. Tối đa ${AUTO_MOD_LINK_LIMIT} link.` };
  }

  if (/(.)\1{19,}/u.test(raw)) {
    return { ok: false, error: 'Tin nhắn lặp ký tự quá nhiều.' };
  }

  const emojiCount = countEmojis(raw);
  const compactLength = raw.replace(/\s+/g, '').length;
  if (emojiCount > AUTO_MOD_EMOJI_LIMIT || (emojiCount >= 10 && emojiCount / Math.max(compactLength, 1) > 0.65)) {
    return { ok: false, error: 'Tin nhắn có quá nhiều emoji liên tục.' };
  }

  return { ok: true };
}

function normalizeColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#2f80ed';
}

function normalizeAvatar(value) {
  const avatar = String(value || '').trim();
  if (avatar.length > 500) return DEFAULT_AVATAR;

  try {
    const url = new URL(avatar);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    return DEFAULT_AVATAR;
  }

  return DEFAULT_AVATAR;
}

function normalizeImageUrl(value, fallback = '') {
  const imageUrl = String(value || '').trim();
  if (!imageUrl) return fallback;
  if (imageUrl.length > 500) return fallback;

  try {
    const url = new URL(imageUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  try {
    const url = new URL(match[0].replace(/[),.;!?]+$/, ''));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isBlockedPreviewHost(url) {
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.')
  ) {
    return true;
  }

  const private172 = host.match(/^172\.(\d+)\./);
  return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getMetaContent(html, names = []) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtmlEntities(match[1]);
    }
  }
  return '';
}

function getHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1]) : '';
}

async function readLimitedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return text.slice(0, MAX_LINK_PREVIEW_BYTES);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_LINK_PREVIEW_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try {
    await reader.cancel();
  } catch {
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function buildLinkPreview(text) {
  const url = extractFirstUrl(text);
  if (!url || isBlockedPreviewHost(url)) return null;

  const fallback = {
    url: url.toString(),
    title: url.hostname.replace(/^www\./, ''),
    description: '',
    image: ''
  };

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; NotjChatPreview/1.0)'
      }
    });
    clearTimeout(timeout);
    timeout = null;

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/html')) return fallback;

    const html = await readLimitedText(response);
    const title = clampText(
      getMetaContent(html, ['og:title', 'twitter:title']) || getHtmlTitle(html) || fallback.title,
      140
    );
    const description = clampText(
      getMetaContent(html, ['og:description', 'twitter:description', 'description']),
      220
    );
    const rawImage = getMetaContent(html, ['og:image', 'twitter:image']);
    let image = '';
    if (rawImage) {
      try {
        image = new URL(rawImage, url).toString();
      } catch {
        image = '';
      }
    }

    return {
      url: fallback.url,
      title,
      description,
      image: normalizeImageUrl(image, '')
    };
  } catch {
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getImageExtension(name = '', type = '', url = '') {
  const sourceName = String(name || '').split(/[?#]/)[0];
  const nameMatch = sourceName.match(/\.([a-z0-9]{1,8})$/i);
  const nameExtension = nameMatch ? nameMatch[1].toLowerCase() : '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(nameExtension)) {
    return `.${nameExtension}`;
  }

  const sourceUrl = String(url || '');
  const dataMatch = sourceUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));/i);
  const mime = String(type || dataMatch?.[1] || '').toLowerCase();
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };

  return byMime[mime] || '';
}

function normalizeUploadedImageName(name = '', type = '', url = '') {
  return `quannotj${getImageExtension(name, type, url)}`.slice(0, MAX_IMAGE_NAME_LENGTH);
}

function normalizeMessageImage(value) {
  if (!value) return { ok: true, image: null };

  const imageUrl = String(value.url || value.imageUrl || '').trim();
  const match = imageUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    return { ok: false, error: 'Anh gui len khong hop le.' };
  }

  const base64 = match[2];
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Anh toi da 1.5MB.' };
  }

  const imageType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const imageName = normalizeUploadedImageName(value.name, imageType, imageUrl);

  return {
    ok: true,
    image: {
      url: imageUrl,
      name: imageName,
      type: imageType
    }
  };
}

function normalizeReplyId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return id;
}

function toPublicMessage(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    userId: row.userId ? Number(row.userId) : null,
    clientOffset: row.clientOffset || null,
    user: row.user || 'Khach',
    text: row.deletedAt ? 'Tin nhan da bi xoa' : row.text || '',
    imageUrl: row.deletedAt ? null : row.imageUrl || null,
    imageName: row.deletedAt ? null : row.imageName || null,
    imageType: row.deletedAt ? null : row.imageType || null,
    linkPreview: row.deletedAt || !row.linkUrl ? null : {
      url: row.linkUrl,
      title: row.linkTitle || row.linkUrl,
      description: row.linkDescription || '',
      image: row.linkImage || ''
    },
    color: normalizeColor(row.color),
    avatar: normalizeAvatar(row.avatar),
    createdAt: row.createdAt || new Date().toISOString(),
    deletedAt: row.deletedAt || null,
    deletedBy: row.deletedBy || null,
    deletedReason: row.deletedReason || null,
    replyToId: row.replyToId ? Number(row.replyToId) : null,
    editedAt: row.editedAt || null,
    pinnedAt: row.pinnedAt || null,
    pinnedBy: row.pinnedBy || null,
    reactions: []
  };
}

function toPublicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    color: normalizeColor(row.color),
    avatar: normalizeAvatar(row.avatar),
    banner: normalizeImageUrl(row.banner, DEFAULT_BANNER),
    bio: normalizeBio(row.bio),
    status: normalizeStatus(row.status),
    createdAt: row.createdAt || null,
    mutedUntil: row.mutedUntil || null,
    lastActiveAt: row.lastActiveAt || row.lastLoginAt || row.createdAt || null
  };
}

function setAuthenticatedSocket(socket, user) {
  socket.data.user = toPublicUser(user);
  const now = new Date().toISOString();
  socket.data.user.lastActiveAt = now;
  onlineUsers.set(socket.id, {
    id: socket.id,
    userId: socket.data.user.id,
    name: socket.data.user.username,
    color: socket.data.user.color,
    avatar: socket.data.user.avatar,
    banner: socket.data.user.banner,
    bio: socket.data.user.bio,
    status: socket.data.user.status,
    lastActiveAt: now,
    mutedUntil: socket.data.user.mutedUntil || null
  });
  emitPresence();
}

function getOnlinePayload() {
  const usersByAccount = new Map();
  const statusPriority = {
    active: 5,
    gaming: 4,
    busy: 3,
    offline: 2,
    invisible: 1
  };

  for (const user of onlineUsers.values()) {
    if (user.status === 'invisible') continue;

    const current = usersByAccount.get(user.userId);
    if (current) {
      current.isAdmin = current.isAdmin || admins.has(user.id);
      if ((statusPriority[user.status] || 0) > (statusPriority[current.status] || 0)) {
        current.status = user.status;
      }
      if (String(user.lastActiveAt || '') > String(current.lastActiveAt || '')) {
        current.lastActiveAt = user.lastActiveAt;
      }
      continue;
    }

    usersByAccount.set(user.userId, {
      id: user.id,
      userId: user.userId,
      name: user.name,
      color: user.color,
      avatar: user.avatar,
      banner: user.banner || DEFAULT_BANNER,
      bio: user.bio || '',
      status: normalizeStatus(user.status),
      lastActiveAt: user.lastActiveAt || null,
      mutedUntil: user.mutedUntil || null,
      isAdmin: admins.has(user.id)
    });
  }

  return Array.from(usersByAccount.values());
}

function emitPresence() {
  io.emit('presence:update', getOnlinePayload());
}

function stopTyping(socket) {
  if (typingUsers.delete(socket.id)) {
    socket.broadcast.emit('typing', Array.from(typingUsers.values()));
  }
}

function checkRateLimit(socketId) {
  const now = Date.now();
  const hits = (rateLimits.get(socketId) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );
  hits.push(now);
  rateLimits.set(socketId, hits);
  return hits.length <= RATE_LIMIT_MAX;
}

function getMuteUntil(user) {
  const timestamp = user?.mutedUntil ? Date.parse(user.mutedUntil) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMuted(user) {
  return getMuteUntil(user) > Date.now();
}

function formatMuteMessage(user) {
  const seconds = Math.max(1, Math.ceil((getMuteUntil(user) - Date.now()) / 1000));
  return `Ban dang bi tam khoa chat. Thu lai sau ${seconds} giay.`;
}

async function setUserMute(userId, untilIso) {
  await db.run(UPDATE_USER_MUTE_SQL, untilIso, userId);
  for (const [socketId, user] of onlineUsers) {
    if (user.userId === userId) {
      user.mutedUntil = untilIso;
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket?.data?.user) {
        targetSocket.data.user.mutedUntil = untilIso;
      }
    }
  }
  emitPresence();
}

function touchSocketActivity(socket, persist = false) {
  const account = socket.data.user;
  if (!account?.id) return;

  const now = new Date().toISOString();
  account.lastActiveAt = now;
  const onlineUser = onlineUsers.get(socket.id);
  if (onlineUser) {
    onlineUser.lastActiveAt = now;
  }

  if (persist) {
    try {
      const result = db.run(UPDATE_USER_ACTIVITY_SQL, now, account.id);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.error(error);
        });
      }
    } catch (error) {
      console.error(error);
    }
  }
}

function normalizeEmoji(value) {
  const emoji = String(value || '').trim();
  return REACTION_EMOJIS.has(emoji) ? emoji : null;
}

function getLastInsertId(result) {
  return Number(result?.lastID ?? result?.lastInsertRowid);
}

function getChangeCount(result) {
  return Number(result?.changes || 0);
}

function isUniqueConstraint(error) {
  return (
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error?.code === 'SQLITE_CONSTRAINT' ||
    error?.errno === 19 ||
    String(error?.message || '').includes('UNIQUE constraint failed')
  );
}

function ackError(ack, message) {
  if (typeof ack === 'function') {
    ack({ ok: false, error: message });
  }
}

function ackSuccess(ack, payload = {}) {
  if (typeof ack === 'function') {
    ack({ ok: true, ...payload });
  }
}

async function getReactionSummary(messageId) {
  return db.all(
    `
      SELECT emoji, COUNT(1) AS count
      FROM message_reactions
      WHERE message_id = ?
      GROUP BY emoji
      ORDER BY count DESC, emoji ASC
    `,
    messageId
  );
}

async function attachReactions(messages) {
  if (!messages.length) return messages;
  const ids = messages
    .map((message) => Number(message.id))
    .filter((id) => Number.isSafeInteger(id));
  if (!ids.length) return messages;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all(
    `
      SELECT message_id AS messageId, emoji, COUNT(1) AS count
      FROM message_reactions
      WHERE message_id IN (${placeholders})
      GROUP BY message_id, emoji
      ORDER BY message_id ASC, count DESC, emoji ASC
    `,
    ...ids
  );
  const byMessage = new Map();
  for (const row of rows) {
    const messageId = Number(row.messageId);
    const reactions = byMessage.get(messageId) || [];
    reactions.push({ emoji: row.emoji, count: Number(row.count) });
    byMessage.set(messageId, reactions);
  }
  for (const message of messages) {
    message.reactions = byMessage.get(Number(message.id)) || [];
  }
  return messages;
}

async function getPublicMessageById(messageId) {
  const row = await db.get(SELECT_MESSAGE_BY_ID_SQL, messageId);
  const message = toPublicMessage(row);
  if (!message) return null;
  await attachReactions([message]);
  return message;
}

async function hydrateMessageLinkPreview(messageId, text) {
  try {
    const preview = await buildLinkPreview(text);
    if (!preview) return;

    await db.run(
      UPDATE_MESSAGE_LINK_PREVIEW_SQL,
      preview.url || null,
      preview.title || null,
      preview.description || null,
      preview.image || null,
      messageId
    );

    const message = await getPublicMessageById(messageId);
    if (message) {
      io.emit('message:edited', message);
    }
  } catch (error) {
    console.error(error);
  }
}

function buildHistoryPage(rows) {
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(0, HISTORY_PAGE_SIZE).reverse();
  const messages = pageRows.map(toPublicMessage);

  return {
    messages,
    hasMore,
    oldestId: messages[0]?.id || null,
    newestId: messages[messages.length - 1]?.id || null
  };
}

async function sendInitialHistory(socket) {
  const rows = await db.all(SELECT_LATEST_MESSAGES_SQL, HISTORY_PAGE_SIZE + 1);
  const page = buildHistoryPage(rows);
  await attachReactions(page.messages);
  socket.emit('history:page', {
    mode: 'initial',
    ...page
  });

  const pinnedRows = await db.all(SELECT_PINNED_MESSAGES_SQL);
  const pinned = pinnedRows.map(toPublicMessage);
  await attachReactions(pinned);
  socket.emit('pin:list', pinned);
}

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

io.on('connection', async (socket) => {
  socket.emit('server:config', {
    adminEnabled: Boolean(ADMIN_PASSWORD),
    maxMessageLength: MAX_MESSAGE_LENGTH
  });
  socket.emit('presence:update', getOnlinePayload());

  socket.on('auth:register', async (payload = {}, ack) => {
    const username = normalizeAccountName(payload.username);
    const password = normalizePassword(payload.password);

    if (!username) {
      ackError(ack, `Ten dang nhap can tu ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} ky tu.`);
      return;
    }

    if (!password) {
      ackError(ack, `Mat khau can tu ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} ky tu.`);
      return;
    }

    const usernameKey = getUsernameKey(username);
    const now = new Date().toISOString();
    const { hash, salt } = hashPassword(password);

    try {
      const result = await db.run(
        INSERT_USER_SQL,
        username,
        usernameKey,
        hash,
        salt,
        normalizeColor(payload.color),
        normalizeAvatar(payload.avatar),
        DEFAULT_BANNER,
        '',
        DEFAULT_STATUS,
        now,
        now,
        now
      );
      const user = await db.get(SELECT_USER_BY_ID_SQL, getLastInsertId(result));
      setAuthenticatedSocket(socket, user);
      await sendInitialHistory(socket);
      ackSuccess(ack, { user: socket.data.user });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        ackError(ack, 'Ten dang nhap da ton tai.');
        return;
      }

      console.error(error);
      ackError(ack, 'Khong tao duoc tai khoan.');
    }
  });

  socket.on('auth:login', async (payload = {}, ack) => {
    const username = normalizeAccountName(payload.username);
    const password = normalizePassword(payload.password);

    if (!username || !password) {
      ackError(ack, 'Ten dang nhap hoac mat khau khong hop le.');
      return;
    }

    try {
      const user = await db.get(SELECT_USER_BY_KEY_SQL, getUsernameKey(username));
      if (!user || !verifyPassword(password, user)) {
        ackError(ack, 'Sai ten dang nhap hoac mat khau.');
        return;
      }

      const now = new Date().toISOString();
      await db.run(UPDATE_USER_LOGIN_SQL, now, now, user.id);
      setAuthenticatedSocket(socket, user);
      await sendInitialHistory(socket);
      ackSuccess(ack, { user: socket.data.user });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong dang nhap duoc.');
    }
  });

  socket.on('history:before', async (oldestId, ack) => {
    if (!socket.data.user) {
      ackError(ack, 'Hay dang nhap truoc khi xem lich su.');
      return;
    }

    const beforeId = Number.parseInt(oldestId, 10);
    if (!Number.isSafeInteger(beforeId) || beforeId < 1) {
      ackError(ack, 'Moc lich su khong hop le.');
      return;
    }

    try {
      const rows = await db.all(
        SELECT_OLDER_MESSAGES_SQL,
        beforeId,
        HISTORY_PAGE_SIZE + 1
      );
      const page = buildHistoryPage(rows);
      await attachReactions(page.messages);
      ackSuccess(ack, page);
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong tai duoc tin nhan cu.');
    }
  });

  socket.on('user:profile', async (payload = {}, ack) => {
    if (!socket.data.user) {
      ackError(ack, 'Hay dang nhap truoc khi xem profile.');
      return;
    }

    const userId = Number.parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      ackError(ack, 'Profile khong hop le.');
      return;
    }

    try {
      const user = await db.get(SELECT_USER_BY_ID_SQL, userId);
      if (!user) {
        ackError(ack, 'Khong tim thay profile.');
        return;
      }

      const online = getOnlinePayload().find((item) => Number(item.userId) === Number(userId));
      const messageStats = await db.get(SELECT_USER_MESSAGE_COUNT_SQL, userId);
      const publicUser = toPublicUser(user);
      ackSuccess(ack, {
        user: {
          ...publicUser,
          status: online?.status || publicUser.status,
          lastActiveAt: online?.lastActiveAt || publicUser.lastActiveAt,
          messageCount: Number(messageStats?.count || 0),
          isOnline: Boolean(online && online.status !== 'offline'),
          isAdmin: Boolean(online?.isAdmin)
        }
      });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong tai duoc profile.');
    }
  });

  socket.on('media:list', async (_payload = {}, ack) => {
    if (!socket.data.user) {
      ackError(ack, 'Hay dang nhap truoc khi xem gallery.');
      return;
    }

    try {
      const rows = await db.all(SELECT_MEDIA_MESSAGES_SQL, 180);
      const messages = rows.map(toPublicMessage);
      ackSuccess(ack, { messages });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong tai duoc gallery anh.');
    }
  });

  socket.on('account:update', async (payload = {}, ack) => {
    const account = socket.data.user;
    if (!account) {
      ackError(ack, 'Hay dang nhap truoc khi cap nhat tai khoan.');
      return;
    }

    const username = normalizeAccountName(payload.username || account.username);
    if (!username) {
      ackError(ack, `Ten can tu ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} ky tu.`);
      return;
    }

    const usernameKey = getUsernameKey(username);
    const color = normalizeColor(payload.color || account.color);
    const avatar = normalizeAvatar(payload.avatar || account.avatar);
    const banner = normalizeImageUrl(
      payload.banner === undefined ? account.banner : payload.banner,
      DEFAULT_BANNER
    );
    const bio = normalizeBio(payload.bio ?? account.bio);
    const status = normalizeStatus(payload.status ?? account.status);
    const newPassword = payload.newPassword ? normalizePassword(payload.newPassword) : null;

    if (payload.newPassword && !newPassword) {
      ackError(ack, `Mat khau moi can tu ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} ky tu.`);
      return;
    }

    try {
      const user = await db.get(SELECT_USER_BY_ID_SQL, account.id);
      if (!user) {
        ackError(ack, 'Khong tim thay tai khoan.');
        return;
      }

      if (usernameKey !== user.usernameKey) {
        const existingUser = await db.get(SELECT_USER_BY_KEY_SQL, usernameKey);
        if (existingUser && Number(existingUser.id) !== Number(account.id)) {
          ackError(ack, 'Username da ton tai.');
          return;
        }
      }

      if (newPassword) {
        const currentPassword = normalizePassword(payload.currentPassword);
        if (!currentPassword || !verifyPassword(currentPassword, user)) {
          ackError(ack, 'Mat khau hien tai khong dung.');
          return;
        }
        const { hash, salt } = hashPassword(newPassword);
        await db.run(UPDATE_USER_PASSWORD_SQL, hash, salt, account.id);
      }

      await db.run(UPDATE_USER_PROFILE_SQL, username, usernameKey, color, avatar, banner, bio, status, account.id);
      await db.run(UPDATE_MESSAGES_PROFILE_SQL, username, color, avatar, account.id);
      const updatedUser = await db.get(SELECT_USER_BY_ID_SQL, account.id);
      const publicUser = toPublicUser(updatedUser);

      for (const [socketId, user] of onlineUsers) {
        if (user.userId === account.id) {
          user.name = publicUser.username;
          user.color = publicUser.color;
          user.avatar = publicUser.avatar;
          user.banner = publicUser.banner;
          user.bio = publicUser.bio;
          user.status = publicUser.status;
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket?.data?.user) {
            targetSocket.data.user = publicUser;
          }
        }
      }

      emitPresence();
      io.emit('account:updated', publicUser);
      ackSuccess(ack, { user: publicUser });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong cap nhat duoc tai khoan.');
    }
  });

  socket.on('chat message', async (data = {}, clientOffset, ack) => {
    const account = socket.data.user;
    const text = normalizeText(data.text);
    const imageResult = normalizeMessageImage(data.image);

    if (!account) {
      ackError(ack, 'Hay dang nhap truoc khi chat.');
      return;
    }

    if (isMuted(account)) {
      ackError(ack, formatMuteMessage(account));
      return;
    }

    if (!imageResult.ok) {
      ackError(ack, imageResult.error);
      return;
    }

    if (!text && !imageResult.image) {
      ackError(ack, 'Tin nhan dang trong.');
      return;
    }

    const moderation = moderateText(text || '');
    if (!moderation.ok) {
      ackError(ack, moderation.error);
      return;
    }

    if (!checkRateLimit(socket.id)) {
      const mutedUntil = new Date(Date.now() + AUTO_MUTE_MS).toISOString();
      await setUserMute(account.id, mutedUntil);
      socket.emit('moderation:muted', { mutedUntil, reason: 'Gui tin qua nhanh' });
      ackError(ack, 'Ban dang gui qua nhanh nen bi tam khoa chat 30 giay.');
      return;
    }

    const createdAt = new Date().toISOString();
    const replyToId = normalizeReplyId(data.replyToId);
    const safeClientOffset = String(clientOffset || `${socket.id}-${createdAt}`).slice(0, 120);
    touchSocketActivity(socket, true);

    try {
      const result = await db.run(
        INSERT_MESSAGE_SQL,
        safeClientOffset,
        account.id,
        account.username,
        text,
        imageResult.image?.url || null,
        imageResult.image?.name || null,
        imageResult.image?.type || null,
        null,
        null,
        null,
        null,
        account.color,
        account.avatar,
        createdAt,
        replyToId
      );
      const message = await getPublicMessageById(getLastInsertId(result));

      io.emit('chat message', message, message.id);
      ackSuccess(ack, { message });
      stopTyping(socket);
      if (text) {
        hydrateMessageLinkPreview(message.id, text);
      }
    } catch (error) {
      if (isUniqueConstraint(error)) {
        ackSuccess(ack);
        return;
      }

      console.error(error);
      ackError(ack, 'Khong the luu tin nhan.');
    }
  });

  socket.on('typing', (name) => {
    const profile = socket.data.user;
    const typingName = profile ? normalizeName(name || profile.username) : null;
    if (profile) {
      touchSocketActivity(socket);
    }

    if (typingName) {
      typingUsers.set(socket.id, {
        id: socket.id,
        name: typingName
      });
    } else {
      typingUsers.delete(socket.id);
    }

    socket.broadcast.emit('typing', Array.from(typingUsers.values()));
  });

  socket.on('message:edit', async (payload = {}, ack) => {
    const account = socket.data.user;
    if (!account) {
      ackError(ack, 'Hay dang nhap truoc khi sua tin nhan.');
      return;
    }

    const id = Number.parseInt(payload.id, 10);
    const text = normalizeText(payload.text);
    if (!Number.isSafeInteger(id) || id < 1 || !text) {
      ackError(ack, 'Tin nhan sua khong hop le.');
      return;
    }

    const moderation = moderateText(text);
    if (!moderation.ok) {
      ackError(ack, moderation.error);
      return;
    }

    try {
      const existingMessage = await db.get(SELECT_MESSAGE_BY_ID_SQL, id);
      if (!existingMessage || existingMessage.deletedAt) {
        ackError(ack, 'Khong tim thay tin nhan.');
        return;
      }
      if (Number(existingMessage.userId) !== Number(account.id)) {
        ackError(ack, 'Chi chu tin nhan moi duoc sua tin nay.');
        return;
      }
      if (String(existingMessage.text || '') === text) {
        ackError(ack, 'Noi dung moi trung voi noi dung cu.');
        return;
      }

      const editedAt = new Date().toISOString();
      await db.run(
        INSERT_MESSAGE_EDIT_SQL,
        id,
        account.id,
        existingMessage.text || '',
        text,
        editedAt
      );
      const result = await db.run(
        UPDATE_MESSAGE_TEXT_SQL,
        text,
        editedAt,
        null,
        null,
        null,
        null,
        id,
        account.id
      );
      if (!getChangeCount(result)) {
        ackError(ack, 'Chi chu tin nhan moi duoc sua tin nay.');
        return;
      }

      const message = await getPublicMessageById(id);
      io.emit('message:edited', message);
      ackSuccess(ack, { message });
      hydrateMessageLinkPreview(id, text);
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong sua duoc tin nhan.');
    }
  });

  socket.on('message:editHistory', async (messageId, ack) => {
    if (!socket.data.user) {
      ackError(ack, 'Hay dang nhap truoc khi xem lich su sua.');
      return;
    }

    const id = Number.parseInt(messageId, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      ackError(ack, 'Tin nhan khong hop le.');
      return;
    }

    try {
      const message = await db.get(SELECT_MESSAGE_BY_ID_SQL, id);
      if (!message) {
        ackError(ack, 'Khong tim thay tin nhan.');
        return;
      }

      const rows = await db.all(SELECT_MESSAGE_EDITS_SQL, id);
      ackSuccess(ack, {
        edits: rows.map((row) => ({
          id: Number(row.id),
          messageId: Number(row.messageId),
          oldText: row.oldText || '',
          newText: row.newText || '',
          editedAt: row.editedAt
        }))
      });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong tai duoc lich su sua.');
    }
  });

  socket.on('message:react', async (payload = {}, ack) => {
    const account = socket.data.user;
    if (!account) {
      ackError(ack, 'Hay dang nhap truoc khi tha reaction.');
      return;
    }

    const messageId = Number.parseInt(payload.messageId, 10);
    const emoji = normalizeEmoji(payload.emoji);
    if (!Number.isSafeInteger(messageId) || messageId < 1 || !emoji) {
      ackError(ack, 'Reaction khong hop le.');
      return;
    }

    try {
      const message = await db.get(SELECT_MESSAGE_BY_ID_SQL, messageId);
      if (!message || message.deletedAt) {
        ackError(ack, 'Khong tim thay tin nhan.');
        return;
      }

      const existing = await db.get(SELECT_REACTION_SQL, messageId, account.id);
      if (existing?.emoji === emoji) {
        await db.run(DELETE_REACTION_SQL, messageId, account.id, emoji);
      } else {
        await db.run(
          UPSERT_REACTION_SQL,
          messageId,
          account.id,
          emoji,
          new Date().toISOString()
        );
      }

      const reactions = await getReactionSummary(messageId);
      io.emit('message:reactions', { messageId, reactions });
      ackSuccess(ack, { messageId, reactions });
    } catch (error) {
      console.error(error);
      ackError(ack, 'Khong tha duoc reaction.');
    }
  });

  socket.on('admin:login', (password, ack) => {
    if (!ADMIN_PASSWORD) {
      ackError(ack, 'Admin dang tat.');
      return;
    }

    if (String(password || '') !== ADMIN_PASSWORD) {
      ackError(ack, 'Mat khau admin khong dung.');
      return;
    }

    admins.add(socket.id);
    emitPresence();
    ackSuccess(ack);
  });

  socket.on('message:delete', async (messageId, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const id = Number.parseInt(messageId, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      ackError(ack, 'Tin nhan khong hop le.');
      return;
    }

    const deletedAt = new Date().toISOString();
    const adminName = onlineUsers.get(socket.id)?.name || 'Admin';
    const result = await db.run(MARK_MESSAGE_DELETED_SQL, deletedAt, adminName, id);

    if (!getChangeCount(result)) {
      ackError(ack, 'Khong tim thay tin nhan hoac tin da bi xoa.');
      return;
    }

    const message = await getPublicMessageById(id);
    io.emit('message:deleted', message);
    ackSuccess(ack, { message });
  });

  socket.on('message:revoke', async (messageId, ack) => {
    const account = socket.data.user;
    if (!account) {
      ackError(ack, 'Hay dang nhap truoc khi thu hoi tin nhan.');
      return;
    }

    const id = Number.parseInt(messageId, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      ackError(ack, 'Tin nhan khong hop le.');
      return;
    }

    const deletedAt = new Date().toISOString();
    const result = await db.run(REVOKE_OWN_MESSAGE_SQL, deletedAt, account.username, id, account.id);
    if (!getChangeCount(result)) {
      ackError(ack, 'Chi chu tin nhan moi duoc thu hoi tin nay.');
      return;
    }

    const message = await getPublicMessageById(id);
    io.emit('message:deleted', message);
    ackSuccess(ack, { message });
  });

  socket.on('message:pin', async (payload = {}, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const id = Number.parseInt(payload.id, 10);
    const pinned = Boolean(payload.pinned);
    if (!Number.isSafeInteger(id) || id < 1) {
      ackError(ack, 'Tin nhan ghim khong hop le.');
      return;
    }

    const adminName = onlineUsers.get(socket.id)?.name || 'Admin';
    const result = await db.run(
      TOGGLE_MESSAGE_PIN_SQL,
      pinned ? new Date().toISOString() : null,
      pinned ? adminName : null,
      id
    );

    if (!getChangeCount(result)) {
      ackError(ack, 'Khong tim thay tin nhan de ghim.');
      return;
    }

    const message = await getPublicMessageById(id);
    io.emit('message:pinned', message);
    ackSuccess(ack, { message });
  });

  socket.on('user:mute', async (payload = {}, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const userId = Number.parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      ackError(ack, 'Nguoi dung khong hop le.');
      return;
    }

    const mutedUntil = new Date(Date.now() + MOD_MUTE_MS).toISOString();
    await setUserMute(userId, mutedUntil);
    for (const [socketId, user] of onlineUsers) {
      if (user.userId === userId) {
        io.sockets.sockets.get(socketId)?.emit('moderation:muted', {
          mutedUntil,
          reason: 'Admin tam khoa chat'
        });
      }
    }
    ackSuccess(ack, { userId, mutedUntil });
  });

  socket.on('user:unmute', async (payload = {}, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const userId = Number.parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      ackError(ack, 'Nguoi dung khong hop le.');
      return;
    }

    await setUserMute(userId, null);
    for (const [socketId, user] of onlineUsers) {
      if (user.userId === userId) {
        io.sockets.sockets.get(socketId)?.emit('moderation:unmuted', {
          reason: 'Admin da mo khoa chat'
        });
      }
    }
    ackSuccess(ack, { userId, mutedUntil: null });
  });

  socket.on('user:kick', (payload = {}, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const userId = Number.parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      ackError(ack, 'Nguoi dung khong hop le.');
      return;
    }

    for (const [socketId, user] of onlineUsers) {
      if (user.userId === userId) {
        const targetSocket = io.sockets.sockets.get(socketId);
        targetSocket?.emit('moderation:kicked', { reason: 'Admin da kick ban khoi phong chat' });
        targetSocket?.disconnect(true);
      }
    }
    ackSuccess(ack, { userId });
  });

  socket.on('chat:clear', async (_payload, ack) => {
    if (!admins.has(socket.id)) {
      ackError(ack, 'Ban khong co quyen admin.');
      return;
    }

    const adminName = onlineUsers.get(socket.id)?.name || 'Admin';
    await db.exec(HARD_CLEAR_CHAT_SQL);
    io.emit('chat:cleared', {
      clearedAt: new Date().toISOString(),
      clearedBy: adminName,
      hardDeleted: true
    });
    ackSuccess(ack);
  });

  socket.on('disconnect', () => {
    touchSocketActivity(socket, true);
    onlineUsers.delete(socket.id);
    admins.delete(socket.id);
    stopTyping(socket);
    rateLimits.delete(socket.id);
    emitPresence();
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Stop the existing server on port ${PORT}, or start with another PORT value.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`server running at http://localhost:${PORT}`);
  console.log(`sqlite driver: ${db.driver}`);
  if (!ADMIN_PASSWORD) {
    console.log('ADMIN_PASSWORD is not set; admin controls are disabled.');
  }
});
