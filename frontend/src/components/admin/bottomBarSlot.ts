import { createContext, useContext } from 'react';

/**
 * The element at the bottom of the admin content column that page-level
 * bottom bars (SettingsSaveBar) render into. It sits after <main>, which
 * fills the column, so the bar is at the bottom of the window on a short
 * page and sticks to it on a long one. Null outside AdminLayout.
 */
export const BottomBarSlotContext = createContext<HTMLElement | null>(null);

export const useBottomBarSlot = () => useContext(BottomBarSlotContext);
