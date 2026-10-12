import type { ReactNode } from 'react';
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router';
import { AuthProvider } from './auth/AuthProvider';
import { CustomerGate, RedirectIfSignedIn, RequirePlatformStaff, RequireUser } from './auth/guards';
import { AcceptInvite } from './pages/AcceptInvite';
import { AdminOverview } from './pages/admin/AdminOverview';
import { ApprovalReview } from './pages/admin/ApprovalReview';
import { Approvals } from './pages/admin/Approvals';
import { AuditLogs } from './pages/admin/AuditLogs';
import { Orgs } from './pages/admin/Orgs';
import { PlatformUsers } from './pages/admin/PlatformUsers';
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
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/onboarding/Onboarding';
import { Placeholder } from './pages/Placeholder';
import { PlayerRegistration } from './pages/PlayerRegistration';
import { AppShell } from './shell/AppShell';
import { adminNav, customerNav, type NavGroup } from './shell/nav';

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
  '/team': <Team />,
  '/sites': <Sites />,
  '/settings': <OrgSettings />,
  '/admin': <AdminOverview />,
  '/admin/approvals': <Approvals />,
  '/admin/orgs': <Orgs />,
  '/admin/users': <PlatformUsers />,
  '/admin/audit': <AuditLogs />,
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
      <Outlet />
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
                ],
              },
            ],
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
      { path: '*', element: <NotFound /> },
    ],
  },
]);
