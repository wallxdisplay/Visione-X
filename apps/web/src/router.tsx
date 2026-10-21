import type { ReactNode } from 'react';
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router';
import { AuthProvider } from './auth/AuthProvider';
import { CustomerGate, RedirectIfSignedIn, RequirePlatformStaff, RequireStaffSecondFactor, RequireUser } from './auth/guards';
import { SECURITY_PATH } from './auth/mfa';
import { AcceptInvite } from './pages/AcceptInvite';
import { AdminBilling } from './pages/admin/AdminBilling';
import { AdminDevices } from './pages/admin/AdminDevices';
import { AdminPlayers } from './pages/admin/AdminPlayers';
import { AdminSettings } from './pages/admin/AdminSettings';
import { AdminSupport } from './pages/admin/AdminSupport';
import { AdminResellers } from './pages/admin/AdminResellers';
import { AdminFeatures } from './pages/admin/AdminFeatures';
import { AdminOverview } from './pages/admin/AdminOverview';
import { OrgBilling } from './pages/admin/OrgBilling';
import { Billing } from './pages/billing/Billing';
import { Integrations } from './pages/integrations/Integrations';
import { PlaybackReports } from './pages/reports/PlaybackReports';
import { Analytics } from './pages/analytics/Analytics';
import { ApiAccess } from './pages/api/ApiAccess';
import { AdminApi } from './pages/admin/AdminApi';
import { SyncGroups } from './pages/content/SyncGroups';
import { ApprovalReview } from './pages/admin/ApprovalReview';
import { Approvals } from './pages/admin/Approvals';
import { AuditLogs } from './pages/admin/AuditLogs';
import { Orgs } from './pages/admin/Orgs';
import { PlatformUsers } from './pages/admin/PlatformUsers';
import { AccountSecurity } from './pages/auth/AccountSecurity';
import { ForgotPassword } from './pages/auth/ForgotPassword';
import { SignIn } from './pages/auth/SignIn';
import { SignUp } from './pages/auth/SignUp';
import { VerifyEmail } from './pages/auth/VerifyEmail';
import { Library } from './pages/content/Library';
import { PlaylistEditor } from './pages/content/PlaylistEditor';
import { Playlists } from './pages/content/Playlists';
import { Schedules } from './pages/content/Schedules';
import { Screens } from './pages/content/Screens';
import { StudioEditor } from './pages/content/StudioEditor';
import { StudioList } from './pages/content/StudioList';
import { Alerts } from './pages/sensors/Alerts';
import { SensorDetail } from './pages/sensors/SensorDetail';
import { Sensors } from './pages/sensors/Sensors';
import { Dashboard } from './pages/customer/Dashboard';
import { OrgSettings } from './pages/customer/OrgSettings';
import { Sites } from './pages/customer/Sites';
import { Team } from './pages/customer/Team';
import { Help } from './pages/customer/Help';
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/onboarding/Onboarding';
import { Placeholder } from './pages/Placeholder';
import { PlayerRegistration } from './pages/PlayerRegistration';
import { AppShell } from './shell/AppShell';
import { adminNav, customerNav, partnerNav, type NavGroup } from './shell/nav';
import { PartnerGate } from './partner/PartnerProvider';
import { PartnerBilling } from './pages/partner/PartnerBilling';
import { PartnerCustomers } from './pages/partner/PartnerCustomers';
import { PartnerTeam } from './pages/partner/PartnerTeam';
import { PartnerBranding } from './pages/partner/PartnerBranding';
import { AdminWhiteLabel } from './pages/admin/AdminWhiteLabel';
import { AdminApps } from './pages/admin/AdminApps';
import { ActivityLog } from './pages/customer/ActivityLog';
import { AdminCosts } from './pages/admin/AdminCosts';
import { AppStore } from './pages/billing/AppStore';
import { DomainBrandProvider } from './brand/brand';

/** Built pages; every other nav entry renders its "coming in phase N" placeholder. */
const PAGES: Record<string, ReactNode> = {
  '/': <Dashboard />,
  '/library': <Library />,
  '/screens': <Screens />,
  '/studio': <StudioList />,
  '/playlists': <Playlists />,
  '/schedules': <Schedules />,
  '/sensors': <Sensors />,
  '/alerts': <Alerts />,
  '/billing': <Billing />,
  '/apps': <AppStore />,
  '/integrations': <Integrations />,
  '/reports': <PlaybackReports />,
  '/analytics': <Analytics />,
  '/developers': <ApiAccess />,
  '/sync': <SyncGroups />,
  '/team': <Team />,
  '/help': <Help />,
  '/sites': <Sites />,
  '/settings': <OrgSettings />,
  '/activity': <ActivityLog />,
  '/admin': <AdminOverview />,
  '/admin/approvals': <Approvals />,
  '/admin/orgs': <Orgs />,
  '/admin/users': <PlatformUsers />,
  '/admin/audit': <AuditLogs />,
  '/admin/billing': <AdminBilling />,
  '/admin/devices': <AdminDevices />,
  '/admin/players': <AdminPlayers />,
  '/admin/settings': <AdminSettings />,
  '/admin/support': <AdminSupport />,
  '/admin/resellers': <AdminResellers />,
  '/admin/features': <AdminFeatures />,
  '/admin/integrations': <AdminApi />,
  '/partner': <PartnerCustomers />,
  '/partner/billing': <PartnerBilling />,
  '/partner/team': <PartnerTeam />,
  '/partner/branding': <PartnerBranding />,
  '/admin/white-label': <AdminWhiteLabel />,
  '/admin/costs': <AdminCosts />,
  '/admin/apps': <AdminApps />,
};

function navRoutes(nav: NavGroup[], base: string): RouteObject[] {
  return nav
    .flatMap((group) => group.items)
    .map((item) => {
      const element = PAGES[item.path] ?? <Placeholder item={item} />;
      return item.path === base ? { index: true, element } : { path: item.path, element };
    });
}

function Root() {
  return (
    <AuthProvider>
      <DomainBrandProvider>
        <Outlet />
      </DomainBrandProvider>
    </AuthProvider>
  );
}

// Guards improve UX only; Firestore rules and Cloud Functions enforce every permission.
export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/signin', element: <RedirectIfSignedIn><SignIn /></RedirectIfSignedIn> },
      { path: '/signup', element: <RedirectIfSignedIn><SignUp /></RedirectIfSignedIn> },
      { path: '/forgot-password', element: <ForgotPassword /> },
      { path: '/verify-email', element: <VerifyEmail /> },
      { path: '/player', element: <PlayerRegistration /> },
      {
        element: <RequireUser />,
        children: [
          // Reachable before two-step verification is set up, so staff can set it up here.
          { path: SECURITY_PATH, element: <AccountSecurity /> },
          {
            element: <RequireStaffSecondFactor />,
            children: [
              { path: '/onboarding', element: <Onboarding /> },
              { path: '/invite/:token', element: <AcceptInvite /> },
              {
                path: '/admin',
                element: <RequirePlatformStaff />,
                children: [
                  {
                    element: <AppShell nav={adminNav} variant="admin" />,
                    children: [
                      ...navRoutes(adminNav, '/admin'),
                      { path: '/admin/approvals/:requestId', element: <ApprovalReview /> },
                      { path: '/admin/billing/:orgId', element: <OrgBilling /> },
                    ],
                  },
                ],
              },
              {
                path: '/partner',
                element: <PartnerGate />,
                children: [{ element: <AppShell nav={partnerNav} variant="partner" />, children: navRoutes(partnerNav, '/partner') }],
              },
              {
                path: '/',
                element: <CustomerGate />,
                children: [
                  {
                    element: <AppShell nav={customerNav} variant="customer" />,
                    children: [
                      ...navRoutes(customerNav, '/'),
                      { path: '/studio/:layoutId', element: <StudioEditor /> },
                      { path: '/playlists/:playlistId', element: <PlaylistEditor /> },
                      { path: '/sensors/:sensorDeviceId', element: <SensorDetail /> },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
