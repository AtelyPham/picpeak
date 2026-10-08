'use strict';

/**
 * Migration 264: remember when a gallery's password is one nobody knows.
 *
 * A gallery whose only recipients are customer accounts is opened through the
 * customer portal, which never asks for the gallery password. Such a gallery
 * gets a generated password that is never shown or mailed — it only keeps the
 * share link locked. This flag records that, so adding an inline customer
 * email later asks the admin for a real password instead of mailing the
 * "(set at creation)" sentinel. Existing rows stay false: their password was
 * typed by an admin, and nothing about them changes.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasColumn('events', 'password_generated')) return;
  await knex.schema.alterTable('events', (t) => {
    t.boolean('password_generated').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'password_generated'))) return;
  await knex.schema.alterTable('events', (t) => t.dropColumn('password_generated'));
};
