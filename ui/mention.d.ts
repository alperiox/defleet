export function mentionAt(text: string, caret: number): { start: number; query: string } | null;
export function suggestAgents<T extends { name: string; online?: boolean }>(agents: T[], query: string): T[];
export function applyMention(text: string, mention: { start: number; query: string }, name: string): { text: string; caret: number };
