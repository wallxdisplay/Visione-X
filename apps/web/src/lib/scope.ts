import { where, type QueryConstraint } from 'firebase/firestore';

/**
 * Query constraints for collections limited by site scope (screens, sensor devices, alerts).
 * Firestore rules only allow a scoped member's list when it is filtered to their sites, so
 * scoped queries add `siteId in scope` and drop server-side ordering (sort in the browser) to
 * avoid a composite index per combination. Unscoped members get the ordered query unchanged.
 */
export function bySite(scope: readonly string[], ...ordered: QueryConstraint[]): QueryConstraint[] {
  return scope.length ? [where('siteId', 'in', [...scope])] : ordered;
}

/** Cache key part so a scope change rebuilds live queries. */
export const scopeKey = (scope: readonly string[]) => (scope.length ? `:${[...scope].sort().join(',')}` : '');
