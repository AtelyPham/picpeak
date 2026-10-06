import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { LocalizedDateInput } from '../LocalizedDateInput';

// Stub the settings hook so the component doesn't need a QueryClient; falls
// back to the default DD.MM.YYYY display format. The parse/validation under
// test is separator-independent.
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ settings: {} }),
}));

describe('LocalizedDateInput', () => {
  const renderInput = (value = '2026-07-07') => {
    const onChange = vi.fn();
    render(<LocalizedDateInput value={value} onChange={onChange} />);
    const input = screen.getByDisplayValue('07.07.2026') as HTMLInputElement;
    return { input, onChange };
  };

  it('does not commit an impossible date mid-edit (regression: backspacing the day → "2026-07-00" crashed the page)', () => {
    const { input, onChange } = renderInput();
    // Backspacing a day digit leaves "0.07.2026" — a syntactically complete but
    // invalid date. It must NOT propagate (used to coerce to "2026-07-00",
    // which crashed date-fns format() downstream).
    fireEvent.change(input, { target: { value: '0.07.2026' } });
    expect(onChange).not.toHaveBeenCalled();

    // Nor may an out-of-range calendar date (31 Feb).
    fireEvent.change(input, { target: { value: '31.02.2026' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a complete, valid date as ISO', () => {
    const { input, onChange } = renderInput();
    fireEvent.change(input, { target: { value: '15.08.2026' } });
    expect(onChange).toHaveBeenCalledWith('2026-08-15');
  });

  it('focuses the native date input when opening the calendar, so leaving it closes the calendar', () => {
    const focusedWhenOpened: Array<Element | null> = [];
    const showPicker = vi.fn(function (this: HTMLInputElement) { focusedWhenOpened.push(document.activeElement); });
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', { value: showPicker, configurable: true });
    const { container } = render(<LocalizedDateInput label="Valid until" value="" onChange={vi.fn()} />);
    const native = container.querySelector('input[type="date"]') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: 'Valid until' }));
    expect(showPicker).toHaveBeenCalledTimes(1);
    // Browsers close the calendar when this input loses focus; it has to hold
    // focus while the calendar is open.
    expect(focusedWhenOpened[0]).toBe(native);
    delete (HTMLInputElement.prototype as Partial<HTMLInputElement>).showPicker;
  });

  it('returns focus to the visible field once a date is picked', () => {
    const onChange = vi.fn();
    const { container } = render(<LocalizedDateInput label="Valid until" value="" onChange={onChange} />);
    const native = container.querySelector('input[type="date"]') as HTMLInputElement;
    native.focus();
    fireEvent.change(native, { target: { value: '2026-09-16' } });
    expect(onChange).toHaveBeenCalledWith('2026-09-16');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Valid until' }));
  });
});
