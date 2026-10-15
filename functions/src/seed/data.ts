/**
 * Initial platform data. Prices and limits are the proposals from the planning document
 * (Starter ₹299, Professional ₹599 per screen/month, 15% annual discount, 14-day trial) and
 * are DATA: the Super Admin edits them later without a code change.
 * `limits.screens: null` on paid plans means "number of screens purchased".
 */
import type { AppDoc, FeatureKey, Plan, ReleaseStatus } from '@wallx-play/shared';

const CORE: FeatureKey[] = [
  'media.basic',
  'layout.multiZone',
  'layout.templates',
  'widget.core',
  'emergency.override',
  'screen.monitoring',
  'screen.remoteCommands',
];

export const SEED_PLANS: Plan[] = [
  {
    id: 'trial',
    name: 'Free Trial',
    tier: 'trial',
    currency: 'INR',
    pricePerScreenMonthlyMinor: 0,
    annualDiscountBps: 0,
    trialDays: 14,
    limits: { screens: 2, users: 3, storageGB: 2, sensorDevices: 2, retentionDays: 30, apiCallsPerDay: 0, liveRefreshSec: 15 },
    featureKeys: [...CORE, 'widget.weather', 'widget.rss', 'sensor.esp32'],
    active: true,
    version: 1,
  },
  {
    id: 'starter',
    name: 'Starter',
    tier: 'starter',
    currency: 'INR',
    pricePerScreenMonthlyMinor: 29_900,
    annualDiscountBps: 1500,
    trialDays: 0,
    limits: { screens: null, users: 5, storageGB: 10, sensorDevices: 0, retentionDays: 30, apiCallsPerDay: 0, liveRefreshSec: 15 },
    featureKeys: CORE,
    active: true,
    version: 1,
  },
  {
    id: 'professional',
    name: 'Professional',
    tier: 'professional',
    currency: 'INR',
    pricePerScreenMonthlyMinor: 59_900,
    annualDiscountBps: 1500,
    trialDays: 0,
    limits: { screens: null, users: 25, storageGB: 50, sensorDevices: 50, retentionDays: 90, apiCallsPerDay: 0, liveRefreshSec: 15 },
    featureKeys: [
      ...CORE,
      'widget.weather',
      'widget.rss',
      'content.approvals',
      'sensor.esp32',
      'report.proofOfPlay',
      'screen.diagnostics',
    ],
    active: true,
    version: 1,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tier: 'enterprise',
    currency: 'INR',
    pricePerScreenMonthlyMinor: null, // custom agreement
    annualDiscountBps: 0,
    trialDays: 0,
    limits: { screens: null, users: null, storageGB: null, sensorDevices: null, retentionDays: 365, apiCallsPerDay: null, liveRefreshSec: null },
    featureKeys: [
      ...CORE,
      'widget.weather',
      'widget.rss',
      'content.approvals',
      'sensor.esp32',
      'report.proofOfPlay',
      'screen.diagnostics',
      'api.keys',
      'api.webhooks',
      'screen.multiSync',
      'interactive.touch',
      'sensor.mqtt',
      'branding.whiteLabel',
      'reseller.portal',
    ],
    active: true,
    version: 1,
  },
];

/**
 * Release status per feature. v1 features are marked `ga` so development and testing can use
 * them; in production the Super Admin sets the real status as each module ships.
 */
export const SEED_FEATURE_CATALOG: Record<FeatureKey, ReleaseStatus> = {
  'media.basic': 'ga',
  'layout.multiZone': 'ga',
  'layout.templates': 'ga',
  'widget.core': 'ga',
  'widget.weather': 'ga',
  'widget.rss': 'ga',
  'content.approvals': 'ga',
  'sensor.esp32': 'ga',
  'emergency.override': 'ga',
  'screen.monitoring': 'ga',
  'screen.remoteCommands': 'ga',
  'report.proofOfPlay': 'planned',
  'screen.diagnostics': 'planned',
  'api.keys': 'planned',
  'api.webhooks': 'planned',
  'screen.multiSync': 'planned',
  'interactive.touch': 'planned',
  'sensor.mqtt': 'planned',
  'branding.whiteLabel': 'planned',
  'reseller.portal': 'planned',
};

const rupees = (r: number) => Math.round(r * 100);

/**
 * Starting app catalog (App store). Prices and costs come from the Phase 0 price sheet
 * (docs/planning/app-pricing.xlsx); the Super Admin edits them on Admin → App catalog.
 */
export const SEED_APPS: Array<Omit<AppDoc, 'updatedAt' | 'updatedBy'> & { costMinor: number }> = [
  { id: 'screen', name: 'Screen', description: 'Media, layouts and templates, text/clock/QR/table/web widgets, emergency messages, monitoring and remote restart.', unit: 'screen', featureKeys: [...CORE], requires: [], base: true, limitBoosts: {}, priceMinor: rupees(299), dealerPriceMinor: null, active: true, sortOrder: 0, costMinor: rupees(37.62) },
  { id: 'weather', name: 'Weather & air quality', description: 'Live weather, forecast and air quality (AQI) widgets.', unit: 'screen', featureKeys: ['widget.weather'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(49), dealerPriceMinor: null, active: true, sortOrder: 10, costMinor: rupees(27.84) },
  { id: 'news', name: 'News (RSS)', description: 'Headlines from any RSS feed.', unit: 'screen', featureKeys: ['widget.rss'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(29), dealerPriceMinor: null, active: true, sortOrder: 20, costMinor: rupees(1.65) },
  { id: 'touch', name: 'Touch kiosk', description: 'Tappable pages and buttons for touch screens.', unit: 'screen', featureKeys: ['interactive.touch'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(199), dealerPriceMinor: null, active: true, sortOrder: 30, costMinor: 0 },
  { id: 'sync', name: 'Sync & video wall', description: 'Play in step across screens: mirror groups and video walls.', unit: 'screen', featureKeys: ['screen.multiSync'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(99), dealerPriceMinor: null, active: true, sortOrder: 40, costMinor: rupees(2.08) },
  { id: 'proof-of-play', name: 'Proof-of-play', description: 'Playback reports per screen and content, with CSV export.', unit: 'screen', featureKeys: ['report.proofOfPlay'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(49), dealerPriceMinor: null, active: true, sortOrder: 50, costMinor: rupees(0.25) },
  { id: 'diagnostics', name: 'Analytics & diagnostics', description: 'Uptime, device health and event history.', unit: 'screen', featureKeys: ['screen.diagnostics'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(49), dealerPriceMinor: null, active: true, sortOrder: 60, costMinor: rupees(0.03) },
  { id: 'sensors', name: 'Sensors', description: 'ESP32 or MQTT sensor devices: live values on screens, history and alerts.', unit: 'sensor_device', featureKeys: ['sensor.esp32'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(149), dealerPriceMinor: null, active: true, sortOrder: 70, costMinor: rupees(81.08) },
  { id: 'mqtt', name: 'MQTT bridge', description: 'Read sensors from your own MQTT broker through one of your screens.', unit: 'organization', featureKeys: ['sensor.mqtt'], requires: ['sensors'], base: false, limitBoosts: {}, priceMinor: rupees(499), dealerPriceMinor: null, active: true, sortOrder: 80, costMinor: rupees(0.73) },
  { id: 'approvals', name: 'Content approvals', description: 'Require approval before content is published.', unit: 'organization', featureKeys: ['content.approvals'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(499), dealerPriceMinor: null, active: true, sortOrder: 90, costMinor: rupees(0.04) },
  { id: 'api', name: 'API & webhooks', description: 'API keys for your systems and signed webhooks.', unit: 'organization', featureKeys: ['api.keys', 'api.webhooks'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(1999), dealerPriceMinor: null, active: true, sortOrder: 100, costMinor: rupees(8.59) },
  { id: 'white-label', name: 'White label', description: 'Your own brand on the app, screens and emails, with your own web address.', unit: 'organization', featureKeys: ['branding.whiteLabel'], requires: [], base: false, limitBoosts: {}, priceMinor: rupees(4999), dealerPriceMinor: null, active: true, sortOrder: 110, costMinor: rupees(250) },
  { id: 'storage', name: 'Extra storage', description: '10 GB more space for your media library.', unit: 'storage_10gb', featureKeys: [], requires: [], base: false, limitBoosts: { storageGB: 10 }, priceMinor: rupees(99), dealerPriceMinor: null, active: true, sortOrder: 120, costMinor: rupees(20.24) },
];
