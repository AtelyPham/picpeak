/**
 * The route guard, exercised through the router rather than by reading the
 * source. Two pages moved out of Settings into sections, and Settings was the
 * thing gating them: it filters its tabs by permission and snaps away from one
 * the role cannot see. A section opens as soon as ANY item in it is permitted,
 * so both pages need the gate stated on the route.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';

let granted = new Set<string>();
let permissionsLoading = false;

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => granted.has(p),
    hasAnyPermission: (perms: string[]) => perms.some((p) => granted.has(p)),
    isLoading: permissionsLoading,
  }),
}));

import { RequirePermission } from '../RequirePermission';

function renderAt(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/dashboard" element={<p>dashboard</p>} />
        <Route element={element}>
          <Route path="/admin/automation/workflows" element={<p>workflow builder</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); granted = new Set(); permissionsLoading = false; });

describe('RequirePermission', () => {
  it('renders the page for a role that holds the permission', () => {
    granted = new Set(['workflows.view']);
    renderAt('/admin/automation/workflows', <RequirePermission permission="workflows.view" />);
    expect(screen.getByText('workflow builder')).toBeInTheDocument();
  });

  it('redirects a role that does not, rather than letting the page 403 itself', () => {
    granted = new Set(['email.view']); // enough to enter Automation, not this page
    renderAt('/admin/automation/workflows', <RequirePermission permission="workflows.view" />);
    expect(screen.queryByText('workflow builder')).not.toBeInTheDocument();
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('renders nothing at all until permissions have loaded', () => {
    // The context starts with an empty list, so acting early would bounce
    // every role on a hard refresh.
    permissionsLoading = true;
    granted = new Set();
    renderAt('/admin/automation/workflows', <RequirePermission permission="workflows.view" />);
    expect(screen.queryByText('workflow builder')).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('accepts any one of several permissions', () => {
    granted = new Set(['system.view']);
    renderAt('/admin/automation/workflows',
      <RequirePermission anyOf={['settings.view', 'system.view']} />);
    expect(screen.getByText('workflow builder')).toBeInTheDocument();
  });
});
