/**
 * Feature entitlements. Two separate ideas:
 *  - releaseStatus: has WallX built it? (platform/featureCatalog)
 *  - plan featureKeys + org overrides: may this org use it?
 * A feature is usable only when it is GA (or beta and explicitly granted) AND entitled.
 */

export const FEATURE_KEYS = [
  'media.basic',
  'layout.multiZone',
  'layout.templates',
  'widget.core', // text, clock, QR, table, web
  'widget.weather',
  'widget.rss',
  'content.approvals',
  'sensor.esp32',
  'emergency.override',
  'screen.monitoring',
  'screen.remoteCommands',
  'report.proofOfPlay',
  'screen.diagnostics',
  'api.keys',
  'api.webhooks',
  'screen.multiSync',
  'interactive.touch',
  'sensor.mqtt',
  'branding.whiteLabel',
  'reseller.portal',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const RELEASE_STATUSES = ['planned', 'beta', 'ga'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const LIMIT_KEYS = [
  'screens',
  'users',
  'storageGB',
  'sensorDevices',
  'retentionDays',
  'apiCallsPerDay',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** null = unlimited */
export type Limits = Record<LimitKey, number | null>;

export interface FeatureOverrides {
  grant?: FeatureKey[];
  revoke?: FeatureKey[];
  limits?: Partial<Limits>;
}

export interface Entitlements {
  features: FeatureKey[];
  limits: Limits;
}

export function resolveEntitlements(input: {
  planFeatures: readonly FeatureKey[];
  planLimits: Limits;
  catalog: Partial<Record<FeatureKey, ReleaseStatus>>;
  overrides?: FeatureOverrides;
}): Entitlements {
  const { planFeatures, planLimits, catalog, overrides } = input;
  const granted = new Set<FeatureKey>(planFeatures);
  for (const key of overrides?.grant ?? []) granted.add(key);
  for (const key of overrides?.revoke ?? []) granted.delete(key);

  const isReleased = (key: FeatureKey) => {
    const status = catalog[key] ?? 'planned';
    // Beta features are usable only when explicitly granted by an admin override.
    return status === 'ga' || (status === 'beta' && (overrides?.grant ?? []).includes(key));
  };

  return {
    features: [...granted].filter(isReleased).sort(),
    limits: { ...planLimits, ...overrides?.limits },
  };
}

export function withinLimit(limits: Limits, key: LimitKey, nextValue: number): boolean {
  const max = limits[key];
  return max === null || nextValue <= max;
}
