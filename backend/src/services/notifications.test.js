const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

// Build the notifications service with an injectable db and channel layer.
function buildService({ settings = null, prefs = [] } = {}) {
  const state = {
    inApp: [],
    queued: [],
    delivered: [],
    pushed: [],
    flushed: [],
    claimedRows: [],
    deliveryResult: null,
  };

  const db = {
    connect: async () => ({
      query: async (text, params) => db.query(text, params),
      release: () => {},
    }),
    query: async (text, params) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO notifications')) {
        state.inApp.push({ userId: params[0], type: params[1], title: params[2] });
        return { rows: [] };
      }
      if (text.includes('FROM notification_channel_settings') && text.includes('WHERE user_id')) {
        return { rows: settings ? [settings] : [] };
      }
      if (text.includes('FROM notification_preferences')) {
        return { rows: prefs };
      }
      if (text.includes('INSERT INTO notification_queue')) {
        state.queued.push({
          userId: params[0],
          channel: params[1],
          type: params[2],
          title: params[3],
        });
        return { rows: [] };
      }
      if (text.includes('SELECT q.id') && text.includes('FROM notification_queue q')) {
        const rows = state.pendingRows || [];
        state.pendingRows = [];
        state.claimedRows = rows;
        return { rows };
      }
      if (text.includes('UPDATE notification_queue SET flushed_at = NULL')) {
        const retryIds = new Set(params[0]);
        state.pendingRows.push(...state.claimedRows.filter(row => retryIds.has(row.id)));
        return { rows: [] };
      }
      if (text.includes('UPDATE notification_queue SET flushed_at')) {
        state.flushed.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const channels = proxyquire('./notificationChannels', {
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
  });
  // Wrap deliver to record calls without doing real HTTP.
  const realCritical = channels.isCriticalEvent;
  const stubChannels = {
    CHANNELS: channels.CHANNELS,
    isCriticalEvent: realCritical,
    destinationFor: channels.destinationFor,
    messageText: channels.messageText,
    deliver: async (channel, s, message) => {
      state.delivered.push({ channel, message });
      return state.deliveryResult ? state.deliveryResult(channel, s, message) : true;
    },
  };

  const service = proxyquire('./notifications', {
    '../config/database': db,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
    './notificationChannels': stubChannels,
    './fcmPushService': {
      sendToUser: async (userId, message) => {
        state.pushed.push({ userId, message });
        return true;
      },
    },
  });

  return { service, state };
}

test('createNotification always writes the in-app notification', async () => {
  const { service, state } = buildService();
  await service.createNotification('user-1', { type: 'thank_you', title: 'Thanks!' });
  assert.equal(state.inApp.length, 1);
  assert.equal(state.inApp[0].type, 'thank_you');
});

test('createNotification does not fan out when no channel settings exist', async () => {
  const { service, state } = buildService({ settings: null });
  await service.createNotification('user-1', { type: 'thank_you', title: 'Thanks!' });
  assert.equal(state.delivered.length, 0);
  assert.equal(state.queued.length, 0);
});

test('createNotification delivers to configured channels outside quiet hours', async () => {
  const { service, state } = buildService({
    settings: {
      user_id: 'user-1',
      push_token: null,
      slack_webhook_url: 'https://slack.test/hook',
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
    },
  });
  await service.createNotification(
    'user-1',
    { type: 'campaign_update', title: 'Update' },
    { nowHour: 12 }
  );
  assert.equal(state.delivered.length, 1);
  assert.equal(state.delivered[0].channel, 'slack');
  assert.equal(state.queued.length, 0);
});

test('createNotification delivers push notifications to registered FCM devices', async () => {
  const { service, state } = buildService({
    settings: {
      user_id: 'user-1',
      push_token: null,
      push_enabled: true,
      slack_webhook_url: null,
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
    },
  });
  await service.createNotification('user-1', {
    type: 'campaign_update',
    title: 'Update',
    link: '/campaigns/1',
  });
  assert.equal(state.pushed.length, 1);
  assert.equal(state.pushed[0].userId, 'user-1');
  assert.equal(state.pushed[0].message.link, '/campaigns/1');
});

test('createNotification respects a per-event channel disable override', async () => {
  const { service, state } = buildService({
    settings: {
      user_id: 'user-1',
      push_token: null,
      slack_webhook_url: 'https://slack.test/hook',
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: null,
      quiet_hours_end: null,
    },
    prefs: [{ channel: 'slack', enabled: false }],
  });
  await service.createNotification(
    'user-1',
    { type: 'campaign_update', title: 'Update' },
    { nowHour: 12 }
  );
  assert.equal(state.delivered.length, 0);
});

test('createNotification queues non-critical events during quiet hours', async () => {
  const { service, state } = buildService({
    settings: {
      user_id: 'user-1',
      push_token: null,
      slack_webhook_url: 'https://slack.test/hook',
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  });
  await service.createNotification(
    'user-1',
    { type: 'campaign_update', title: 'Update' },
    { nowHour: 23 }
  );
  assert.equal(state.delivered.length, 0);
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].channel, 'slack');
});

test('createNotification delivers critical events immediately even during quiet hours', async () => {
  const { service, state } = buildService({
    settings: {
      user_id: 'user-1',
      push_token: null,
      slack_webhook_url: 'https://slack.test/hook',
      discord_webhook_url: null,
      sms_phone_number: null,
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  });
  await service.createNotification(
    'user-1',
    { type: 'withdrawal_approved', title: 'Approved' },
    { nowHour: 23 }
  );
  assert.equal(state.delivered.length, 1);
  assert.equal(state.queued.length, 0);
});

test('inQuietHours handles windows that wrap past midnight', () => {
  const { service } = buildService();
  const settings = { quiet_hours_start: 22, quiet_hours_end: 7 };
  assert.equal(service.inQuietHours(settings, 23), true);
  assert.equal(service.inQuietHours(settings, 3), true);
  assert.equal(service.inQuietHours(settings, 12), false);
});

test('inQuietHours handles same-day windows and disabled state', () => {
  const { service } = buildService();
  assert.equal(service.inQuietHours({ quiet_hours_start: 9, quiet_hours_end: 17 }, 12), true);
  assert.equal(service.inQuietHours({ quiet_hours_start: 9, quiet_hours_end: 17 }, 20), false);
  assert.equal(service.inQuietHours({ quiet_hours_start: null, quiet_hours_end: null }, 12), false);
});

test('flushQuietHours delivers a digest and marks queued rows flushed', async () => {
  const { service, state } = buildService();
  state.pendingRows = [
    {
      id: 'q1',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'First',
      body: null,
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
    {
      id: 'q2',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'Second',
      body: null,
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  ];
  const flushed = await service.flushQuietHours({ nowHour: 9 });
  assert.equal(flushed, 1);
  assert.equal(state.delivered.length, 1);
  assert.ok(state.delivered[0].message.title.includes('2'));
  assert.deepEqual(state.flushed[0], ['q1', 'q2']);
});

test('flushQuietHours skips users still inside their quiet window', async () => {
  const { service, state } = buildService();
  state.pendingRows = [
    {
      id: 'q1',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'First',
      body: null,
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  ];
  const flushed = await service.flushQuietHours({ nowHour: 23 });
  assert.equal(flushed, 0);
  assert.equal(state.delivered.length, 0);
});

test('flushQuietHours handles concurrent flushes without double-sending or losing rows', async () => {
  const { service, state } = buildService();
  state.pendingRows = [
    {
      id: 'q1',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'Concurrent Row',
      body: null,
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  ];

  const [res1, res2] = await Promise.all([
    service.flushQuietHours({ nowHour: 9 }),
    service.flushQuietHours({ nowHour: 9 }),
  ]);

  // Exactly one worker claims the rows due to SKIP LOCKED; the second gets 0 rows.
  const totalFlushed = res1 + res2;
  assert.equal(totalFlushed, 1);
  assert.equal(state.delivered.length, 1);
  assert.equal(state.flushed.length, 1);
  assert.deepEqual(state.flushed[0], ['q1']);
});

test('flushQuietHours retries only failed channels', async () => {
  const { service, state } = buildService();
  const slackRow = {
    id: 'q-slack',
    user_id: 'user-1',
    channel: 'slack',
    type: 'campaign_update',
    title: 'Slack update',
    body: null,
    link: null,
    slack_webhook_url: 'https://slack.test/hook',
    quiet_hours_start: null,
    quiet_hours_end: null,
  };
  const discordRow = {
    ...slackRow,
    id: 'q-discord',
    channel: 'discord',
    title: 'Discord update',
    slack_webhook_url: null,
    discord_webhook_url: 'https://discord.test/hook',
  };
  state.pendingRows = [slackRow, discordRow];
  let discordAvailable = false;
  state.deliveryResult = channel => channel !== 'discord' || discordAvailable;

  const firstAttempt = await service.flushQuietHours({ nowHour: 9 });
  assert.equal(firstAttempt, 1);
  assert.deepEqual(
    state.delivered.map(delivery => delivery.channel),
    ['slack', 'discord']
  );
  assert.deepEqual(state.pendingRows.map(row => row.id), ['q-discord']);

  discordAvailable = true;
  const retryAttempt = await service.flushQuietHours({ nowHour: 9 });
  assert.equal(retryAttempt, 1);
  assert.deepEqual(
    state.delivered.map(delivery => delivery.channel),
    ['slack', 'discord', 'discord']
  );
});

test('flushQuietHours joins digest item bodies with real newlines and no literal backslash-n', async () => {
  const { service, state } = buildService();
  state.pendingRows = [
    {
      id: 'q1',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'First Update',
      body: 'First update body line',
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
    {
      id: 'q2',
      user_id: 'user-1',
      channel: 'slack',
      type: 'campaign_update',
      title: 'Second Update',
      body: 'Second update body line',
      link: null,
      slack_webhook_url: 'https://slack.test/hook',
      quiet_hours_start: 22,
      quiet_hours_end: 7,
    },
  ];

  const flushed = await service.flushQuietHours({ nowHour: 9 });
  assert.equal(flushed, 1);
  assert.equal(state.delivered.length, 1);
  const digestBody = state.delivered[0].message.body;
  assert.equal(digestBody, 'First update body line\nSecond update body line');
  assert.ok(digestBody.includes('\n'), 'Digest body should contain newline characters');
  assert.ok(!digestBody.includes('\\n'), 'Digest body must not contain literal backslash-n');
});
