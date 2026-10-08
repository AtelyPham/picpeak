import type { ThemeConfig } from '../types/theme.types';
import { contrastRatio, relativeLuminance } from './contrast';
import { DARK_SURFACE_DEFAULTS, LIGHT_SURFACE_DEFAULTS } from './themeMigration';

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i;

/**
 * An opaque colour as #rrggbb, or null. Same rules as the email wrapper's
 * backend/src/utils/colorContrast.js parseColor, so the settings warning
 * shows for exactly the colours the wrapper corrects: 3/4/6/8-digit hex and
 * rgb()/rgba(), with translucent values, named colours and hsl() left out.
 * (relativeLuminance() alone reads anything it can't parse as black.)
 */
export function toOpaqueHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const hex = trimmed.match(HEX);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.split('').map((d) => d + d).join('');
    if (digits.length === 8 && digits.slice(6, 8).toLowerCase() !== 'ff') return null;
    return `#${digits.slice(0, 6).toLowerCase()}`;
  }
  const rgb = trimmed.match(RGB);
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.some((c) => c > 255)) return null;
    if (rgb[4] !== undefined) {
      const alpha = Number(rgb[4]) / (rgb[5] === '%' ? 100 : 1);
      if (!(alpha >= 1)) return null;
    }
    return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

export interface EmailBrandingColors {
  primary: string;
  secondary: string;
  bodyBg: string;
  containerBg: string;
  listBg: string;
  bodyText: string;
  mutedText: string;
}

/**
 * Map the active Branding theme onto the email palette (Settings → Email →
 * "Sync from Branding").
 *
 * Tokens the stored theme doesn't carry fall back to the defaults of the
 * theme's own colour mode. Themes saved before the 8-token palette have no
 * elevatedColor, and the old light-only fallbacks turned a dark theme into
 * a dark email card with a near-white info panel under near-white text.
 * When colorMode is unset or 'auto', the mode is read off the theme's
 * background (or surface) colour.
 */
export function emailColorsFromBranding(theme: ThemeConfig | null | undefined): EmailBrandingColors {
  const t = theme || {};
  const base = t.backgroundColor || t.surfaceColor;
  const baseHex = toOpaqueHex(base);
  const isDark = t.colorMode === 'dark'
    || (t.colorMode !== 'light' && !!baseHex && relativeLuminance(baseHex) < 0.5);
  const defaults = isDark ? DARK_SURFACE_DEFAULTS : LIGHT_SURFACE_DEFAULTS;
  const surface = t.surfaceColor || defaults.surfaceColor;

  return {
    primary: t.accentDarkColor || t.primaryColor || '#5C8762',
    secondary: surface,
    bodyBg: t.backgroundColor || defaults.backgroundColor,
    containerBg: surface,
    listBg: t.elevatedColor || defaults.elevatedColor,
    bodyText: t.textColor || defaults.textColor,
    mutedText: t.mutedTextColor || defaults.mutedTextColor,
  };
}

/**
 * The contrast ratio of body text on the info panel when it is below WCAG
 * AA (4.5:1), else null. The email wrapper swaps the panel text to a
 * readable neutral in that case; the settings page warns about it. Colours
 * the wrapper can't read (translucent, named, hsl()) return null, so no
 * warning shows for them — the wrapper leaves those alone too.
 */
export function lowListPanelContrast(bodyText: string, listBg: string): number | null {
  const text = toOpaqueHex(bodyText);
  const bg = toOpaqueHex(listBg);
  if (!text || !bg) return null;
  const ratio = contrastRatio(text, bg);
  return ratio < 4.5 ? ratio : null;
}
