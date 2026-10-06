/**
 * Migration 265: nested gallery folders (issue 1786) and two-stage delivery
 * (issue 1562).
 *
 * FOLDERS
 *
 * Issue 1160 made a category a folder with `is_folder` and kept a photo's folder
 * in `photos.category_id`. That left a photo with one slot for two different
 * things: where it lives (a folder) and what it is (a filter category such as
 * Portraits). A photo inside a folder could never carry a filter category, and
 * face auto-categories (faceAutoCategories.js, which only fills an empty
 * category_id) never reached it. So the folder moves to its own column:
 *
 *   photos.folder_id                 the folder a photo lives in (an is_folder
 *                                    photo_categories row of the same event);
 *                                    category_id keeps filter categories only.
 *   photo_categories.parent_id       nesting, max depth 3 (folderTreeService).
 *                                    No database FK: SQLite would need a table
 *                                    rebuild; the tree service owns integrity.
 *   photo_categories.source_path     the relative folder path a folder was made
 *                                    from ("Saturday/Activity B"). Uploads and
 *                                    rescans match on it, so a folder the admin
 *                                    renamed is still found. Unique per event.
 *   events.folder_structure          mirror the folder tree of uploads and
 *                                    external imports. Existing events are off,
 *                                    so no delivered gallery changes on rescan.
 *   folder_requests                  folders a role without folders.manage
 *                                    wanted to create. Their photos wait in the
 *                                    closest existing parent until an admin
 *                                    approves (photos.pending_folder_request_id).
 *   permission folders.manage        create, rename, move and delete folders.
 *                                    Folder editing used to need settings.edit,
 *                                    so every role holding settings.edit gets
 *                                    it: no role loses a capability.
 *
 * Backfill: a photo whose category_id points at an is_folder category moves to
 * folder_id with category_id cleared. It had no filter category before either,
 * so every gallery renders exactly as it did.
 *
 * DELIVERY
 *
 *   events.delivery_*                partial = a first look is out and more is
 *                                    coming; complete is today's behaviour.
 *   photos.first_look                stamped at ingest, never inferred later. The
 *                                    badge stays after the gallery completes.
 *
 * Additive and hasColumn-guarded throughout.
 */

const NEW_PERMISSIONS = [
  {
    name: 'folders.manage',
    display_name: 'Manage Gallery Folders',
    category: 'photos',
    description: 'Create, rename, move and delete gallery folders, and approve the folders an upload asked for. Without it, an upload into a folder that does not exist yet waits in the closest existing folder until someone with this permission approves it.',
  },
];

async function addColumns(knex, table, columns) {
  if (!(await knex.schema.hasTable(table))) return;
  for (const [name, add] of columns) {
    if (!(await knex.schema.hasColumn(table, name))) {
      await knex.schema.alterTable(table, (t) => add(t));
    }
  }
}

async function seedPermissions(knex) {
  for (const table of ['permissions', 'roles', 'role_permissions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  const existing = new Set(
    (await knex('permissions').whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).select('name')).map((r) => r.name)
  );
  const toInsert = NEW_PERMISSIONS.filter((p) => !existing.has(p.name));
  if (toInsert.length > 0) await knex('permissions').insert(toInsert);

  const perm = await knex('permissions').where({ name: 'folders.manage' }).first();
  const settingsEdit = await knex('permissions').where({ name: 'settings.edit' }).first();
  if (!perm) return;

  const roleIds = new Set();
  if (settingsEdit) {
    (await knex('role_permissions').where({ permission_id: settingsEdit.id }).select('role_id'))
      .forEach((r) => roleIds.add(r.role_id));
  }
  const superAdmin = await knex('roles').where({ name: 'super_admin' }).first();
  if (superAdmin) roleIds.add(superAdmin.id);

  for (const roleId of roleIds) {
    const has = await knex('role_permissions').where({ role_id: roleId, permission_id: perm.id }).first();
    if (!has) await knex('role_permissions').insert({ role_id: roleId, permission_id: perm.id });
  }
}

exports.up = async function (knex) {
  await addColumns(knex, 'photo_categories', [
    ['parent_id', (t) => { t.integer('parent_id').nullable(); t.index(['parent_id'], 'photo_categories_parent_idx'); }],
    ['source_path', (t) => t.text('source_path').nullable()],
  ]);

  await addColumns(knex, 'photos', [
    ['folder_id', (t) => { t.integer('folder_id').nullable(); t.index(['event_id', 'folder_id'], 'photos_event_folder_idx'); }],
    ['pending_folder_request_id', (t) => t.integer('pending_folder_request_id').nullable()],
    ['first_look', (t) => { t.boolean('first_look').notNullable().defaultTo(false); }],
  ]);

  await addColumns(knex, 'events', [
    ['folder_structure', (t) => t.boolean('folder_structure').notNullable().defaultTo(false)],
    ['delivery_status', (t) => t.string('delivery_status', 16).notNullable().defaultTo('complete')],
    ['delivery_expected_count', (t) => t.integer('delivery_expected_count').nullable()],
    ['delivery_due_at', (t) => t.timestamp('delivery_due_at').nullable()],
    ['delivery_due_source', (t) => t.string('delivery_due_source', 64).nullable()],
    ['delivery_badge_label', (t) => t.string('delivery_badge_label', 60).nullable()],
    ['delivery_completed_at', (t) => t.timestamp('delivery_completed_at').nullable()],
    ['delivery_reminder_sent_at', (t) => t.timestamp('delivery_reminder_sent_at').nullable()],
    ['delivery_overdue_notified_at', (t) => t.timestamp('delivery_overdue_notified_at').nullable()],
  ]);

  // One folder per source path and event; concurrent uploads of the same tree
  // resolve to the same row instead of inserting it twice (cf. issue 1162).
  if (await knex.schema.hasColumn('photo_categories', 'source_path')) {
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS photo_categories_event_source_path_uq '
      + 'ON photo_categories (event_id, source_path) WHERE source_path IS NOT NULL'
    );
  }

  if (!(await knex.schema.hasTable('folder_requests'))) {
    await knex.schema.createTable('folder_requests', (t) => {
      t.increments('id').primary();
      t.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.text('path').notNullable();
      t.integer('fallback_folder_id').nullable();
      t.integer('requested_by').nullable();
      t.string('status', 16).notNullable().defaultTo('pending');
      t.integer('decided_by').nullable();
      t.timestamp('decided_at').nullable();
      t.integer('approved_folder_id').nullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['event_id', 'status'], 'folder_requests_event_status_idx');
    });
    // At most one open request per path and event; a second upload into the
    // same missing folder joins the open request.
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS folder_requests_open_path_uq '
      + 'ON folder_requests (event_id, path) WHERE status = \'pending\''
    );
  }

  // Backfill: folder membership moves from category_id to folder_id.
  if (await knex.schema.hasColumn('photo_categories', 'is_folder')) {
    // Event folders only. A global category flagged is_folder (the categories
    // API accepted the flag on a global before this PR) has no event tree, so
    // its photos keep the folder in category_id, where the guest payload and
    // the per-category download rule still read it as before.
    const folderIds = await knex('photo_categories').where('is_folder', true).whereNotNull('event_id').pluck('id');
    for (let i = 0; i < folderIds.length; i += 200) {
      const chunk = folderIds.slice(i, i + 200);
      await knex('photos')
        .whereIn('category_id', chunk)
        .whereNull('folder_id')
        .update({ folder_id: knex.ref('category_id'), category_id: null });
    }
  }

  await seedPermissions(knex);
};

exports.down = async function (knex) {
  // Put folder membership back where issue 1160 kept it before dropping the
  // column. A rollback of last resort: every photo in a folder gets the folder
  // as its category_id again, which discards a filter category assigned to
  // it after this migration ran.
  if (await knex.schema.hasColumn('photos', 'folder_id')) {
    await knex('photos').whereNotNull('folder_id').update({ category_id: knex.ref('folder_id') });
  }
  await knex.raw('DROP INDEX IF EXISTS folder_requests_open_path_uq');
  await knex.schema.dropTableIfExists('folder_requests');
  await knex.raw('DROP INDEX IF EXISTS photo_categories_event_source_path_uq');

  const drop = async (table, cols, indexes = []) => {
    if (!(await knex.schema.hasTable(table))) return;
    for (const idx of indexes) await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  };
  await drop('photos', ['folder_id', 'pending_folder_request_id', 'first_look'], ['photos_event_folder_idx']);
  await drop('photo_categories', ['parent_id', 'source_path'], ['photo_categories_parent_idx']);
  await drop('events', [
    'folder_structure', 'delivery_status', 'delivery_expected_count', 'delivery_due_at',
    'delivery_due_source', 'delivery_badge_label', 'delivery_completed_at',
    'delivery_reminder_sent_at', 'delivery_overdue_notified_at',
  ]);

  if (await knex.schema.hasTable('permissions') && await knex.schema.hasTable('role_permissions')) {
    const ids = await knex('permissions').whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).pluck('id');
    if (ids.length) {
      await knex('role_permissions').whereIn('permission_id', ids).del();
      await knex('permissions').whereIn('id', ids).del();
    }
  }
};

// Boot self-heal (services/_permissionsBoot): a .picpeak restore of a backup
// taken before this migration replaces the permission tables, dropping
// folders.manage and its projection onto settings.edit holders.
exports.seedFolderPermissions = seedPermissions;
