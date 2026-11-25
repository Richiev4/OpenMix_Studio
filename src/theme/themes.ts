import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { AutomationParam } from '../types/audio';

export type ThemeId = 'studio-amber' | 'om-neon';

export interface ThemeCanvasPalette {
  bgDeepest: string;
  bgBase: string;
  bgPanel: string;
  bgCard: string;
  accent: string;
  accentBright: string;
  accentGlowRgba: string;
  accentLineRgba: string;
  accentFillRgba: string;
  accentFillSoftRgba: string;
  secondary: string;
  secondaryBright: string;
  secondaryLineRgba: string;
  secondaryFillRgba: string;
  secondaryFillSoftRgba: string;
  positive: string;
  positiveBright: string;
  positiveLineRgba: string;
  positiveFillRgba: string;
  danger: string;
  dangerSoft: string;
  textPrimary: string;
  textMuted: string;
  textSubtle: string;
  gridBarRgba: string;
  meterLow: string;
  meterMid: string;
  meterHigh: string;
  meterClip: string;
  meterHoldLow: string;
  meterHoldMid: string;
  meterHoldHigh: string;
  meterMaskRgba: string;
  knobTrack: string;
  knobFace: string;
  knobNeutral: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  shortName: string;
  description: string;
  swatches: readonly [string, string, string];
  trackAccents: readonly [string, string, string, string, string];
  automationColors: Record<AutomationParam, string>;
  canvas: ThemeCanvasPalette;
}

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  'studio-amber': {
    id: 'studio-amber',
    name: 'Studio Amber',
    shortName: 'Studio Amber',
    description: 'Original matte charcoal with warm amber, cyan, and emerald accents',
    swatches: ['#F59E0B', '#06B6D4', '#10B981'],
    trackAccents: ['#F59E0B', '#06B6D4', '#10B981', '#A78BFA', '#F472B6'],
    automationColors: {
      volume: '#F59E0B',
      pan: '#06B6D4',
      filterCutoff: '#10B981',
      fxWet: '#A78BFA',
      speed: '#F472B6',
    },
    canvas: {
      bgDeepest: '#090B0E',
      bgBase: '#0B0D10',
      bgPanel: '#13161B',
      bgCard: '#141922',
      accent: '#F59E0B',
      accentBright: '#FBBF24',
      accentGlowRgba: 'rgba(245, 158, 11, 0.7)',
      accentLineRgba: 'rgba(245, 158, 11, 0.88)',
      accentFillRgba: 'rgba(245, 158, 11, 0.10)',
      accentFillSoftRgba: 'rgba(245, 158, 11, 0.08)',
      secondary: '#06B6D4',
      secondaryBright: '#22D3EE',
      secondaryLineRgba: 'rgba(6, 182, 212, 0.9)',
      secondaryFillRgba: 'rgba(34, 211, 238, 0.14)',
      secondaryFillSoftRgba: 'rgba(6, 182, 212, 0.09)',
      positive: '#10B981',
      positiveBright: '#34D399',
      positiveLineRgba: 'rgba(16, 185, 129, 0.45)',
      positiveFillRgba: 'rgba(16, 185, 129, 0.12)',
      danger: '#EF4444',
      dangerSoft: '#FCA5A5',
      textPrimary: '#E6EAF0',
      textMuted: '#94A3B8',
      textSubtle: 'rgba(141, 150, 166, 0.7)',
      gridBarRgba: 'rgba(6, 182, 212, 0.32)',
      meterLow: '#10B981',
      meterMid: '#F59E0B',
      meterHigh: '#F59E0B',
      meterClip: '#EF4444',
      meterHoldLow: '#34D399',
      meterHoldMid: '#FBBF24',
      meterHoldHigh: '#FCA5A5',
      meterMaskRgba: 'rgba(11, 13, 16, 0.42)',
      knobTrack: '#232832',
      knobFace: '#1A1E26',
      knobNeutral: '#E6EAF0',
    },
  },
  'om-neon': {
    id: 'om-neon',
    name: 'OM Neon',
    shortName: 'OM Neon',
    description: 'Deep obsidian grid with electric cyan, cobalt, violet, and neon magenta',
    swatches: ['#22E4FF', '#7C5CFF', '#D946EF'],
    trackAccents: ['#22E4FF', '#D946EF', '#7C5CFF', '#3B82F6', '#F472B6'],
    automationColors: {
      volume: '#22E4FF',
      pan: '#D946EF',
      filterCutoff: '#7C5CFF',
      fxWet: '#3B82F6',
      speed: '#F472B6',
    },
    canvas: {
      bgDeepest: '#080B11',
      bgBase: '#0B0F17',
      bgPanel: '#121826',
      bgCard: '#161E30',
      accent: '#22E4FF',
      accentBright: '#67F0FF',
      accentGlowRgba: 'rgba(34, 228, 255, 0.78)',
      accentLineRgba: 'rgba(34, 228, 255, 0.92)',
      accentFillRgba: 'rgba(34, 228, 255, 0.12)',
      accentFillSoftRgba: 'rgba(34, 228, 255, 0.08)',
      secondary: '#D946EF',
      secondaryBright: '#F06BFF',
      secondaryLineRgba: 'rgba(217, 70, 239, 0.9)',
      secondaryFillRgba: 'rgba(240, 107, 255, 0.16)',
      secondaryFillSoftRgba: 'rgba(217, 70, 239, 0.10)',
      positive: '#7C5CFF',
      positiveBright: '#A78BFA',
      positiveLineRgba: 'rgba(124, 92, 255, 0.55)',
      positiveFillRgba: 'rgba(124, 92, 255, 0.15)',
      danger: '#FB4D72',
      dangerSoft: '#FDA4AF',
      textPrimary: '#EDF4FF',
      textMuted: '#93A7C9',
      textSubtle: 'rgba(147, 167, 201, 0.72)',
      gridBarRgba: 'rgba(124, 92, 255, 0.36)',
      meterLow: '#22E4FF',
      meterMid: '#7C5CFF',
      meterHigh: '#D946EF',
      meterClip: '#FB4D72',
      meterHoldLow: '#67F0FF',
      meterHoldMid: '#F06BFF',
      meterHoldHigh: '#FDA4AF',
      meterMaskRgba: 'rgba(8, 11, 17, 0.46)',
      knobTrack: '#25314D',
      knobFace: '#192236',
      knobNeutral: '#EDF4FF',
    },
  },
};

export const THEME_LIST: readonly ThemeDefinition[] = [
  THEMES['studio-amber'],
  THEMES['om-neon'],
];

const THEME_STORAGE_KEY = 'openmix.theme.v1';

export function loadSavedThemeId(): ThemeId {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'studio-amber' || raw === 'om-neon') {
      return raw;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return 'studio-amber';
}

export function saveThemeId(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Ignore storage write errors
  }
}

export function applyThemeToDocument(id: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id;
  }
}

const KNOWN_ACCENT_INDEX_MAP = new Map<string, number>();
for (const def of THEME_LIST) {
  def.trackAccents.forEach((hex, idx) => {
    const upper = hex.toUpperCase();
    if (!KNOWN_ACCENT_INDEX_MAP.has(upper)) {
      KNOWN_ACCENT_INDEX_MAP.set(upper, idx);
    }
  });
}

/**
 * Resolves a track's display accent color for the active theme.
 * Tracks using default theme colors automatically adapt when switching themes.
 */
export function resolveTrackAccentColor(
  storedAccent: string,
  trackIndex: number,
  themeId: ThemeId
): string {
  const palette = THEMES[themeId].trackAccents;
  const upper = storedAccent.toUpperCase();
  const knownSlot = KNOWN_ACCENT_INDEX_MAP.get(upper);
  if (knownSlot !== undefined) {
    return palette[knownSlot % palette.length];
  }
  if (!storedAccent) {
    return palette[trackIndex % palette.length];
  }
  return storedAccent;
}

interface ThemeContextValue {
  themeId: ThemeId;
  theme: ThemeDefinition;
  setThemeId: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeId: 'studio-amber',
  theme: THEMES['studio-amber'],
  setThemeId: () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => {
    const initial = loadSavedThemeId();
    applyThemeToDocument(initial);
    return initial;
  });

  useEffect(() => {
    applyThemeToDocument(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      theme: THEMES[themeId],
      setThemeId: setThemeIdState,
    }),
    [themeId]
  );

  return React.createElement(ThemeContext.Provider, { value }, children);
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
