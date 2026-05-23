/**
 * Dashboard user allowlist — only Lark open_ids listed here can log into
 * the dashboard. The first entry is conventionally the "owner" (the user
 * who installed botmux on this host); additional entries are collaborators
 * the owner has explicitly granted access to.
 *
 * Layout: `~/.botmux/dashboard-allowlist.json`
 * ```json
 * {
 *   "users": [
 *     {"openId": "ou_xxx", "name": "...", "role": "owner"},
 *     {"openId": "ou_yyy", "name": "...", "role": "viewer"}
 *   ]
 * }
 * ```
 *
 * Race semantics: file is reloaded on every isAllowed() call (cheap JSON
 * parse; no caching). Editor changes take effect on the next request.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

export interface AllowlistEntry {
  openId: string;
  name?: string;
  role?: 'owner' | 'viewer';
}

export interface Allowlist {
  users: AllowlistEntry[];
}

function filePath(): string {
  return join(homedir(), '.botmux', 'dashboard-allowlist.json');
}

/** Read the allowlist. Returns empty {users:[]} if file missing. */
export function loadAllowlist(): Allowlist {
  const fp = filePath();
  if (!existsSync(fp)) return { users: [] };
  try {
    const raw = readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as Allowlist;
    if (!Array.isArray(parsed.users)) return { users: [] };
    return parsed;
  } catch (err) {
    logger.error(`[dashboard-allowlist] failed to load ${fp}: ${err}`);
    return { users: [] };
  }
}

/** Whether the given open_id is in the allowlist. Returns false if file
 *  missing / empty / open_id not present. */
export function isAllowed(openId: string): boolean {
  if (!openId) return false;
  const al = loadAllowlist();
  return al.users.some(u => u.openId === openId);
}

/** Lookup entry by open_id, or null. */
export function findEntry(openId: string): AllowlistEntry | null {
  const al = loadAllowlist();
  return al.users.find(u => u.openId === openId) ?? null;
}

/** Initialize allowlist file with the given owner if file doesn't yet
 *  exist. No-op if file already present. Returns true iff a fresh file
 *  was written. */
export function initOwnerIfMissing(ownerOpenId: string, name?: string): boolean {
  const fp = filePath();
  if (existsSync(fp)) return false;
  if (!ownerOpenId) return false;
  mkdirSync(dirname(fp), { recursive: true });
  const al: Allowlist = {
    users: [{ openId: ownerOpenId, name: name ?? 'owner', role: 'owner' }],
  };
  writeFileSync(fp, JSON.stringify(al, null, 2), 'utf-8');
  logger.info(`[dashboard-allowlist] initialized ${fp} with owner ${ownerOpenId}`);
  return true;
}

/** Add a user to allowlist (idempotent — dedup by open_id). */
export function addUser(entry: AllowlistEntry): void {
  const fp = filePath();
  mkdirSync(dirname(fp), { recursive: true });
  const al = loadAllowlist();
  if (!al.users.some(u => u.openId === entry.openId)) {
    al.users.push(entry);
    writeFileSync(fp, JSON.stringify(al, null, 2), 'utf-8');
    logger.info(`[dashboard-allowlist] added ${entry.openId} (${entry.name ?? '-'})`);
  }
}

/** Remove a user from allowlist. Returns true iff removed. */
export function removeUser(openId: string): boolean {
  const fp = filePath();
  const al = loadAllowlist();
  const before = al.users.length;
  al.users = al.users.filter(u => u.openId !== openId);
  if (al.users.length === before) return false;
  writeFileSync(fp, JSON.stringify(al, null, 2), 'utf-8');
  logger.info(`[dashboard-allowlist] removed ${openId}`);
  return true;
}
