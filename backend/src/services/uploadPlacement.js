/**
 * Where an admin upload lands (issues 1786 + 1562): one resolver for the
 * multipart and chunked upload routes, so the two cannot drift. The v1 API
 * and guest uploads only map a folder sent as category_id onto folder_id
 * (categoryScope.resolveCategoryAssignment); they take no folder fields.
 *
 * Request fields (all optional):
 *   category_id        filter category, or — from older clients — a folder id,
 *                      which lands in folder_id (see categoryScope)
 *   folder_id          the folder of this batch (from POST …/folders/resolve)
 *   folder_request_id  an open folder request: the batch waits in the
 *                      request's fallback folder until an admin approves
 *   first_look         the batch came from a FirstLook keyword folder
 *
 * Returns { placement, error } where placement holds the photo columns.
 */

const { resolveCategoryAssignment, outOfScopeCategoryError } = require('../utils/categoryScope');
const { parseBooleanInput } = require('../utils/parsers');
const tree = require('./folderTreeService');
const requests = require('./folderRequestService');

const positiveInt = (value) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function resolveUploadPlacement(eventId, body = {}) {
  const placement = { category_id: null, folder_id: null, first_look: false, pending_folder_request_id: null };
  let category = null;

  const categoryId = positiveInt(body.category_id);
  if (categoryId) {
    const assignment = await resolveCategoryAssignment(eventId, categoryId);
    if (!assignment) return { error: outOfScopeCategoryError(categoryId) };
    placement.category_id = assignment.category_id;
    if (assignment.folder_id) placement.folder_id = assignment.folder_id;
    category = assignment.category;
  }

  const folderId = positiveInt(body.folder_id);
  if (folderId) {
    if (!(await tree.findEventFolder(eventId, folderId))) {
      return { error: { error: `Unknown folder_id ${folderId}` } };
    }
    placement.folder_id = folderId;
  }

  const requestId = positiveInt(body.folder_request_id);
  if (requestId) {
    const request = await requests.findOpenRequest(eventId, requestId);
    if (!request) return { error: { error: `Unknown or closed folder_request_id ${requestId}` } };
    placement.pending_folder_request_id = Number(request.id);
    placement.folder_id = request.fallback_folder_id == null ? null : Number(request.fallback_folder_id);
  }

  placement.first_look = parseBooleanInput(body.first_look, false);
  return { placement, category };
}

/** Columns for the photo insert (booleans written the way each engine wants). */
function placementColumns(placement) {
  const { formatBoolean } = require('../utils/dbCompat');
  return {
    category_id: placement.category_id,
    folder_id: placement.folder_id,
    pending_folder_request_id: placement.pending_folder_request_id,
    first_look: formatBoolean(!!placement.first_look),
  };
}

/**
 * After the rows are in: a batch for a folder request decided meanwhile
 * follows that decision, and a first-look batch switches the event to
 * two-stage delivery.
 */
async function afterUploadPlacement(eventId, placement, insertedCount, actor) {
  if (!placement || insertedCount <= 0) return;
  if (placement.pending_folder_request_id) {
    await requests.settleLateArrivals(Number(eventId), placement.pending_folder_request_id)
      .catch((err) => require('../utils/logger').warn('folder request settle failed', { eventId, error: err.message }));
  }
  if (!placement.first_look) return;
  await require('./deliveryService').markFirstLookArrived(Number(eventId), { actor, source: 'upload' })
    .catch((err) => require('../utils/logger').warn('first look switch failed', { eventId, error: err.message }));
}

module.exports = { resolveUploadPlacement, placementColumns, afterUploadPlacement };
