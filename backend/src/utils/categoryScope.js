const { db } = require('../database/db');
const { parseBooleanInput } = require('./parsers');

// Resolve a numeric category id within the scope of one event: it must belong
// to that event or be a global category (#500 / #525 — the same contract the
// public v1 upload route enforces). Returns undefined for an out-of-scope id,
// which every caller turns into a 400 rather than silently filing the photo
// under another event's category.
const findScopedCategory = (eventId, categoryId) => db('photo_categories')
  .where({ id: categoryId })
  .andWhere(function () {
    this.where({ event_id: eventId }).orWhere('is_global', true);
  })
  .first();

const outOfScopeCategoryError = (categoryId) => ({
  error: `Unknown or out-of-scope category_id ${categoryId}`
});

/**
 * The photo columns a `category_id` from a request resolves to (issue 1786).
 *
 * Since migration 265 a folder lives in `photos.folder_id` and `category_id`
 * holds filter categories only. Clients written before that (the v1 API, the
 * WordPress plugin, a guest upload category pointing at a folder) still send
 * a folder's id as `category_id`; it lands in folder_id, which is exactly
 * where that photo rendered before. Returns null when out of scope.
 */
async function resolveCategoryAssignment(eventId, categoryId) {
  const category = await findScopedCategory(eventId, categoryId);
  if (!category) return null;
  if (parseBooleanInput(category.is_folder, false)) {
    return { category_id: null, folder_id: Number(category.id), category };
  }
  return { category_id: Number(category.id), category };
}

module.exports = { findScopedCategory, outOfScopeCategoryError, resolveCategoryAssignment };
