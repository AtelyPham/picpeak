// #756: a NULL per-event hero_logo_visible means "inherit the global
// branding_logo_display_hero toggle". Only an explicit true/false is a
// per-gallery override. `globalDefault` is branding_logo_display_hero
// (defaults true when unset).
function resolveHeroLogoVisible(perEvent, globalDefault) {
  if (perEvent === null || perEvent === undefined) {
    return globalDefault !== false;
  }
  return perEvent !== false && perEvent !== 0 && perEvent !== '0';
}

// Re-exported, not redefined. The copy that used to live here listed
// 'heic', 'heif' and 'dng' by hand, so it went stale the moment the RAW set
// grew past DNG: an .arw would upload, get a thumbnail, and then show a broken
// image the moment a guest opened it. utils/rawFormats derives both sets from
// the upload map and is the one source of truth the admin listing already uses.
const { originalNeedsPreview } = require('../utils/rawFormats');

module.exports = { resolveHeroLogoVisible, originalNeedsPreview };
