export interface KeymapEntry {
  id: string;
  keys: string[];
  label: string;
  action: string;
  scope: "global" | "list" | "thread" | "needs" | "overlay";
}
export interface KeyState { pending: string; at: number }
export interface KeyResult { action: string | null; entry: KeymapEntry | null; pending: string; at: number }
export interface Conflict { sequence: string; actions: string[] }

export const SCOPES: string[];
export const DEFAULT_KEYMAP: KeymapEntry[];
export function prefixes(map: Map<string, KeymapEntry>): Set<string>;
export function buildMap(entries?: KeymapEntry[]): Map<string, KeymapEntry>;
export function toggleBinding(entries: KeymapEntry[], id: string, seq: string): KeymapEntry[];
export function sequenceConflicts(entries?: KeymapEntry[]): Conflict[];
export function validSequence(seq: string): boolean;
export function rebind(entries: KeymapEntry[], id: string, seq: string):
  | { ok: true; entries: KeymapEntry[] }
  | { ok: false; reason: string; with?: string; label?: string };
export function keyToken(event: { key?: string; isComposing?: boolean; keyCode?: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } | null): string | null;
export function isInsertTarget(node: { tagName?: string; isContentEditable?: boolean } | null): boolean;
export function reduceKey(state: KeyState, token: string | null, map: Map<string, KeymapEntry>, now?: number, timeout?: number): KeyResult;
export function hintText(pending: string): string;
export function clampIndex(index: number, length: number): number;
export function stepIndex(index: number, length: number, delta: number, wrap?: boolean): number;
