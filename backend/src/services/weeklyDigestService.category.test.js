process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

// Recipient who never contributed but follows a category must still receive a
// digest containing the new campaign in that category.
test('category followers without contributions receive new-campaign digests', async () => {
  const sent = [];
  const { sendWeeklyContributorDigests } = proxyquire('./weeklyDigestService', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('FROM users u') && text.includes('category_follows')) {
          return {
            rows: [
              {
                id: 'user-cat',
                email: 'follower@example.com',
                name: 'Follower',
                window_start: '2026-09-23T18:00:00.000Z',
              },
            ],
          };
        }
        if (
          text.includes('FROM contributions ctr') &&
          text.includes('campaign_update_unsubscribes')
        ) {
          return { rows: [] };
        }
        if (text.includes('FROM category_follows WHERE user_id')) {
          assert.deepEqual(params, ['user-cat']);
          return { rows: [{ category: 'arts' }] };
        }
        if (text.includes('FROM campaigns c') && text.includes('c.category = ANY')) {
          assert.deepEqual(params[0], ['arts']);
          return {
            rows: [
              {
                id: 'camp-new',
                title: 'Street Mural',
                status: 'active',
                deadline: '2026-12-01T00:00:00.000Z',
                target_amount: '1000',
                raised_amount: '10',
                asset_type: 'USDC',
                category: 'arts',
                created_at: '2026-09-25T12:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM campaign_updates')) return { rows: [] };
        if (text.includes('FROM milestones')) return { rows: [] };
        if (text.includes('FROM campaign_status_events')) return { rows: [] };
        if (text.includes('INSERT INTO email_digest_deliveries')) return { rows: [{ id: 'digest-1' }] };
        throw new Error(`Unexpected query: ${text.slice(0, 120)}`);
      },
    },
    '../config/logger': { info: () => {} },
    './categoryFollowService': {
      listNewCampaignsInCategories: async (categories, windowStart, windowEnd) => {
        assert.deepEqual(categories, ['arts']);
        assert.ok(windowStart instanceof Date);
        assert.ok(windowEnd instanceof Date);
        return [
          {
            id: 'camp-new',
            title: 'Street Mural',
            status: 'active',
            deadline: '2026-12-01T00:00:00.000Z',
            target_amount: '1000',
            raised_amount: '10',
            asset_type: 'USDC',
            category: 'arts',
            created_at: '2026-09-25T12:00:00.000Z',
          },
        ];
      },
    },
    './emailService': {
      sendWeeklyDigestEmail: async payload => {
        sent.push(payload);
      },
    },
  });

  const result = await sendWeeklyContributorDigests({
    runAt: new Date('2026-09-30T18:00:00.000Z'),
  });
  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'follower@example.com');
  assert.equal(sent[0].campaigns.length, 1);
  assert.equal(sent[0].campaigns[0].isNew, true);
  assert.equal(sent[0].campaigns[0].category, 'arts');
});

test('backed campaign in a followed category is deduped, not duplicated', async () => {
  const { buildCampaignDigest } = require('./weeklyDigestService');
  const digest = buildCampaignDigest({
    campaigns: [
      {
        id: 'camp-1',
        title: 'Same Campaign',
        deadline: '2026-12-01T00:00:00.000Z',
        target_amount: '100',
        raised_amount: '10',
        asset_type: 'USDC',
        category: 'arts',
      },
    ],
    updates: [],
    milestones: [],
    statuses: [],
    windowEnd: new Date('2026-09-30T18:00:00.000Z'),
    newCampaignIds: new Set(['camp-1']),
  });
  assert.equal(digest.length, 1);
  assert.equal(digest[0].isNew, true);
});

test('users opted out via category_digest are excluded from recipients', async () => {
  let sawPreferenceGate = false;
  const { sendWeeklyContributorDigests } = proxyquire('./weeklyDigestService', {
    '../config/database': {
      query: async text => {
        if (text.includes('FROM users u')) {
          sawPreferenceGate =
            sawPreferenceGate || text.includes('COALESCE(np.category_digest, TRUE)');
          return { rows: [] };
        }
        if (text.includes('FROM contributions ctr')) return { rows: [] };
        if (text.includes('FROM category_follows')) return { rows: [] };
        if (text.includes('FROM campaigns c')) return { rows: [] };
        if (text.includes('FROM campaign_updates')) return { rows: [] };
        if (text.includes('FROM milestones')) return { rows: [] };
        if (text.includes('FROM campaign_status_events')) return { rows: [] };
        if (text.includes('INSERT INTO email_digest_deliveries')) return { rows: [] };
        return { rows: [] };
      },
    },
    '../config/logger': { info: () => {} },
    './emailService': {
      sendWeeklyDigestEmail: async () => {
        throw new Error('should not send');
      },
    },
  });
  const result = await sendWeeklyContributorDigests({
    runAt: new Date('2026-09-30T18:00:00.000Z'),
  });
  assert.deepEqual(result, { sent: 0, skipped: 0 });
  assert.equal(sawPreferenceGate, true);
});
