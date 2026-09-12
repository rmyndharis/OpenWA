// Role types for RBAC
export type UserRole = 'admin' | 'operator' | 'companion_operator' | 'viewer';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isCompanionOperator: boolean;
  isViewer: boolean;
  canWrite: boolean;
  canAccessOpenWaQueues: boolean;
}
