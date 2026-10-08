import { describe, expect, it } from 'vitest';
import { emailColorsFromBranding, lowListPanelContrast, toOpaqueHex } from '../emailBrandingSync';

describe('emailColorsFromBranding', () => {
  it('maps a full theme token for token', () => {
    expect(emailColorsFromBranding({
      accentDarkColor: '#225544',
      backgroundColor: '#0f0f0f',
      surfaceColor: '#1a1a1a',
      elevatedColor: '#2a2a2a',
      textColor: '#eeeeee',
      mutedTextColor: '#999999',
    })).toEqual({
      primary: '#225544',
      secondary: '#1a1a1a',
      bodyBg: '#0f0f0f',
      containerBg: '#1a1a1a',
      listBg: '#2a2a2a',
      bodyText: '#eeeeee',
      mutedText: '#999999',
    });
  });

  it('fills a dark theme without elevatedColor with a dark info panel', () => {
    const c = emailColorsFromBranding({ colorMode: 'dark', surfaceColor: '#1c1c1c', textColor: '#e5e5e5' });
    expect(c.listBg).toBe('#242424');
    expect(c.bodyBg).toBe('#0f0f0f');
  });

  it('reads the mode off the background when colorMode is unset or auto', () => {
    expect(emailColorsFromBranding({ backgroundColor: '#111111' }).listBg).toBe('#242424');
    expect(emailColorsFromBranding({ colorMode: 'auto', surfaceColor: '#121212' }).listBg).toBe('#242424');
    expect(emailColorsFromBranding({ backgroundColor: '#fafafa' }).listBg).toBe('#f5f5f5');
  });

  it('keeps the previous light defaults for an empty theme', () => {
    expect(emailColorsFromBranding({})).toEqual({
      primary: '#5C8762',
      secondary: '#ffffff',
      bodyBg: '#fafafa',
      containerBg: '#ffffff',
      listBg: '#f5f5f5',
      bodyText: '#171717',
      mutedText: '#737373',
    });
    expect(emailColorsFromBranding(undefined).listBg).toBe('#f5f5f5');
  });
});

describe('lowListPanelContrast', () => {
  it('returns the ratio when body text fails AA on the panel', () => {
    const ratio = lowListPanelContrast('#e5e5e5', '#f5f5f5');
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeLessThan(1.2);
  });

  it('warns for every colour form the email wrapper corrects', () => {
    expect(lowListPanelContrast('#eee', '#f5f5f5')).not.toBeNull();
    expect(lowListPanelContrast('#eeef', '#f5f5f5ff')).not.toBeNull();
    expect(lowListPanelContrast('rgb(229, 229, 229)', 'rgba(245, 245, 245, 1)')).not.toBeNull();
  });

  it('returns null for readable pairs and for colours the wrapper leaves alone', () => {
    expect(lowListPanelContrast('#333333', '#f9f9f9')).toBeNull();
    expect(lowListPanelContrast('#e5e5e5', '#242424')).toBeNull();
    expect(lowListPanelContrast('white', '#f5f5f5')).toBeNull();
    expect(lowListPanelContrast('#e5e5e5', 'rgba(0,0,0,0.05)')).toBeNull();
    expect(lowListPanelContrast('#e5e5e5', '#f5f5f580')).toBeNull();
  });
});

describe('toOpaqueHex', () => {
  it('normalises opaque hex and rgb() and rejects translucent or unknown forms', () => {
    expect(toOpaqueHex('#ABC')).toBe('#aabbcc');
    expect(toOpaqueHex('#000f')).toBe('#000000');
    expect(toOpaqueHex('#1c1c1cff')).toBe('#1c1c1c');
    expect(toOpaqueHex('rgb(0 0 0 / 100%)')).toBe('#000000');
    expect(toOpaqueHex('#1c1c1c80')).toBeNull();
    expect(toOpaqueHex('rgba(0,0,0,0.5)')).toBeNull();
    expect(toOpaqueHex('hsl(0, 0%, 0%)')).toBeNull();
    expect(toOpaqueHex(undefined)).toBeNull();
  });
});
