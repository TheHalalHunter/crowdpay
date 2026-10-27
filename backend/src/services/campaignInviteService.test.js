const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const path = require('node:path');

const MODULE_PATH = './campaignInviteService';

function buildService({ queryImpl, sendEmailImpl = async () => {} } = {}) {
  const queryMatches = queryImpl || (async () => ({ rows: [] }));
  return proxyquire(MODULE_PATH, {
    '../config/database': { query: queryMatches },
    '../config/logger': { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    './emailService': { sendEmail: sendEmailImpl },
    '../lib/campaignPermissions': {
      isValidRole: role => ['owner', 'manager', 'editor', 'viewer'].includes(role),
    },
  });
}

const TMP_FRONTEND_URL = 'http://campaign.test';

test.describe('campaignInviteService', () => {
  test('createCampaignInvite rejects an invalid role with 422', async () => {
    const svc = buildService();
    await assert.rejects(
      svc.createCampaignInvite({
        campaignId: 'c-1',
        email: 'a@b.com',
        role: 'god',
        invitedByUserId: 'u-1',
      }),
      err => err.statusCode === 422
    );
  });

  test('createCampaignInvite rejects a missing email with 422', async () => {
    const svc = buildService();
    await assert.rejects(
      svc.createCampaignInvite({
        campaignId: 'c-1',
        email: '  ',
        role: 'owner',
        invitedByUserId: 'u-1',
      }),
      err => err.statusCode === 422
    );
  });

  test('createCampaignInvite short-circuits when the user already accepted', async () => {
    const svc = buildService({
      queryImpl: async () => ({ rows: [{ id: 'm-1', accepted_at: new Date().toISOString() }] }),
    });
    await assert.rejects(
      svc.createCampaignInvite({
        campaignId: 'c-1',
        email: 'a@b.com',
        role: 'viewer',
        invitedByUserId: 'u-1',
      }),
      err => err.statusCode === 409 && /already a member/i.test(err.message)
    );
  });

  test('createCampaignInvite short-circuits when an invite is already pending', async () => {
    const svc = buildService({
      queryImpl: async () => ({ rows: [{ id: 'm-1', accepted_at: null }] }),
    });
    await assert.rejects(
      svc.createCampaignInvite({
        campaignId: 'c-1',
        email: 'a@b.com',
        role: 'viewer',
        invitedByUserId: 'u-1',
      }),
      err => err.statusCode === 409 && /already sent/i.test(err.message)
    );
  });

  test('createCampaignInvite creates the member, sends email and returns inviteUrl', async () => {
    const original = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = TMP_FRONTEND_URL;
    test.after(() => {
      if (original === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = original;
    });

    const dbCalls = [];
    let sentEmail = null;
    const svc = buildService({
      queryImpl: async (text, params) => {
        dbCalls.push(text);
        if (text.includes('SELECT id FROM users WHERE')) return { rows: [{ id: 'invitee-1' }] };
        if (text.includes('FROM campaign_members')) return { rows: [] };
        return {
          rows: [
            {
              id: 'm-1',
              campaign_id: 'c-1',
              user_id: 'invitee-1',
              email: 'friend@example.com',
              role: 'manager',
              accepted_at: null,
              invite_expires_at: new Date(Date.now() + 86400000).toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        };
      },
      sendEmailImpl: async email => {
        sentEmail = email;
      },
    });

    const result = await svc.createCampaignInvite({
      campaignId: 'c-1',
      email: ' Friend@Example.com ',
      role: 'manager',
      invitedByUserId: 'u-1',
      campaignTitle: 'Fund the thing',
    });

    assert.equal(result.member.id, 'm-1');
    assert.match(
      result.inviteUrl,
      new RegExp(`^${TMP_FRONTEND_URL}/campaigns/c-1/invite/[0-9a-f]{64}$`)
    );
    assert.equal(sentEmail.to, 'friend@example.com');
    assert.match(sentEmail.text, /as manager/);
    assert.match(sentEmail.text, /expires in 7 days/);
    assert.ok(dbCalls.some(t => /INSERT INTO campaign_members/.test(t)));
  });

  test('createCampaignInvite still succeeds when email delivery fails', async () => {
    const svc = buildService({
      queryImpl: async text => {
        if (text.includes('FROM campaign_members')) return { rows: [] };
        if (text.includes('SELECT id FROM users')) return { rows: [] };
        return {
          rows: [
            {
              id: 'm-2',
              campaign_id: 'c-1',
              user_id: 'invitee-1',
              email: 'x@y.com',
              role: 'editor',
              accepted_at: null,
            },
          ],
        };
      },
      sendEmailImpl: async () => {
        throw new Error('SMTP down');
      },
    });

    const result = await svc.createCampaignInvite({
      campaignId: 'c-1',
      email: 'x@y.com',
      role: 'editor',
      invitedByUserId: 'u-1',
    });
    assert.equal(result.member.id, 'm-2');
  });

  test('resendCampaignInvite regenerates the token and resends', async () => {
    process.env.FRONTEND_URL = TMP_FRONTEND_URL;
    test.after(() => delete process.env.FRONTEND_URL);

    let sentEmail = null;
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            email: 'a@b.com',
            role: 'owner',
            accepted_at: null,
            invite_expires_at: new Date(Date.now() + 86400000).toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      }),
      sendEmailImpl: async email => {
        sentEmail = email;
      },
    });

    const result = await svc.resendCampaignInvite({
      memberId: 'm-1',
      campaignId: 'c-1',
      campaignTitle: 'T',
    });
    assert.equal(result.member.id, 'm-1');
    assert.match(result.inviteUrl, /\/campaigns\/c-1\/invite\/[0-9a-f]{64}$/);
    assert.equal(sentEmail.to, 'a@b.com');
  });

  test('resendCampaignInvite throws 404 when no pending row found', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    await assert.rejects(
      svc.resendCampaignInvite({ memberId: 'm-x', campaignId: 'c-1' }),
      err => err.statusCode === 404
    );
  });

  test('cancelCampaignInvite deletes the pending member', async () => {
    let deleted = false;
    const svc = buildService({
      queryImpl: async text => {
        if (text.includes('DELETE FROM campaign_members')) {
          deleted = true;
          return { rows: [{ id: 'm-1' }] };
        }
        return { rows: [] };
      },
    });
    const result = await svc.cancelCampaignInvite({ memberId: 'm-1', campaignId: 'c-1' });
    assert.equal(result.id, 'm-1');
    assert.ok(deleted);
  });

  test('cancelCampaignInvite throws 404 when nothing matched', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    await assert.rejects(
      svc.cancelCampaignInvite({ memberId: 'm-x', campaignId: 'c-1' }),
      err => err.statusCode === 404
    );
  });

  test('getInvitePreview returns null when the token is unknown', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    assert.equal(await svc.getInvitePreview('nope'), null);
  });

  test('getInvitePreview surfaces an unexpired invite', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            email: 'a@b.com',
            role: 'viewer',
            accepted_at: null,
            invite_expires_at: future,
            campaign_title: 'Great campaign',
          },
        ],
      }),
    });
    const preview = await svc.getInvitePreview('token');
    assert.equal(preview.campaign_title, 'Great campaign');
    assert.equal(preview.expired, false);
  });

  test('getInvitePreview flags an expired invite', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            email: 'a@b.com',
            role: 'viewer',
            accepted_at: null,
            invite_expires_at: past,
            campaign_title: 'Old campaign',
          },
        ],
      }),
    });
    const preview = await svc.getInvitePreview('token');
    assert.equal(preview.expired, true);
  });

  test('acceptCampaignInvite rejects an unknown token with 404', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    await assert.rejects(
      svc.acceptCampaignInvite({ inviteToken: 'bad', userId: 'u-1', userEmail: 'a@b.com' }),
      err => err.statusCode === 404
    );
  });

  test('acceptCampaignInvite rejects an already accepted invite with 409', async () => {
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            accepted_at: new Date().toISOString(),
            invite_expires_at: null,
            email: 'a@b.com',
            role: 'viewer',
          },
        ],
      }),
    });
    await assert.rejects(
      svc.acceptCampaignInvite({ inviteToken: 'tok', userId: 'u-1', userEmail: 'a@b.com' }),
      err => err.statusCode === 409
    );
  });

  test('acceptCampaignInvite rejects an expired invite with 410', async () => {
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            accepted_at: null,
            invite_expires_at: new Date(Date.now() - 1000).toISOString(),
            email: 'a@b.com',
            role: 'viewer',
          },
        ],
      }),
    });
    await assert.rejects(
      svc.acceptCampaignInvite({ inviteToken: 'tok', userId: 'u-1', userEmail: 'a@b.com' }),
      err => err.statusCode === 410
    );
  });

  test('acceptCampaignInvite rejects an email mismatch with 403', async () => {
    const svc = buildService({
      queryImpl: async () => ({
        rows: [
          {
            id: 'm-1',
            campaign_id: 'c-1',
            accepted_at: null,
            invite_expires_at: null,
            email: 'friend@example.com',
            role: 'viewer',
          },
        ],
      }),
    });
    await assert.rejects(
      svc.acceptCampaignInvite({
        inviteToken: 'tok',
        userId: 'u-1',
        userEmail: 'other@example.com',
      }),
      err => err.statusCode === 403
    );
  });

  test('acceptCampaignInvite accepts when the emails match and clears the token', async () => {
    let updateRan = false;
    const svc = buildService({
      queryImpl: async (text, params) => {
        if (text.includes('SELECT id, campaign_id, accepted_at')) {
          return {
            rows: [
              {
                id: 'm-1',
                campaign_id: 'c-1',
                accepted_at: null,
                invite_expires_at: null,
                email: 'friend@example.com',
                role: 'owner',
              },
            ],
          };
        }
        if (text.includes('UPDATE campaign_members')) {
          updateRan = true;
          assert.deepEqual(params, ['u-1', 'm-1']);
          return {
            rows: [
              {
                id: 'm-1',
                campaign_id: 'c-1',
                user_id: 'u-1',
                email: 'friend@example.com',
                role: 'owner',
                accepted_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      },
    });

    const member = await svc.acceptCampaignInvite({
      inviteToken: 'tok',
      userId: 'u-1',
      userEmail: ' FRIEND@example.com ',
    });
    assert.equal(member.user_id, 'u-1');
    assert.ok(updateRan);
  });

  test('countAcceptedOwners returns 0 when the campaign is unknown', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    assert.equal(await svc.countAcceptedOwners('missing-campaign'), 0);
  });

  test('countAcceptedOwners returns at least 1 for the implicit creator owner', async () => {
    const calls = [];
    const svc = buildService({
      queryImpl: async text => {
        calls.push(text);
        if (text.includes('SELECT creator_id FROM campaigns'))
          return { rows: [{ creator_id: 'u-1' }] };
        if (text.includes('COUNT(*)::int AS count')) return { rows: [{ count: 0 }] };
        return { rows: [] };
      },
    });
    assert.equal(await svc.countAcceptedOwners('c-1'), 1);
    assert.equal(calls.length, 2);
  });

  test('resolveUserCampaignRole treats admins as owners', async () => {
    const svc = buildService();
    assert.equal(await svc.resolveUserCampaignRole('c-1', 'u-9', true), 'owner');
  });

  test('resolveUserCampaignRole returns null when the campaign does not exist', async () => {
    const svc = buildService({ queryImpl: async () => ({ rows: [] }) });
    assert.equal(await svc.resolveUserCampaignRole('missing', 'u-1'), null);
  });

  test('resolveUserCampaignRole returns owner for the campaign creator', async () => {
    const svc = buildService({
      queryImpl: async text => {
        if (text.includes('SELECT creator_id')) return { rows: [{ creator_id: 'u-1' }] };
        return { rows: [] };
      },
    });
    assert.equal(await svc.resolveUserCampaignRole('c-1', 'u-1'), 'owner');
  });

  test('resolveUserCampaignRole returns the member role once accepted', async () => {
    const svc = buildService({
      queryImpl: async text => {
        if (text.includes('SELECT creator_id')) return { rows: [{ creator_id: 'u-2' }] };
        if (text.includes('FROM campaign_members')) {
          return { rows: [{ role: 'editor', accepted_at: new Date().toISOString() }] };
        }
        return { rows: [] };
      },
    });
    assert.equal(await svc.resolveUserCampaignRole('c-1', 'u-3'), 'editor');
  });

  test('resolveUserCampaignRole returns null for a pending (unaccepted) member', async () => {
    const svc = buildService({
      queryImpl: async text => {
        if (text.includes('SELECT creator_id')) return { rows: [{ creator_id: 'u-2' }] };
        if (text.includes('FROM campaign_members'))
          return { rows: [{ role: 'viewer', accepted_at: null }] };
        return { rows: [] };
      },
    });
    assert.equal(await svc.resolveUserCampaignRole('c-1', 'u-3'), null);
  });

  test('buildInviteUrl defaults to localhost when FRONTEND_URL is unset', () => {
    const svc = buildService();
    assert.equal(
      svc.buildInviteUrl('c-1', 'tok'),
      'http://localhost:5173/campaigns/c-1/invite/tok'
    );
  });

  test('buildInviteUrl preserves a frontend path without duplicate slashes', () => {
    const original = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://crowdpay.test/app/';
    try {
      const svc = buildService();
      assert.equal(
        svc.buildInviteUrl('c-1', 'tok'),
        'https://crowdpay.test/app/campaigns/c-1/invite/tok'
      );
    } finally {
      if (original === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = original;
    }
  });
});
