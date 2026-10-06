import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { usePermissions } from '../../contexts/PermissionsContext';

interface RequirePermissionProps {
  /** Single required permission. Mutually exclusive with `anyOf`. */
  permission?: string;
  /** Reachable while the role holds ANY of these. */
  anyOf?: string[];
  fallback?: string;
}

/**
 * Route guard that redirects when the role lacks the permission behind a
 * page. The sibling of RequireFeature, and deliberately the same shape: a
 * feature flag says the surface exists, a permission says this admin may open
 * it, and a section may need both.
 *
 * This exists because a page that moved out of Settings lost the gate it used
 * to inherit. Settings filters its tabs by `SETTINGS_TAB_PERMISSIONS` and
 * snaps away from one the role cannot see, so a Settings-hosted page was
 * gated by virtue of living there. A page inside a section is reachable as
 * soon as the section is, which is a weaker rule — the section opens when
 * ANY item in it is permitted.
 *
 * Super admin is already handled inside `hasPermission` / `hasAnyPermission`,
 * so there is no bypass here.
 *
 * Mounted as the `element` of a parent <Route>, with the gated routes as
 * children — see App.tsx.
 */
export const RequirePermission: React.FC<RequirePermissionProps> = ({
  permission,
  anyOf,
  fallback = '/admin/dashboard',
}) => {
  const { hasAnyPermission, isLoading } = usePermissions();
  // Wait for the first fetch. The context starts out with an empty permission
  // list, so acting early would redirect every role on a hard refresh.
  if (isLoading) return null;
  const required = anyOf?.length ? anyOf : (permission ? [permission] : []);
  if (required.length > 0 && !hasAnyPermission(required)) {
    return <Navigate to={fallback} replace />;
  }
  return <Outlet />;
};
