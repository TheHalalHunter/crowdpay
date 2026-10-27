process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://crowdpay:crowdpay@localhost:5432/crowdpay';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('sendWeeklyContributorDigests sends grouped digests and records delivery state', async () => {
  const sent = [];
  const inserts = [];

  const { sendWeeklyContributorDigests } = proxyquire('./weeklyDigestService', {
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('FROM users u') && text.includes('category_follows')) {
          return {
            rows: [
              {
                id: 'user-1',
                email: 'backer@example.com',
                name: 'Backer',
                window_start: '2026-06-22T18:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM category_follows WHERE user_id')) {
          return { rows: [] };
        }
        if (
          text.includes('FROM contributions ctr') &&
          text.includes('campaign_update_unsubscribes')
        ) {
          assert.equal(params[0], 'user-1');
          assert.equal(params[1], 'backer@example.com');
          return {
            rows: [
              {
                id: 'camp-1',
                title: 'Solar Garden',
                status: 'active',
                deadline: '2026-07-02T00:00:00.000Z',
                target_amount: '100',
                raised_amount: '75',
                asset_type: 'USDC',
              },
            ],
          };
        }
        if (text.includes('FROM campaign_updates')) {
          return {
            rows: [
              {
                campaign_id: 'camp-1',
                title: 'Prototype shipped',
                created_at: '2026-06-25T12:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM milestones')) {
          return {
            rows: [
              {
                campaign_id: 'camp-1',
                title: 'Alpha milestone',
                released_at: '2026-06-26T12:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('FROM campaign_status_events')) {
          return {
            rows: [
              {
                campaign_id: 'camp-1',
                new_status: 'funded',
                created_at: '2026-06-27T12:00:00.000Z',
              },
            ],
          };
        }
        if (text.includes('INSERT INTO email_digest_deliveries')) {
          inserts.push(params);
          return { rows: [{ id: 'digest-1' }] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    },
    '../config/logger': { info: () => {} },
    './categoryFollowService': {
      listNewCampaignsInCategories: async () => [],
    },
    './emailService': {
      sendWeeklyDigestEmail: async payload => {
        sent.push(payload);
      },
    },
  });

  const result = await sendWeeklyContributorDigests({
    runAt: new Date('2026-06-29T18:00:00.000Z'),
  });

  assert.deepEqual(result, { sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'backer@example.com');
  assert.equal(sent[0].campaigns.length, 1);
  assert.equal(sent[0].campaigns[0].updates[0], 'Prototype shipped (2026-06-25)');
  assert.equal(sent[0].campaigns[0].milestones[0], 'Alpha milestone released (2026-06-26)');
  assert.equal(sent[0].campaigns[0].statusChanges[0], 'Campaign funded (2026-06-27)');
  assert.equal(sent[0].campaigns[0].upcomingDeadlines[0], 'Deadline on 2026-07-02');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'user-1');
  assert.equal(inserts[0][1], 'weekly_digest');
});

test('buildCampaignDigest excludes campaigns without activity in the window', async () => {
  const { buildCampaignDigest } = require('./weeklyDigestService');

  const digest = buildCampaignDigest({
    campaigns: [
      {
        id: 'camp-1',
        title: 'Keep',
        deadline: '2026-07-01T00:00:00.000Z',
        target_amount: '100',
        raised_amount: '50',
        asset_type: 'USDC',
      },
      {
        id: 'camp-2',
        title: 'Drop',
        deadline: '2026-07-20T00:00:00.000Z',
        target_amount: '100',
        raised_amount: '10',
        asset_type: 'USDC',
      },
    ],
    updates: [],
    milestones: [],
    statuses: [],
    windowEnd: new Date('2026-06-29T18:00:00.000Z'),
  });

  assert.equal(digest.length, 1);
  assert.equal(digest[0].title, 'Keep');
  assert.equal(digest[0].upcomingDeadlines[0], 'Deadline on 2026-07-01');
});
