/**
 * Initial platform data. Prices and limits are the proposals from the planning document
 * (Starter ₹299, Professional ₹599 per screen/month, 15% annual discount, 14-day trial) and
 * are DATA: the Super Admin edits them later without a code change.
 * `limits.screens: null` on paid plans means "number of screens purchased".
 */
import type { FeatureKey, Plan, ReleaseStatus } from '@wallx-play/shared';

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
    limits: { screens: 2, users: 3, storageGB: 2, sensorDevices: 2, retentionDays: 30, apiCallsPerDay: 0 },
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
    limits: { screens: null, users: 5, storageGB: 10, sensorDevices: 0, retentionDays: 30, apiCallsPerDay: 0 },
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
    limits: { screens: null, users: 25, storageGB: 50, sensorDevices: 50, retentionDays: 90, apiCallsPerDay: 0 },
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
    limits: { screens: null, users: null, storageGB: null, sensorDevices: null, retentionDays: 365, apiCallsPerDay: null },
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
