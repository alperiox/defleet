export interface TourStep {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  body: string;
}

export const TOUR_STEPS: TourStep[];
export const TOUR_DONE_KEY: string;
export const CHECKLIST_DISMISSED_KEY: string;

export interface ChecklistItem {
  id: string;
  label: string;
  why: string;
  done: boolean;
  optional?: boolean;
  tab: string;
  hash: string;
}

export interface ChecklistState {
  hubReachable: boolean;
  deviceEnrolled: boolean;
  deviceCount: number;
  agentCreated: boolean;
  agentCount: number;
  taskCreated: boolean;
  taskCount: number;
  publicUrlConfigured: boolean;
  publicUrl: string | null;
  items: ChecklistItem[];
  completedCount: number;
  totalRequired: number;
  isComplete: boolean;
  isVisible: boolean;
}

export function computeChecklist(hubState?: any, dismissed?: boolean): ChecklistState;

export function shouldAutoOpenTour(options?: {
  storage?: { getItem(key: string): string | null } | null;
  params?: any;
  agentCount?: number;
  taskCount?: number;
}): boolean;
