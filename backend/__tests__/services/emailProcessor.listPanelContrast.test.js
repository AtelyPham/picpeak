/**
 * The info panel (<ul>) in wrapEmailHtml had a background colour but no text
 * colour, so its text inherited the body text colour. A dark email palette
 * with a light info panel rendered near-white text on a near-white box in
 * every list-bearing mail (pre-event reminder, gallery delivery, ...).
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

const COLOR_KEYS = [
  'email_primary_color', 'email_secondary_color', 'email_body_bg_color',
  'email_container_bg_color', 'email_list_bg_color', 'email_body_text_color',
  'email_muted_text_color', 'email_button_text_color',
];

describe('wrapEmailHtml — info panel text stays readable', () => {
  let db; let cleanup; let wrapEmailHtml; let upsertAppSetting;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
    ({ upsertAppSetting } = require('../../src/utils/appSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  async function setColors(values) {
    await db('app_settings').whereIn('setting_key', COLOR_KEYS).del();
    for (const [key, value] of Object.entries(values)) {
      await upsertAppSetting(key, JSON.stringify(value), 'string');
    }
  }

  const BODY = '<p>Hi</p><ul>\n  <li>One <strong>bold</strong></li>\n</ul>';

  it('uses a dark neutral for list text on a light panel in a dark palette', async () => {
    await setColors({
      email_container_bg_color: '#1c1c1c',
      email_body_text_color: '#e5e5e5',
      email_list_bg_color: '#f5f5f5',
    });
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toMatch(/\.email-content ul \{\s*background-color: #f5f5f5;\s*color: #333333;/);
    expect(html).toMatch(/\.email-content ul strong \{\s*color: #333333;/);
    expect(html).toContain('<ul style="background-color:#f5f5f5;color:#333333;');
    // Paragraph text keeps the admin's colour.
    expect(html).toContain('color:#e5e5e5;');
  });

  it('keeps the body text colour when it already reads on the panel', async () => {
    await setColors({});
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toContain('<ul style="background-color:#f9f9f9;color:#333333;');

    await setColors({
      email_container_bg_color: '#1a1a1a',
      email_body_text_color: '#e5e5e5',
      email_list_bg_color: '#242424',
    });
    const dark = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(dark).toContain('<ul style="background-color:#242424;color:#e5e5e5;');
  });

  it('keeps list styling in <style> only when the body brings its own <style>', async () => {
    await setColors({});
    const html = await wrapEmailHtml(`<style>.mine ul { background: #000; }</style>${BODY}`, 'Subject', 'en');
    expect(html).toContain('<ul>');
    expect(html).not.toContain('<ul style=');
    expect(html).toMatch(/\.email-content ul \{\s*background-color: #f9f9f9;\s*color: #333333;/);
  });

  it('checks rgb() colours end to end', async () => {
    await setColors({
      email_container_bg_color: 'rgb(28, 28, 28)',
      email_body_text_color: 'rgb(229, 229, 229)',
      email_list_bg_color: 'rgb(245, 245, 245)',
    });
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toContain('<ul style="background-color:rgb(245, 245, 245);color:#333333;');
  });

  it('keeps a translucent panel colour and the text colour the admin chose', async () => {
    await setColors({ email_body_text_color: '#333333', email_list_bg_color: 'rgba(0,0,0,0.05)' });
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toContain('<ul style="background-color:rgba(0,0,0,0.05);color:#333333;');
  });

  it('checks links inside the panel against the panel too', async () => {
    await setColors({ email_primary_color: '#014e4e', email_list_bg_color: '#242424', email_body_text_color: '#e5e5e5' });
    const html = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(html).toMatch(/\.email-content ul a,\s*\.email-content ul a:hover \{\s*color: #f5f5f5;/);

    await setColors({});
    const light = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(light).toMatch(/\.email-content ul a,\s*\.email-content ul a:hover \{\s*color: #5C8762;/);
  });

  it('leaves a <ul> the template styled itself alone', async () => {
    await setColors({});
    const html = await wrapEmailHtml('<ul class="x" style="color:red"><li>a</li></ul>', 'Subject', 'en');
    expect(html).toContain('<ul class="x" style="color:red">');
    const tight = await wrapEmailHtml('<ul class="x"style="color:red"><li>a</li></ul>', 'Subject', 'en');
    expect(tight).toContain('<ul class="x"style="color:red">');
    expect(tight).not.toMatch(/<ul style=/);
  });

  it('derives the footer divider from a dark footer instead of a bright #eeeeee stripe', async () => {
    await setColors({ email_secondary_color: '#141414', email_container_bg_color: '#1c1c1c' });
    const dark = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(dark).not.toContain('#eeeeee');
    expect(dark).toMatch(/\.email-footer \{[^}]*border-top: 1px solid #2c2c2c;/);
    expect(dark).toContain('text-align:center;border-top:1px solid #2c2c2c;');

    await setColors({});
    const light = await wrapEmailHtml(BODY, 'Subject', 'en');
    expect(light).toContain('text-align:center;border-top:1px solid #eeeeee;');
  });
});
