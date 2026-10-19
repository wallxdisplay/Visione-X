import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  CalendarClock,
  ClipboardCheck,
  CreditCard,
  FileClock,
  Gauge,
  Handshake,
  Briefcase,
  Palette,
  Store,
  HelpCircle,
  Images,
  KeyRound,
  Grid2x2,
  LayoutDashboard,
  LayoutTemplate,
  ListVideo,
  MapPin,
  Monitor,
  PackageOpen,
  Plug,
  Radio,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  /** i18n key under nav.* */
  labelKey: string;
  path: string;
  icon: LucideIcon;
  /**
   * When it ships, for placeholder pages: a delivery phase (docs/ARCHITECTURE.md §17) or a later
   * release from the feature table (§16).
   */
  phase: number | 'v1.1';
}

export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

export const customerNav: NavGroup[] = [
  {
    labelKey: 'nav.groups.overview',
    items: [{ labelKey: 'nav.dashboard', path: '/', icon: LayoutDashboard, phase: 1 }],
  },
  {
    labelKey: 'nav.groups.manage',
    items: [
      { labelKey: 'nav.screens', path: '/screens', icon: Monitor, phase: 3 },
      { labelKey: 'nav.sites', path: '/sites', icon: MapPin, phase: 1 },
      { labelKey: 'nav.library', path: '/library', icon: Images, phase: 2 },
      { labelKey: 'nav.studio', path: '/studio', icon: LayoutTemplate, phase: 2 },
      { labelKey: 'nav.playlists', path: '/playlists', icon: ListVideo, phase: 2 },
      { labelKey: 'nav.schedules', path: '/schedules', icon: CalendarClock, phase: 2 },
      { labelKey: 'nav.sync', path: '/sync', icon: Grid2x2, phase: 'v1.1' },
    ],
  },
  {
    labelKey: 'nav.groups.connect',
    items: [
      { labelKey: 'nav.sensors', path: '/sensors', icon: Radio, phase: 5 },
      { labelKey: 'nav.integrations', path: '/integrations', icon: Plug, phase: 6 },
      { labelKey: 'nav.alerts', path: '/alerts', icon: Bell, phase: 5 },
    ],
  },
  {
    labelKey: 'nav.groups.insights',
    items: [
      { labelKey: 'nav.reports', path: '/reports', icon: FileClock, phase: 'v1.1' },
      { labelKey: 'nav.analytics', path: '/analytics', icon: BarChart3, phase: 'v1.1' },
    ],
  },
  {
    labelKey: 'nav.groups.account',
    items: [
      { labelKey: 'nav.team', path: '/team', icon: Users, phase: 1 },
      { labelKey: 'nav.billing', path: '/billing', icon: CreditCard, phase: 6 },
      { labelKey: 'nav.appStore', path: '/apps', icon: Store, phase: 'v1.1' },
      { labelKey: 'nav.settings', path: '/settings', icon: Settings, phase: 1 },
      { labelKey: 'nav.api', path: '/developers', icon: KeyRound, phase: 'v1.1' },
      { labelKey: 'nav.help', path: '/help', icon: HelpCircle, phase: 6 },
    ],
  },
];

/** Partner portal (reseller staff). */
export const partnerNav: NavGroup[] = [
  {
    labelKey: 'nav.groups.partner',
    items: [
      { labelKey: 'nav.partner.customers', path: '/partner', icon: Briefcase, phase: 'v1.1' },
      { labelKey: 'nav.partner.billing', path: '/partner/billing', icon: CreditCard, phase: 'v1.1' },
      { labelKey: 'nav.partner.team', path: '/partner/team', icon: Users, phase: 'v1.1' },
      { labelKey: 'nav.partner.branding', path: '/partner/branding', icon: Palette, phase: 'v1.1' },
    ],
  },
];

export const adminNav: NavGroup[] = [
  {
    labelKey: 'nav.groups.platform',
    items: [{ labelKey: 'nav.admin.overview', path: '/admin', icon: Gauge, phase: 1 }],
  },
  {
    labelKey: 'nav.groups.customers',
    items: [
      { labelKey: 'nav.admin.approvals', path: '/admin/approvals', icon: ClipboardCheck, phase: 1 },
      { labelKey: 'nav.admin.orgs', path: '/admin/orgs', icon: Building2, phase: 1 },
      { labelKey: 'nav.admin.resellers', path: '/admin/resellers', icon: Handshake, phase: 6 },
      { labelKey: 'nav.admin.whiteLabel', path: '/admin/white-label', icon: Palette, phase: 'v1.1' },
      { labelKey: 'nav.admin.users', path: '/admin/users', icon: Users, phase: 1 },
    ],
  },
  {
    labelKey: 'nav.groups.operations',
    items: [
      { labelKey: 'nav.admin.devices', path: '/admin/devices', icon: Activity, phase: 4 },
      { labelKey: 'nav.admin.players', path: '/admin/players', icon: PackageOpen, phase: 4 },
      { labelKey: 'nav.admin.features', path: '/admin/features', icon: SlidersHorizontal, phase: 6 },
      { labelKey: 'nav.admin.apps', path: '/admin/apps', icon: Store, phase: 'v1.1' },
      { labelKey: 'nav.admin.billing', path: '/admin/billing', icon: CreditCard, phase: 6 },
      { labelKey: 'nav.admin.integrations', path: '/admin/integrations', icon: KeyRound, phase: 'v1.1' },
    ],
  },
  {
    labelKey: 'nav.groups.governance',
    items: [
      { labelKey: 'nav.admin.support', path: '/admin/support', icon: ShieldCheck, phase: 6 },
      { labelKey: 'nav.admin.audit', path: '/admin/audit', icon: FileClock, phase: 1 },
      { labelKey: 'nav.admin.settings', path: '/admin/settings', icon: Settings, phase: 6 },
    ],
  },
];
