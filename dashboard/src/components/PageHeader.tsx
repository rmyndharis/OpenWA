import type { ReactNode } from 'react';
import './PageHeader.css';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
}

/**
 * Shared page header component for consistent styling across all pages.
 *
 * @example
 * // Simple usage
 * <PageHeader title="Settings" subtitle="Configure application preferences" />
 *
 * @example
 * // With badge and actions
 * <PageHeader
 *   title="Dashboard"
 *   badge={<StatusBadge status="connected" />}
 *   subtitle="Overview of your WhatsApp sessions"
 *   actions={<button>Create New</button>}
 * />
 */
export function PageHeader({ title, subtitle, badge, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__title-group">
        <h1>{title}</h1>
        {badge && <span className="page-header__badge">{badge}</span>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
      {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
    </header>
  );
}
