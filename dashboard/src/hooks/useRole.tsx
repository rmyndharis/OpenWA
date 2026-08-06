import { createContext, useContext } from 'react';
import type { RoleContextType } from '../types/role';

export type { UserRole, RoleContextType } from '../types/role';

export const RoleContext = createContext<RoleContextType | undefined>(undefined);

export function useRole(): RoleContextType {
  const context = useContext(RoleContext);
  if (context === undefined) {
    throw new Error('useRole must be used within a RoleProvider');
  }
  return context;
}
