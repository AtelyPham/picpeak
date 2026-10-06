'use strict';

const { getAppSetting } = require('./appSettings');

/**
 * Is the business VAT-registered? (Settings → Accounting,
 * `accounting_vat_registered`). Null when the setting was never set, so each
 * caller keeps its behaviour-preserving default: the tax report infers it
 * from the VAT charged, and the PDFs keep their VAT row.
 */
async function getVatRegisteredSetting() {
  try {
    const v = await getAppSetting('accounting_vat_registered');
    if (v === undefined || v === null) return null;
    return v === true || v === 1 || v === '1' || v === 'true';
  } catch (_) {
    return null;
  }
}

module.exports = { getVatRegisteredSetting };
