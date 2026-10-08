const { parseColor, contrastRatio, readableTextOn, dividerOn } = require('../../src/utils/colorContrast');

describe('colorContrast', () => {
  it('parses opaque hex and rgb()/rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#1C1C1C')).toEqual({ r: 28, g: 28, b: 28 });
    expect(parseColor('#000f')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor('#1c1c1cff')).toEqual({ r: 28, g: 28, b: 28 });
    expect(parseColor('rgb(102, 102, 102)')).toEqual({ r: 102, g: 102, b: 102 });
    expect(parseColor('rgba(0, 0, 0, 1)')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor('rgb(0 0 0 / 100%)')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('returns null for translucent colours — what shows through is unknown', () => {
    expect(parseColor('#1c1c1c80')).toBeNull();
    expect(parseColor('#0008')).toBeNull();
    expect(parseColor('#00000000')).toBeNull();
    expect(parseColor('rgba(0,0,0,0.05)')).toBeNull();
    expect(parseColor('rgba(0 0 0 / 50%)')).toBeNull();
    // ...so the admin's colours are kept, as on main.
    expect(readableTextOn('rgba(0,0,0,0.05)', '#333333')).toBe('#333333');
    expect(readableTextOn('#00000000', '#333333')).toBe('#333333');
    expect(dividerOn('#00000000')).toBe('#eeeeee');
  });

  it('returns null for colours it cannot read', () => {
    expect(parseColor('white')).toBeNull();
    expect(parseColor('hsl(0, 0%, 100%)')).toBeNull();
    expect(parseColor('rgb(300, 0, 0)')).toBeNull();
    expect(contrastRatio('white', '#000000')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('keeps the preferred text colour when it already reads on the panel', () => {
    // Default palette: #333333 on #f9f9f9.
    expect(readableTextOn('#f9f9f9', '#333333')).toBe('#333333');
    // Consistent dark palette: light text on a dark panel.
    expect(readableTextOn('#242424', '#e5e5e5')).toBe('#e5e5e5');
  });

  it('switches to a dark neutral for light text on a light panel', () => {
    expect(readableTextOn('#f5f5f5', '#e5e5e5')).toBe('#333333');
  });

  it('switches to a light neutral for dark text on a dark panel', () => {
    expect(readableTextOn('#242424', '#333333')).toBe('#f5f5f5');
  });

  it('never replaces a colour with one that reads worse (mid-grey panels)', () => {
    // Neither #333333 nor #f5f5f5 reaches 4.5:1 here; black does.
    expect(readableTextOn('#777777', '#111111')).toBe('#000000');
    expect(readableTextOn('#808080', '#1a1a1a')).toBe('#000000');
    for (const bg of ['#717171', '#777777', '#808080', '#8a8a8a', '#9a9a9a']) {
      for (const text of ['#111111', '#1a1a1a', '#e5e5e5', '#ffffff', '#5c8762']) {
        const picked = readableTextOn(bg, text);
        expect(contrastRatio(picked, bg)).toBeGreaterThanOrEqual(Math.min(4.5, contrastRatio(text, bg)));
        expect(contrastRatio(picked, bg)).toBeGreaterThanOrEqual(contrastRatio(text, bg));
      }
    }
  });

  it('leaves colours it cannot read untouched', () => {
    expect(readableTextOn('white', 'whitesmoke')).toBe('whitesmoke');
  });

  it('keeps the #eeeeee divider on light and unparseable backgrounds', () => {
    expect(dividerOn('#f9f9f9')).toBe('#eeeeee');
    expect(dividerOn('#ffffff')).toBe('#eeeeee');
    expect(dividerOn('whitesmoke')).toBe('#eeeeee');
  });

  it('lifts a dark background 10% towards white for the divider', () => {
    expect(dividerOn('#141414')).toBe('#2c2c2c');
    expect(dividerOn('#000000')).toBe('#1a1a1a');
  });
});
