const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ capturedQueries = [] } = {}) {
  let uploadedBody = null;
  const db = {
    query: async (text, params) => {
      capturedQueries.push({ text, params });
      if (text.includes('UPDATE user_data_exports')) return { rows: [] };
      if (text.includes('FROM users')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'alice@example.com',
              name: 'Alice',
              role: 'contributor',
              created_at: '2026-01-01T00:00:00.000Z',
              wallet_public_key: 'GALICE',
              password_hash: 'never-export-this',
              wallet_secret_encrypted: 'never-export-this-either',
            },
          ],
        };
      }
      if (text.includes('FROM campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Alice campaign',
              target_amount: '100',
              raised_amount: '25',
            },
          ],
        };
      }
      if (text.includes('FROM milestones')) {
        return { rows: [{ id: 'milestone-1', campaign_id: 'campaign-1' }] };
      }
      if (text.includes('FROM campaign_updates')) {
        return { rows: [{ id: 'update-1', campaign_id: 'campaign-1', title: 'Hello' }] };
      }
      if (text.includes('FROM user_sessions')) {
        return {
          rows: [
            {
              id: 'session-1',
              created_at: '2026-01-01T00:00:00.000Z',
              last_seen_at: '2026-01-02T00:00:00.000Z',
              location_region: 'Lagos',
            },
          ],
        };
      }
      if (text.includes('FROM contributions')) {
        return {
          rows: [
            {
              id: 'contribution-1',
              campaign_id: 'campaign-1',
              amount: '25',
              asset: 'USDC',
            },
          ],
        };
      }
      if (text.includes('FROM notification_preferences')) {
        return {
          rows: [
            {
              campaign_updates: true,
              refunds: true,
              disputes: true,
              milestones: true,
              marketing: false,
              category_digest: true,
            },
          ],
        };
      }
      if (text.includes('FROM campaign_referrals')) return { rows: [{ id: 'referral-1' }] };
      if (text.includes('FROM disputes')) return { rows: [{ id: 'dispute-1' }] };
      if (text.includes('FROM recurring_contributions')) {
        return { rows: [{ id: 'subscription-1' }] };
      }
      if (text.includes('FROM api_keys')) {
        return { rows: [{ id: 'key-1', label: 'CI', scopes: ['read'], key_hash: 'secret' }] };
      }
      if (text.includes('FROM category_follows')) {
        return { rows: [{ category: 'technology' }] };
      }
      if (text.includes('FROM notifications')) {
        return { rows: [{ id: 'notification-1', title: 'Welcome' }] };
      }
      return { rows: [] };
    },
  };

  const service = proxyquire('./exportService', {
    '../config/database': db,
    '../config/logger': { error: () => {}, warn: () => {} },
    '@aws-sdk/client-s3': {
      S3Client: class {
        async send(command) {
          uploadedBody = command.input.Body;
        }
      },
      PutObjectCommand: class {
        constructor(input) {
          this.input = input;
        }
      },
      GetObjectCommand: class {
        constructor(input) {
          this.input = input;
        }
      },
    },
    '@aws-sdk/s3-request-presigner': {
      getSignedUrl: async () => 'https://storage.example.test/signed',
    },
  });

  return {
    service,
    queries: capturedQueries,
    getUploadedBody: () => uploadedBody,
  };
}

test('user data export includes creator and contributor scopes without sensitive fields', async () => {
  const previousEndpoint = process.env.STORAGE_ENDPOINT;
  const previousBucket = process.env.STORAGE_BUCKET;
  process.env.STORAGE_ENDPOINT = 'https://storage.example.test';
  process.env.STORAGE_BUCKET = 'exports';

  try {
    const { service, queries, getUploadedBody } = buildService();
    await service.generateUserExport('user-1', 'export-1');

    const data = JSON.parse(getUploadedBody().toString('utf8'));

    assert.equal(data.profile.id, 'user-1');
    assert.equal(data.profile.password_hash, undefined);
    assert.equal(data.profile.wallet_secret_encrypted, undefined);
    assert.equal(data.creator_campaigns.length, 1);
    assert.equal(data.creator_milestones.length, 1);
    assert.equal(data.campaign_updates.length, 1);
    assert.equal(data.contributions.length, 1);
    assert.equal(data.notification_preferences.campaign_updates, true);
    assert.equal(data.credentials[0].key_hash, undefined);
    assert.equal(data.sessions[0].ip_address, undefined);
    assert.equal(data.sessions[0].user_agent, undefined);
    assert.deepEqual(data.scopes, service.EXPORT_SCOPES);

    // Every data query is scoped to the authenticated user.
    for (const query of queries) {
      if (query.params.length && !query.text.includes('UPDATE user_data_exports')) {
        assert.equal(query.params[0], 'user-1');
      }
    }

    const completed = queries.find(query => query.text.includes('UPDATE user_data_exports'));
    assert.ok(completed);
    assert.equal(completed.params[2], 'export-1');
  } finally {
    if (previousEndpoint === undefined) delete process.env.STORAGE_ENDPOINT;
    else process.env.STORAGE_ENDPOINT = previousEndpoint;
    if (previousBucket === undefined) delete process.env.STORAGE_BUCKET;
    else process.env.STORAGE_BUCKET = previousBucket;
  }
});
