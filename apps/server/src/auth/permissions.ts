/**
 * Server-authoritative authorization. Every WebSocket message and REST route
 * asks these functions; the frontend hiding a button is never the control.
 */
import { ROLE_RANK, permits, type Role, type TabPermission } from '@orbit/protocol';
import { config } from '../config.js';
import { getTabGrant, tabOwner } from '../db.js';

export type Capability =
  | 'tab.create'
  | 'tab.close'
  | 'tab.rename'
  | 'tab.navigate'
  | 'browser.restart'
  | 'user.manage'
  | 'presence.viewAll'
  | 'input.send';

const ROLE_CAPS: Record<Role, Capability[]> = {
  admin: [
    'tab.create',
    'tab.close',
    'tab.rename',
    'tab.navigate',
    'browser.restart',
    'user.manage',
    'presence.viewAll',
    'input.send',
  ],
  user: ['tab.create', 'tab.close', 'tab.rename', 'tab.navigate', 'presence.viewAll', 'input.send'],
  viewer: ['presence.viewAll'],
};

export const roleCan = (role: Role, cap: Capability): boolean => ROLE_CAPS[role].includes(cap);

/**
 * Effective permission of a user on a tab:
 *   admin role            -> admin on everything
 *   explicit grant        -> that grant
 *   owner of the tab      -> admin on it (so they can hand control out)
 *   someone else's tab    -> view  (TAB_OWNERSHIP, the default)
 *   otherwise             -> DEFAULT_TAB_PERMISSION for `user`, view for `viewer`
 * A viewer is then capped at 'view' whatever the grant says, so "viewer cannot
 * send input" holds even if someone grants them control by mistake.
 */
export function effectivePermission(
  user: { id: string; role: Role },
  tabId: string,
): TabPermission {
  if (user.role === 'admin') return 'admin';
  const grant = getTabGrant(tabId, user.id);
  if (user.role === 'viewer') return 'view';
  if (grant) return grant;
  if (config.tabOwnership) {
    const owner = tabOwner(tabId);
    // 'admin' rather than 'control': the owner is who grants access to others,
    // and that is a tab-admin capability.
    if (owner) return owner === user.id ? 'admin' : 'view';
  }
  return config.defaultTabPermission;
}

export function canControlTab(user: { id: string; role: Role }, tabId: string): boolean {
  return roleCan(user.role, 'input.send') && permits(effectivePermission(user, tabId), 'control');
}

export function canViewTab(user: { id: string; role: Role }, tabId: string): boolean {
  return permits(effectivePermission(user, tabId), 'view');
}

/** Only tab admins (or role admins) may close/rename a tab someone else owns. */
export function canAdminTab(user: { id: string; role: Role }, tabId: string): boolean {
  return permits(effectivePermission(user, tabId), 'admin');
}

export const outranks = (a: Role, b: Role) => ROLE_RANK[a] > ROLE_RANK[b];
