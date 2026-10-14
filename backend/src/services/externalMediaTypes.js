/**
 * Which files an external-media folder contributes to an event.
 *
 * Kept out of externalMediaService on purpose: that module is loaded by
 * photoResolver, and with it by nearly every route, and must not grow a
 * dependency on the upload settings just to answer this.
 */
const path = require('path');
const { EXTENSION_TO_MIME, getAllowedMimeTypes, getAllowedExtensions } = require('./uploadSettings');
const { RAW_EXTENSIONS } = require('../utils/rawFormats');
const { normalizeUploadMimeType } = require('../utils/fileSecurityUtils');
const logger = require('../utils/logger');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Every video extension the upload pipeline knows how to process.
const VIDEO_EXTENSIONS = Object.keys(EXTENSION_TO_MIME)
  .filter((ext) => EXTENSION_TO_MIME[ext].startsWith('video/'))
  .map((ext) => `.${ext}`);

const isVideoFile = (name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase());

/** The MIME type stored for an imported video, from its extension. */
const videoMimeType = (name) => EXTENSION_TO_MIME[path.extname(name).slice(1).toLowerCase()];

// Every camera RAW extension, whether or not this install takes it.
const CAMERA_RAW_EXTENSIONS = [...RAW_EXTENSIONS].map((ext) => `.${ext}`);

/**
 * The MIME type stored for an imported camera RAW. From the extension alone:
 * mime-db knows few RAW types and calls .dcr a Director file.
 */
const rawMimeType = (name) => normalizeUploadMimeType(name, '') || 'application/octet-stream';

/**
 * The extensions the picker lists and an import takes, right now.
 *
 * Images are the fixed list they always were. Videos are taken only for the
 * types the admin allows for uploads (Settings, General, allowed file types).
 * That is deliberate: a reference folder that has always held clips next to
 * its photos must not start publishing them to guests because of an upgrade.
 * An install that accepts video uploads has made that decision already.
 *
 * Camera RAW follows the same rule for the same reason: a folder that holds
 * the camera originals next to the export must not double its gallery on an
 * upgrade. Checked by extension, not through the MIME map, which does not
 * know every RAW type yet. When the setting cannot be read, this pass takes
 * no RAW rather than failing: every pass rescans the whole folder, so the
 * next one picks them up.
 */
async function importableExtensions() {
  const allowed = await getAllowedMimeTypes();
  return [
    ...IMAGE_EXTENSIONS,
    ...VIDEO_EXTENSIONS.filter((ext) => allowed.includes(EXTENSION_TO_MIME[ext.slice(1)])),
    ...(await allowedRawExtensions()),
  ];
}

/**
 * The camera RAW extensions the admin allows. None when the setting cannot
 * be read, so the pass goes ahead without them.
 */
async function allowedRawExtensions() {
  let allowed;
  try {
    allowed = await getAllowedExtensions();
  } catch (error) {
    logger.warn(`External import takes no camera RAW this pass, the allowed file types could not be read: ${error.message}`);
    return [];
  }
  return CAMERA_RAW_EXTENSIONS.filter((ext) => allowed.has(ext.slice(1)));
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  CAMERA_RAW_EXTENSIONS,
  isVideoFile,
  videoMimeType,
  rawMimeType,
  importableExtensions,
};
