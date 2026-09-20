import type { UserRole } from '../types/role';

export type RecruitmentCenterTabId =
  | 'flows'
  | 'diagram'
  | 'agenda'
  | 'recruitment'
  | 'candidates'
  | 'talent-bank'
  | 'tickets'
  | 'notifications'
  | 'privacy'
  | 'settings';

const OPERATOR_SIDEBAR_PATHS = new Set(['/chats', '/recruitment-center', '/talent-pool']);
/** @deprecated Compatibility name for extensions compiled before the product rename. */
export type TalentPoolTabId = RecruitmentCenterTabId;

const OPERATOR_RECRUITMENT_CENTER_TABS = new Set<RecruitmentCenterTabId>([
  'agenda',
  'recruitment',
  'candidates',
  'talent-bank',
  'tickets',
  'notifications',
]);

export function isSidebarPathAllowed(role: UserRole | null, path: string): boolean {
  return role !== 'operator' || OPERATOR_SIDEBAR_PATHS.has(path);
}

export function defaultAuthenticatedPath(role: UserRole | null): string {
  return role === 'operator' ? '/recruitment-center' : '/';
}

export function isRecruitmentCenterTabAllowed(role: UserRole | null, tab: RecruitmentCenterTabId): boolean {
  if (role === 'admin') return true;
  if (role === 'operator') return OPERATOR_RECRUITMENT_CENTER_TABS.has(tab);
  return false;
}

export function defaultRecruitmentCenterTab(role: UserRole | null): RecruitmentCenterTabId {
  return role === 'admin' ? 'flows' : 'agenda';
}

/** @deprecated Use isRecruitmentCenterTabAllowed. */
export const isTalentPoolTabAllowed = isRecruitmentCenterTabAllowed;
/** @deprecated Use defaultRecruitmentCenterTab. */
export const defaultTalentPoolTab = defaultRecruitmentCenterTab;

export function canManageHumanService(role: UserRole | null): boolean {
  return role === 'admin' || role === 'operator';
}
