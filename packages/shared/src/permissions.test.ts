import { describe, expect, it } from 'vitest';
import { hasOrgPermission, hasPlatformPermission } from './permissions';

describe('org permissions', () => {
  it('owner can manage billing, admin cannot', () => {
    expect(hasOrgPermission({ role: 'owner', status: 'active' }, 'billing.manage')).toBe(true);
    expect(hasOrgPermission({ role: 'admin', status: 'active' }, 'billing.manage')).toBe(false);
  });

  it('viewer cannot publish', () => {
    expect(hasOrgPermission({ role: 'viewer', status: 'active' }, 'content.publish')).toBe(false);
  });

  it('inactive members have no permissions', () => {
    expect(hasOrgPermission({ role: 'owner', status: 'disabled' }, 'screen.view')).toBe(false);
  });

  it('custom roles use only their listed permissions', () => {
    const member = { role: 'custom' as const, status: 'active' as const, customPermissions: ['screen.view' as const] };
    expect(hasOrgPermission(member, 'screen.view')).toBe(true);
    expect(hasOrgPermission(member, 'screen.manage')).toBe(false);
  });
});

describe('platform permissions', () => {
  it('support cannot override billing or grant support access', () => {
    expect(hasPlatformPermission('support', 'billing.override')).toBe(false);
    expect(hasPlatformPermission('support', 'support.access.grant')).toBe(false);
  });

  it('no role means no permission', () => {
    expect(hasPlatformPermission(null, 'org.view')).toBe(false);
  });
});
