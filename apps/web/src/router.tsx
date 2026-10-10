import { createBrowserRouter, type RouteObject } from 'react-router';
import { NotFound } from './pages/NotFound';
import { Placeholder } from './pages/Placeholder';
import { PlayerRegistration } from './pages/PlayerRegistration';
import { AppShell } from './shell/AppShell';
import { adminNav, customerNav, type NavGroup } from './shell/nav';

function placeholderRoutes(nav: NavGroup[], base: string): RouteObject[] {
  return nav
    .flatMap((group) => group.items)
    .map((item) =>
      item.path === base
        ? { index: true, element: <Placeholder item={item} /> }
        : { path: item.path, element: <Placeholder item={item} /> },
    );
}

// Route guards (auth, org membership, platform role) arrive in phase 1. They improve UX only;
// every permission is enforced again by Security Rules and Cloud Functions.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell nav={customerNav} variant="customer" />,
    children: placeholderRoutes(customerNav, '/'),
  },
  {
    path: '/admin',
    element: <AppShell nav={adminNav} variant="admin" />,
    children: placeholderRoutes(adminNav, '/admin'),
  },
  { path: '/player', element: <PlayerRegistration /> },
  { path: '*', element: <NotFound /> },
]);
