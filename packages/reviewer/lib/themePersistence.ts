import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { webLocalStorage, type BloomThemeStorage } from '@oxyhq/bloom/theme';

/**
 * Single source of truth for where Bloom persists the active theme
 * (`{ mode?, colorPreset? }` as JSON). Every reader imports this key rather than
 * repeating the string, so no two of them can drift apart.
 */
export const BLOOM_THEME_PERSIST_KEY = 'crowdsource.bloom.theme';

/**
 * Platform-selected storage adapter for Bloom theme persistence.
 *
 * - Web: `webLocalStorage` (synchronous `localStorage`), so Bloom can hydrate
 *   before the first paint, avoiding a palette flash.
 * - Native: `AsyncStorage`. Its `getItem`/`setItem`/`removeItem` signatures are
 *   already `BloomThemeStorage`-compatible, so it's passed directly.
 *
 * `webLocalStorage` is `undefined` on native by design, so the native branch
 * must supply the AsyncStorage adapter explicitly.
 */
export const BLOOM_THEME_STORAGE: BloomThemeStorage =
    Platform.OS === 'web' && webLocalStorage ? webLocalStorage : AsyncStorage;
