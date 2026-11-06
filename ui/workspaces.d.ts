export const UNIVERSAL_VIEWS: Set<string>;
export interface Route { view: string; arg: string }
export interface RouteScope { agents: string[]; tasks: string[]; chats: string[] }
export interface Update {
  kind: "request" | "message" | "task";
  title: string;
  hash: string;
  fromAgent?: string;
  thread?: string;
  workspace?: string;
  taskWorkspace?: string;
  workspaceId?: string | null;
}
export function routeProblem(route: Route, scope: RouteScope): "agent" | "task" | "chat" | "unknown" | null;
export function workspaceOfUpdate(update: Update, context: { agentWorkspace?: Record<string, string> }): string | null;
export function splitUpdates(updates: Update[], activeWorkspace: string): { other: Update[]; active: Update[] };
export function beepDue(lastBeepAt: number, now: number, gapMs?: number): boolean;
export function workspaceLabel(name: string, waiting?: number, fresh?: number): string;
export function toastLine(workspaceName: string, update: Update): string;
export function toastMore(count: number): string;
