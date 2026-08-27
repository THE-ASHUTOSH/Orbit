import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openInMemoryForTests, createUser, grantTab, revokeTab, authenticate, insertTab } from '../db.js';
import {
  canAdminTab,
  canCloseTab,
  canControlTab,
  canRenameTab,
  canViewTab,
  effectivePermission,
  roleCan,
} from '../auth/permissions.js';

let admin: { id: string; role: 'admin' };
let user: { id: string; role: 'user' };
let other: { id: string; role: 'user' };
let viewer: { id: string; role: 'viewer' };

const TAB = 'tab_01TEST';

before(() => {
  openInMemoryForTests();
  admin = createUser('admin1', 'password123', 'admin') as never;
  user = createUser('user1', 'password123', 'user') as never;
  other = createUser('user2', 'password123', 'user') as never;
  viewer = createUser('viewer1', 'password123', 'viewer') as never;
});

test('authz: admin controls every tab without a grant', () => {
  assert.equal(effectivePermission(admin, TAB), 'admin');
  assert.ok(canControlTab(admin, TAB));
  assert.ok(canAdminTab(admin, TAB));
});

test('authz: viewers can never send input, even if granted control', () => {
  grantTab(TAB, viewer.id, 'control');
  assert.equal(effectivePermission(viewer, TAB), 'view');
  assert.equal(canControlTab(viewer, TAB), false);
  assert.ok(canViewTab(viewer, TAB));
  assert.equal(roleCan('viewer', 'input.send'), false);
  assert.equal(roleCan('viewer', 'tab.create'), false);
});

test('authz: a user defaults to shared control and an explicit grant overrides it', () => {
  assert.equal(effectivePermission(user, TAB), 'control', 'shared-by-default');
  grantTab(TAB, user.id, 'view');
  assert.equal(effectivePermission(user, TAB), 'view');
  assert.equal(canControlTab(user, TAB), false, 'downgraded to view-only');
  assert.ok(canViewTab(user, TAB));
  revokeTab(TAB, user.id);
  assert.equal(effectivePermission(user, TAB), 'control', 'back to the default after revoke');
});

test('authz: grants are per tab and per user', () => {
  grantTab('tab_01OTHER', other.id, 'view');
  assert.equal(effectivePermission(other, 'tab_01OTHER'), 'view');
  assert.equal(effectivePermission(other, TAB), 'control', 'other tabs unaffected');
  assert.equal(effectivePermission(user, 'tab_01OTHER'), 'control', 'other users unaffected');
});

test('authz: plain users cannot administer a tab', () => {
  assert.equal(canAdminTab(user, TAB), false);
  grantTab(TAB, user.id, 'admin');
  assert.ok(canAdminTab(user, TAB));
  revokeTab(TAB, user.id);
});

test('auth: credentials are checked against the stored hash', () => {
  assert.ok(authenticate('user1', 'password123'));
  assert.equal(authenticate('user1', 'wrong'), null);
  assert.equal(authenticate('nobody', 'password123'), null);
});

// --- ownership --------------------------------------------------------------

/**
 * A tab belongs to whoever opened it (TAB_OWNERSHIP, on by default). The tabs
 * used above have no row in `tabs`, so they have no owner and keep the older
 * shared-control behaviour - which is what makes them a useful control group.
 */
const OWNED = 'tab_01OWNED';

test('authz: the owner of a tab administers it, and everyone else only watches', () => {
  insertTab({
    id: OWNED,
    browserId: 'brw_01TEST',
    targetId: 'target-1',
    label: null,
    url: 'https://example.com/',
    title: 'Example',
    createdBy: user.id,
  });

  // Owner: admin, because handing control to someone else is a tab-admin act.
  assert.equal(effectivePermission(user, OWNED), 'admin');
  assert.ok(canControlTab(user, OWNED));
  assert.ok(canAdminTab(user, OWNED));

  // Anyone else: watching only, until the owner says otherwise.
  assert.equal(effectivePermission(other, OWNED), 'view');
  assert.equal(canControlTab(other, OWNED), false);
  assert.ok(canViewTab(other, OWNED));

  // A role admin is still an admin - somebody has to be able to clean up.
  assert.equal(effectivePermission(admin, OWNED), 'admin');
  // And a viewer stays a viewer whoever owns what.
  assert.equal(effectivePermission(viewer, OWNED), 'view');
});

test('authz: a grant from the owner is what turns a watcher into a driver', () => {
  grantTab(OWNED, other.id, 'control');
  assert.equal(effectivePermission(other, OWNED), 'control');
  assert.ok(canControlTab(other, OWNED));
  // Still not theirs to administer: they cannot pass it on again.
  assert.equal(canAdminTab(other, OWNED), false);

  revokeTab(OWNED, other.id);
  assert.equal(effectivePermission(other, OWNED), 'view', 'revoking puts them back to watching');
});

test('authz: an unowned tab is still shared, so nothing changes for existing tabs', () => {
  // No row in `tabs` -> no owner -> DEFAULT_TAB_PERMISSION, as before.
  assert.equal(effectivePermission(user, 'tab_01NOOWNER'), 'control');
  assert.equal(effectivePermission(other, 'tab_01NOOWNER'), 'control');
});

test('authz: a tab nobody owns can be closed by the person looking at it', () => {
  /**
   * The reported bug: a tab an extension or a redirect opened arrives with no
   * owner, and "only the owner may close it" then means "only a role admin may
   * close it" - so the person staring at the tab could not get rid of it.
   */
  assert.ok(canCloseTab(user, OWNED, null), 'an unowned tab is closable');
  assert.ok(canCloseTab(other, OWNED, null), 'by anyone whose role allows closing');
  assert.ok(canRenameTab(user, OWNED, null), 'and renamable');

  // An owned tab is still the owner's alone.
  assert.ok(canCloseTab(user, OWNED, user.id), 'the owner can close their own tab');
  assert.equal(canCloseTab(other, OWNED, user.id), false, "but nobody else can");
  assert.equal(canRenameTab(other, OWNED, user.id), false);

  // Admins can always clean up; viewers can never close anything.
  assert.ok(canCloseTab(admin, OWNED, user.id));
  assert.equal(canCloseTab(viewer, OWNED, null), false, 'a viewer cannot close even an unowned tab');
});
