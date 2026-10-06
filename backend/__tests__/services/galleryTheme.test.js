/**
 * A gallery renders the global Branding theme unless custom styling is on;
 * the migration 259 backfill switches it on only where turning it off would
 * change the gallery's look.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
const { usesCustomTheme, publicThemeFields, effectiveCssTemplateId } = require('../../src/services/galleryTheme');
const { storedThemeIsCustom } = require('../../migrations/core/259_gallery_admin_cleanup');

const branding = { headerStyle: 'minimal', heroDividerStyle: 'angle', colors: { primary: '#123456' }, cssTemplateId: 4, logoUrl: '/a.png' };
const ownTheme = JSON.stringify({ headerStyle: 'hero', heroDividerStyle: 'curve', colors: { primary: '#abcdef' } });

describe('galleryTheme', () => {
  it('serves the Branding theme while custom styling is off', async () => {
    const event = { custom_theme_enabled: 0, color_theme: ownTheme, header_style: 'hero', hero_divider_style: 'curve', css_template_id: 9 };
    expect(await publicThemeFields(event, branding)).toEqual({ color_theme: null, header_style: 'minimal', hero_divider_style: 'angle' });
    expect(await effectiveCssTemplateId(event, branding)).toBe(4);
  });

  it('serves the gallery\'s own theme while custom styling is on', async () => {
    const event = { custom_theme_enabled: true, color_theme: ownTheme, header_style: 'hero', hero_divider_style: 'curve', css_template_id: 9 };
    expect(await publicThemeFields(event, branding)).toEqual({ color_theme: ownTheme, header_style: 'hero', hero_divider_style: 'curve' });
    expect(await effectiveCssTemplateId(event, branding)).toBe(9);
  });

  it('falls back to defaults without a Branding theme', async () => {
    expect(await publicThemeFields({ custom_theme_enabled: false }, null))
      .toEqual({ color_theme: null, header_style: 'standard', hero_divider_style: 'wave' });
    expect(await effectiveCssTemplateId({ custom_theme_enabled: false }, null)).toBeNull();
  });

  it('keeps the old rule for a row read without the column', () => {
    expect(usesCustomTheme({ color_theme: ownTheme })).toBe(true);
    expect(usesCustomTheme({ css_template_id: 2 })).toBe(true);
    expect(usesCustomTheme({ color_theme: null })).toBe(false);
  });
});

describe('migration 259 backfill', () => {
  it('leaves galleries without a theme on Branding', () => {
    expect(storedThemeIsCustom({ color_theme: null, css_template_id: null }, branding)).toBe(false);
  });

  it('treats an exact copy of Branding as not custom, ignoring logo and name', () => {
    const copy = JSON.stringify({ name: 'x', colors: { primary: '#123456' }, heroDividerStyle: 'angle', headerStyle: 'minimal', cssTemplateId: 4 });
    expect(storedThemeIsCustom({ color_theme: copy, css_template_id: null }, branding)).toBe(false);
  });

  it('keeps a differing theme, a preset name and a CSS template custom', () => {
    expect(storedThemeIsCustom({ color_theme: ownTheme, css_template_id: null }, branding)).toBe(true);
    expect(storedThemeIsCustom({ color_theme: 'elegantWedding', css_template_id: null }, branding)).toBe(true);
    expect(storedThemeIsCustom({ color_theme: null, css_template_id: 3 }, branding)).toBe(true);
  });

  it('keeps any theme custom when there is no Branding theme to compare with', () => {
    expect(storedThemeIsCustom({ color_theme: ownTheme, css_template_id: null }, null)).toBe(true);
  });
});
