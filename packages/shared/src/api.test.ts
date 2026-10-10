import { describe, expect, it } from 'vitest';
import { InviteMemberInput, OrgSignupDetails, ReviewOrgSignupInput, UpsertSiteInput } from './api';
import { PairingCode } from './devices';

const signup = {
  orgName: 'Acme',
  contactName: 'Asha',
  phone: '+91 98200 12345',
  city: 'Pune',
  stateCode: '27',
  expectedScreens: '5',
  timezone: 'Asia/Kolkata',
};

describe('api schemas', () => {
  it('reject and request_info need a reason; approve does not', () => {
    expect(ReviewOrgSignupInput.safeParse({ requestId: 'r1', decision: 'approve' }).success).toBe(true);
    expect(ReviewOrgSignupInput.safeParse({ requestId: 'r1', decision: 'reject' }).success).toBe(false);
    expect(
      ReviewOrgSignupInput.safeParse({ requestId: 'r1', decision: 'request_info', message: 'Need GSTIN' }).success,
    ).toBe(true);
  });

  it('coerces expected screens and treats empty GSTIN as absent', () => {
    const parsed = OrgSignupDetails.parse({ ...signup, gstin: '' });
    expect(parsed.expectedScreens).toBe(5);
    expect(parsed.gstin).toBeUndefined();
  });

  it('rejects invalid GSTIN, state code and time zone', () => {
    expect(OrgSignupDetails.safeParse({ ...signup, gstin: 'ABC' }).success).toBe(false);
    expect(OrgSignupDetails.safeParse({ ...signup, stateCode: '99' }).success).toBe(false);
    expect(UpsertSiteInput.safeParse({ orgId: 'o', name: 'HQ', timezone: 'Mars/Base' }).success).toBe(false);
  });

  it('normalizes invite emails', () => {
    expect(InviteMemberInput.parse({ orgId: 'o', email: ' Bob@Example.COM ', role: 'viewer' }).email).toBe(
      'bob@example.com',
    );
  });

  it('normalizes pairing codes typed with spaces, dashes or lowercase', () => {
    expect(PairingCode.parse(' k7p-2qx ')).toBe('K7P2QX');
    expect(PairingCode.safeParse('K7P2Q0').success).toBe(false); // 0 is not in the alphabet
    expect(PairingCode.safeParse('K7P2Q').success).toBe(false);
  });

  it('rejects ids with path characters', () => {
    expect(UpsertSiteInput.safeParse({ orgId: 'a/b', name: 'HQ', timezone: 'Asia/Kolkata' }).success).toBe(false);
  });
});
