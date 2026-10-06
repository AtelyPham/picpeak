/**
 * Gallery reach comes from the role's permissions (eventScope, set by adminAuth
 * from events.view_all / events.manage_all), with the legacy role-name rule
 * kept for principals that carry no scope (before migration 259 has run).
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
const { canAccessEvent, seesAllEvents, managesAllEvents } = require('../../src/middleware/ownership');

const foreign = { id: 1, created_by: 99 };
const own = { id: 2, created_by: 7 };
const ownerless = { id: 3, created_by: null };

describe('event scope', () => {
  it('keeps today\'s rules when no scope is known', () => {
    const admin = { id: 7, roleName: 'admin' };
    const editor = { id: 7, roleName: 'editor' };
    expect(seesAllEvents(admin)).toBe(true);
    expect(canAccessEvent(admin, foreign)).toBe(false);
    expect(seesAllEvents(editor)).toBe(false);
    expect(canAccessEvent(editor, own)).toBe(true);
    expect(canAccessEvent(editor, ownerless)).toBe(true);
  });

  it('view_all reads every gallery but acts only on its own', () => {
    const a = { id: 7, roleName: 'admin', eventScope: { viewAll: true, manageAll: false } };
    expect(seesAllEvents(a)).toBe(true);
    expect(canAccessEvent(a, foreign)).toBe(false);
    expect(managesAllEvents(a)).toBe(false);
  });

  it('manage_all acts on every gallery', () => {
    const s = { id: 7, roleName: 'customer_support', eventScope: { viewAll: true, manageAll: true } };
    expect(seesAllEvents(s)).toBe(true);
    expect(canAccessEvent(s, foreign)).toBe(true);
  });

  it('a revoked view_all takes the admin role back to its own galleries', () => {
    const a = { id: 7, roleName: 'admin', eventScope: { viewAll: false, manageAll: false } };
    expect(seesAllEvents(a)).toBe(false);
  });

  it('super_admin needs no scope', () => {
    const s = { id: 1, roleName: 'super_admin' };
    expect(seesAllEvents(s)).toBe(true);
    expect(canAccessEvent(s, foreign)).toBe(true);
  });
});

describe('filterOwnedEventIds and manage_all', () => {
  const { db } = require('../../src/database/db');
  const { filterOwnedEventIds } = require('../../src/middleware/ownership');
  const support = { id: 7, roleName: 'customer_support', eventScope: { viewAll: true, manageAll: true } };

  beforeEach(() => {
    db.mockImplementation(() => ({
      whereIn() { return this; },
      andWhere() { return this; },
      select: async () => [],
    }));
  });

  it('keeps CRM and transfer callers on the owner rule', async () => {
    expect(await filterOwnedEventIds(support, [1, 2])).toEqual({ allowed: [], denied: [1, 2] });
  });

  it('lets gallery routes opt in', async () => {
    expect(await filterOwnedEventIds(support, [1, 2], { honourManageAll: true })).toEqual({ allowed: [1, 2], denied: [] });
  });
});
