import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openInMemoryForTests, createUser, grantTab, revokeTab, authenticate } from '../db.js';
import { canAdminTab, canControlTab, canViewTab, effectivePermission, roleCan } from '../auth/permissions.js';

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
