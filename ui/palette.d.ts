import type { KeymapEntry } from "./keys.d";

export function fuzzyScore(query: unknown, text: unknown): number | null;

export interface PaletteItem {
  kind: string;
  label: string;
  detail?: string;
  keywords?: string[];
  target: string;
}

export function rankItems<T extends { label: string; keywords?: string[] }>(query: unknown, items?: T[]): T[];

export const PALETTE_KINDS: string[];
export const VERB_KIND: Record<string, string>;

export function parseCommand(query: unknown): { kind: string | null; arg: string };

export function paletteItems(source?: {
  agents?: Array<{ name: string; external?: boolean; status?: string }>;
  workspaces?: Array<{ id: string; name: string }>;
  tasks?: Array<{ key?: string; id?: string; title: string; status?: string }>;
  tabs?: Array<{ view: string; label: string }>;
  keymapActions?: KeymapEntry[];
  tour?: boolean;
}): PaletteItem[];

export const KEYMAP_STORE: string;

/** Only what hoisting-safe code can rely on: the two calls the overrides live and die by. */
export interface OverrideStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readOverrides(storage: OverrideStorage): Record<string, string>;
export function writeOverrides(storage?: OverrideStorage | Window, overrides?: Record<string, string>): void;
export function overridesFor(entries: KeymapEntry[], defaults: KeymapEntry[]): Record<string, string>;
export function saveKeymap(storage?: OverrideStorage | Window, entries?: KeymapEntry[], defaults?: KeymapEntry[]): void;
export function loadKeymap(storage: OverrideStorage, defaults: KeymapEntry[]): { entries: KeymapEntry[]; overrides: Record<string, string> };
