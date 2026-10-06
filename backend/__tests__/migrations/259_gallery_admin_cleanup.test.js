/**
 * Migration 259 — the events.support / view_all / manage_all split must leave
 * every existing role with exactly what it had, plus only the listed additions:
 *   - events.support for every role holding events.edit (custom roles too)
 *   - events.view_all for the role named `admin`
 *   - all three for super_admin
 * and it seeds customer_support only when no role of that name exists.
 */
const path = require('path'), fs = require('fs'), os = require('os');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig259-')), 'db.sqlite');
process.env.JWT_SECRET = 'mig';
const { bootCrmDb } = require('../integration/helpers/crmDb');
const mig = require('../../migrations/core/259_gallery_admin_cleanup');

const NEW = ['events.support', 'events.view_all', 'events.manage_all'];

async function grantsByRole(db) {
  const rows = await db('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .select('roles.name as role', 'permissions.name as perm');
  const map = {};
  for (const { role, perm } of rows) (map[role] ||= new Set()).add(perm);
  return map;
}

async function addRole(db, name, perms) {
  await db('roles').insert({ name, display_name: name, is_system: false, priority: 10, created_at: new Date(), updated_at: new Date() });
  const role = await db('roles').where({ name }).first();
  const ids = (await db('permissions').whereIn('name', perms).select('id')).map((p) => p.id);
  if (ids.length) await db('role_permissions').insert(ids.map((id) => ({ role_id: role.id, permission_id: id })));
}

describe('migration 259 permissions', () => {
  let db, cleanup;
  beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('projects grants forward without taking or adding anything else', async () => {
    await mig.down(db);
    await addRole(db, 'custom_editor', ['events.view', 'events.edit', 'photos.view']);
    await addRole(db, 'custom_viewer', ['events.view', 'photos.view']);
    const before = await grantsByRole(db);
    expect(before.customer_support).toBeUndefined();

    await mig.up(db);
    const after = await grantsByRole(db);

    for (const [role, perms] of Object.entries(before)) {
      const gained = [...(after[role] || [])].filter((p) => !perms.has(p));
      const lost = [...perms].filter((p) => !(after[role] || new Set()).has(p));
      expect({ role, lost }).toEqual({ role, lost: [] });
      const expected = [];
      if (role === 'super_admin') expected.push(...NEW);
      else {
        if (perms.has('events.edit')) expected.push('events.support');
        if (role === 'admin') expected.push('events.view_all');
      }
      expect({ role, gained: gained.sort() }).toEqual({ role, gained: expected.sort() });
    }
    expect([...after.customer_support].sort()).toEqual([...mig.CUSTOMER_SUPPORT.permissions].sort());
  });

  it('is idempotent', async () => {
    const once = await grantsByRole(db);
    await mig.up(db);
    const twice = await grantsByRole(db);
    expect(Object.fromEntries(Object.entries(twice).map(([k, v]) => [k, [...v].sort()])))
      .toEqual(Object.fromEntries(Object.entries(once).map(([k, v]) => [k, [...v].sort()])));
  });

  it('never overwrites an existing customer_support role', async () => {
    await mig.down(db);
    await addRole(db, 'customer_support', ['events.view']);
    await mig.up(db);
    const after = await grantsByRole(db);
    expect([...after.customer_support]).toEqual(['events.view']);
  });

  it('switches custom styling on only where the look would change', async () => {
    const branding = { colors: { primary: '#111111' }, headerStyle: 'standard' };
    await db('app_settings').where({ setting_key: 'theme_config' }).del();
    await db('app_settings').insert({ setting_key: 'theme_config', setting_value: JSON.stringify(branding), setting_type: 'theme', updated_at: new Date() });
    const base = { event_type: 'wedding', event_date: '2026-08-01', host_email: 'h@e.com', admin_email: 'a@e.com',
      password_hash: 'x', expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString() };
    const rows = {
      none: { color_theme: null },
      copy: { color_theme: JSON.stringify({ ...branding, logoUrl: '/l.png' }) },
      own: { color_theme: JSON.stringify({ colors: { primary: '#222222' } }) },
      preset: { color_theme: 'elegantWedding' },
      // No theme, but its own header column, which the gallery renders today.
      header: { color_theme: null, header_style: 'hero' },
    };
    for (const [slug, extra] of Object.entries(rows)) {
      await db('events').insert({ ...base, ...extra, slug: `t-${slug}`, event_name: slug, share_token: `tok-${slug}`, share_link: `/g/t-${slug}/tok-${slug}` });
    }
    await mig.down(db);
    await mig.up(db);
    const got = {};
    for (const slug of Object.keys(rows)) {
      const row = await db('events').where({ slug: `t-${slug}` }).first('custom_theme_enabled');
      got[slug] = Boolean(row.custom_theme_enabled);
    }
    expect(got).toEqual({ none: false, copy: false, own: true, preset: true, header: true });
  });

  it('boot before the migration leaves customer_support for the migration to seed whole', async () => {
    const { seedPermissionsAtBoot } = require('../../src/services/_permissionsBoot');
    await mig.down(db); // the catalog as before 259: no events.support / view_all / manage_all
    await seedPermissionsAtBoot(db);
    expect(await db('roles').where({ name: 'customer_support' }).first()).toBeUndefined();

    await mig.up(db);
    const after = await grantsByRole(db);
    expect([...after.customer_support].sort()).toEqual([...mig.CUSTOMER_SUPPORT.permissions].sort());
  });
});
