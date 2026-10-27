const nodemailer = require('nodemailer');
const db = require('../config/database');
const logger = require('../config/logger');
const { getStellarExpertTxUrl } = require('../utils/stellarExplorer');
const { buildUnsubscribeUrl } = require('../utils/unsubscribeToken');

const welcomeEmail = require('../emails/welcome');
const campaignFraudFlaggedEmail = require('../emails/campaignFraudFlagged');
const contributionReceiptEmail = require('../emails/contributionReceipt');
const campaignFundedEmail = require('../emails/campaignFunded');
const campaignFailedEmail = require('../emails/campaignFailed');
const withdrawalApprovedEmail = require('../emails/withdrawalApproved');
const withdrawalRejectedEmail = require('../emails/withdrawalRejected');
const milestoneReleasedEmail = require('../emails/milestoneReleased');
const milestoneEvidenceSubmittedEmail = require('../emails/milestoneEvidenceSubmitted');
const kycApprovedEmail = require('../emails/kycApproved');
const kycRejectedEmail = require('../emails/kycRejected');
const disputeOpenedEmail = require('../emails/disputeOpened');
const disputeResolvedEmail = require('../emails/disputeResolved');
const campaignUpdatePostedEmail = require('../emails/campaignUpdatePosted');
const weeklyDigestEmail = require('../emails/weeklyDigest');
const teamMemberInvitedEmail = require('../emails/teamMemberInvited');
const thankYouEmail = require('../emails/thankYou');
const walletFundingFailedEmail = require('../emails/walletFundingFailed');
const campaignCommentEmail = require('../emails/campaignComment');
const fundsReleasedEmail = require('../emails/fundsReleased');
const recurringContributionNoticeEmail = require('../emails/recurringContributionNotice');
const campaignDeadlineReminderEmail = require('../emails/campaignDeadlineReminder');

let transporter;

const emailsDisabled = String(process.env.DISABLE_EMAILS || '').toLowerCase() === 'true';

if (!emailsDisabled && (process.env.SMTP_HOST || process.env.EMAIL_SERVICE_API_KEY)) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER || 'apikey',
      pass: process.env.SMTP_PASS || process.env.EMAIL_SERVICE_API_KEY,
    },
  });
}

let warnedUnconfigured = false;

/**
 * True when a transporter exists, i.e. emails can actually be delivered.
 * Reads the state established at module load so it cannot drift from the
 * transporter that sendEmail() really uses.
 */
function isEmailConfigured() {
  return Boolean(transporter);
}

/**
 * Sends an email asynchronously.
 */
async function sendEmail({ to, subject, text, html }) {
  if (emailsDisabled) {
    logger.info('Email sending disabled', { subject });
    return;
  }

  if (!transporter) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn(
        'Email Service is not configured (SMTP_HOST / EMAIL_SERVICE_API_KEY unset): transactional emails are NOT being delivered',
        { subject }
      );
    }
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"CrowdPay" <noreply@crowdpay.local>',
      to,
      subject,
      text: text || '',
      html: html || '',
    });
  } catch (error) {
    logger.error('Failed to send email', { subject, err: error.message });
    throw error;
  }
}

/**
 * Sends an email at most once per dedupeKey. Used to guard against duplicate
 * sends when a triggering event (webhook retry, route retry, etc) fires more
 * than once for the same logical occurrence.
 */
async function sendIdempotent({ dedupeKey, to, subject, text, html }) {
  if (!to) return;

  // Without a transporter nothing can be delivered. Do not consume the dedupe
  // key, so the email can still be sent once email is configured.
  if (!transporter) {
    await sendEmail({ to, subject, text, html });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO sent_emails (dedupe_key, recipient_email)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [dedupeKey, to]
  );

  if (!rows.length) {
    logger.info('Email Service: skipped duplicate send', { dedupeKey });
    return;
  }

  try {
    await sendEmail({ to, subject, text, html });
  } catch (err) {
    try {
      await db.query('DELETE FROM sent_emails WHERE dedupe_key = $1', [dedupeKey]);
    } catch (cleanupError) {
      logger.error('Failed to release email dedupe claim', {
        dedupeKey,
        error: cleanupError.message,
      });
    }
    throw err;
  }
}

async function isUnsubscribed(email, category) {
  // Try to find the user
  const { rows: users } = await db.query('SELECT id FROM users WHERE email = $1', [
    email.toLowerCase(),
  ]);
  if (!users.length) return false;

  // Map old categories to the new ones
  const map = {
    marketing: 'marketing',
    campaign_update: 'campaign_updates',
    refund: 'refunds',
    milestone: 'milestones',
    dispute: 'disputes',
    category_digest: 'category_digest',
    weekly_digest: 'marketing',
  };
  const mapped = map[category] || 'campaign_updates';

  let rows = [];
  try {
    const result = await db.query('SELECT * FROM notification_preferences WHERE user_id = $1', [
      users[0].id,
    ]);
    rows = result.rows;
  } catch (err) {
    // Pre-migration database without the category_digest column.
    if (err?.code !== '42703') throw err;
    const result = await db.query(
      'SELECT user_id, campaign_updates, refunds, disputes, milestones, marketing FROM notification_preferences WHERE user_id = $1',
      [users[0].id]
    );
    rows = result.rows;
  }
  if (!rows.length) {
    // defaults: marketing off, category digest on, others on
    return mapped === 'marketing';
  }

  if (mapped === 'category_digest' && rows[0].category_digest === undefined) return false;
  return !rows[0][mapped];
}

async function isCampaignUpdateUnsubscribed(email, campaignId) {
  const { rows } = await db.query(
    'SELECT 1 FROM campaign_update_unsubscribes WHERE email = $1 AND campaign_id = $2',
    [email.toLowerCase(), campaignId]
  );
  return rows.length > 0;
}

async function sendWelcomeEmail({ to, name, walletPublicKey }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'marketing')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'marketing' });
  const { subject, text, html } = welcomeEmail.build({ name, walletPublicKey, unsubscribeUrl });
  await sendIdempotent({ dedupeKey: `welcome:${to}`, to, subject, text, html });
}

/**
 * Sends a recurring automated-billing notification (#738). `kind` is one of
 * 'upcoming' | 'charged' | 'failed'. `recurringRunKey` identifies the exact
 * charge attempt so the message is sent at most once per occurrence.
 */
async function sendRecurringContributionNoticeEmail({ to, kind, recurringRunKey, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  if (!['upcoming', 'charged', 'failed'].includes(kind)) return;

  let built;
  if (kind === 'upcoming')
    built = recurringContributionNoticeEmail.buildUpcoming({ ...params, unsubscribeUrl });
  else if (kind === 'charged')
    built = recurringContributionNoticeEmail.buildCharged({ ...params, unsubscribeUrl });
  else built = recurringContributionNoticeEmail.buildFailed({ ...params, unsubscribeUrl });

  const { subject, text, html } = built;
  await sendIdempotent({
    dedupeKey: `recurring_notice:${kind}:${recurringRunKey}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendContributionReceipt({ campaignId, txHash, amount, asset, senderPublicKey }) {
  if (emailsDisabled) {
    logger.info('Email sending disabled, skipping contribution receipt');
    return;
  }

  const { rows: users } = await db.query(
    'SELECT email, name FROM users WHERE wallet_public_key = $1',
    [senderPublicKey]
  );

  if (!users.length || !users[0].email) {
    return;
  }

  const { rows: campaigns } = await db.query('SELECT title FROM campaigns WHERE id = $1', [
    campaignId,
  ]);

  if (!campaigns.length) {
    return;
  }

  if (await isUnsubscribed(users[0].email, 'refund')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: users[0].email, category: 'refund' });
  const { subject, text, html } = contributionReceiptEmail.build({
    name: users[0].name,
    campaignTitle: campaigns[0].title,
    amount,
    asset,
    txHash,
    date: new Date().toISOString(),
    unsubscribeUrl,
  });

  await sendIdempotent({
    dedupeKey: `contribution_receipt:${txHash}`,
    to: users[0].email,
    subject,
    text,
    html,
  });
}

async function sendCampaignFundedCreatorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = campaignFundedEmail.buildForCreator({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_funded_creator:${campaignId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCampaignFundedContributorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = campaignFundedEmail.buildForContributor({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_funded_contributor:${campaignId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCampaignFailedCreatorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = campaignFailedEmail.buildForCreator({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_failed_creator:${campaignId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCampaignFailedContributorEmail({ to, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = campaignFailedEmail.buildForContributor({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_failed_contributor:${campaignId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendWithdrawalApprovedEmail({ to, withdrawalId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = withdrawalApprovedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `withdrawal_approved:${withdrawalId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendWithdrawalRejectedEmail({ to, withdrawalId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = withdrawalRejectedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `withdrawal_rejected:${withdrawalId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendMilestoneReleasedCreatorEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = milestoneReleasedEmail.buildForCreator({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `milestone_released_creator:${milestoneId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendMilestoneReleasedContributorEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = milestoneReleasedEmail.buildForContributor({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `milestone_released_contributor:${milestoneId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendContributorFundsReleasedEmail({ to, dedupeKey, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = fundsReleasedEmail.buildContributorRelease(params);
  await sendIdempotent({ dedupeKey, to, subject, text, html });
}

async function sendMilestoneEvidenceSubmittedAdminEmail({ to, milestoneId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'milestone')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'milestone' });
  const { subject, text, html } = milestoneEvidenceSubmittedEmail.buildForAdmin({
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `milestone_evidence_submitted:${milestoneId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendKycApprovedEmail({ to, userId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = kycApprovedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `kyc_approved:${userId}:${Date.now()}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendKycRejectedEmail({ to, userId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = kycRejectedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `kyc_rejected:${userId}:${Date.now()}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendDisputeOpenedCreatorEmail({ to, disputeId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'dispute')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'dispute' });
  const { subject, text, html } = disputeOpenedEmail.buildForCreator({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `dispute_opened_creator:${disputeId}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendDisputeOpenedAdminEmail({ to, disputeId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'dispute')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'dispute' });
  const { subject, text, html } = disputeOpenedEmail.buildForAdmin({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `dispute_opened_admin:${disputeId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendDisputeResolvedCreatorEmail({ to, disputeId, outcome, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'dispute')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'dispute' });
  const { subject, text, html } = disputeResolvedEmail.buildForCreator({
    outcome,
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `dispute_resolved_creator:${disputeId}:${outcome}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendDisputeResolvedContributorEmail({ to, disputeId, outcome, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'dispute')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'dispute' });
  const { subject, text, html } = disputeResolvedEmail.buildForContributor({
    outcome,
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `dispute_resolved_contributor:${disputeId}:${outcome}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCampaignUpdatePostedEmail({ to, updateId, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  if (campaignId && (await isCampaignUpdateUnsubscribed(to, campaignId))) return;

  const unsubscribeUrl = buildUnsubscribeUrl({
    email: to,
    category: 'campaign_update',
    campaignId,
  });
  const { subject, text, html } = campaignUpdatePostedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `campaign_update_posted:${updateId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendWeeklyDigestEmail({ to, userId, windowEnd, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'weekly_digest')) return;

  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'weekly_digest' });
  const { subject, text, html } = weeklyDigestEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({
    dedupeKey: `weekly_digest:${userId}:${windowEnd.toISOString()}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendTeamMemberInvitedEmail({ to, memberId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = teamMemberInvitedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({ dedupeKey: `team_member_invited:${memberId}`, to, subject, text, html });
}

async function isThankYouUnsubscribed(email, campaignId) {
  const { rows } = await db.query(
    `SELECT 1 FROM thank_you_unsubscribes
     WHERE email = $1 AND (campaign_id IS NULL OR campaign_id = $2)
     LIMIT 1`,
    [email.toLowerCase(), campaignId]
  );
  return rows.length > 0;
}

async function sendThankYouEmail({ to, messageId, campaignId, ...params }) {
  if (!to) return;
  if (await isThankYouUnsubscribed(to, campaignId)) return;

  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'thank_you', campaignId });
  const { subject, text, html } = thankYouEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({ dedupeKey: `thank_you:${messageId}:${to}`, to, subject, text, html });
}

async function sendCampaignFraudFlaggedEmail({ to, campaignId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'dispute')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'dispute' });
  const { subject, text, html } = campaignFraudFlaggedEmail.build({
    campaignId,
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_fraud_flagged:${campaignId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCampaignDeadlineReminderEmail({ to, campaignId, hoursLeft, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = campaignDeadlineReminderEmail.build({
    hoursLeft,
    ...params,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_deadline_reminder:${campaignId}:${hoursLeft}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendWalletFundingFailedEmail({ to, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const { subject, text, html } = walletFundingFailedEmail.build({ ...params, unsubscribeUrl });
  await sendIdempotent({ dedupeKey: `wallet_funding_failed:${to}`, to, subject, text, html });
}

async function sendCampaignCommentEmail({ to, commentId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const campaignUrl = `${frontendUrl}/campaigns/${params.campaignId}`;
  const { subject, text, html } = campaignCommentEmail.buildForCreator({
    ...params,
    campaignUrl,
    unsubscribeUrl,
  });
  await sendIdempotent({
    dedupeKey: `campaign_comment:${commentId}:${to}`,
    to,
    subject,
    text,
    html,
  });
}

async function sendCommentReplyEmail({ to, commentId, ...params }) {
  if (!to) return;
  if (await isUnsubscribed(to, 'campaign_update')) return;
  const unsubscribeUrl = buildUnsubscribeUrl({ email: to, category: 'campaign_update' });
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const campaignUrl = `${frontendUrl}/campaigns/${params.campaignId}`;
  const { subject, text, html } = campaignCommentEmail.buildForCommenter({
    ...params,
    campaignUrl,
    unsubscribeUrl,
  });
  await sendIdempotent({ dedupeKey: `comment_reply:${commentId}:${to}`, to, subject, text, html });
}

module.exports = {
  sendEmail,
  isEmailConfigured,
  sendIdempotent,
  isUnsubscribed,
  isCampaignUpdateUnsubscribed,
  getStellarExpertTxUrl,
  sendContributionReceipt,
  sendRecurringContributionNoticeEmail,
  sendWelcomeEmail,
  sendWalletFundingFailedEmail,
  sendCampaignFundedCreatorEmail,
  sendCampaignFundedContributorEmail,
  sendCampaignFailedCreatorEmail,
  sendCampaignFailedContributorEmail,
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
  sendMilestoneReleasedCreatorEmail,
  sendMilestoneReleasedContributorEmail,
  sendContributorFundsReleasedEmail,
  sendMilestoneEvidenceSubmittedAdminEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendDisputeOpenedCreatorEmail,
  sendDisputeOpenedAdminEmail,
  sendDisputeResolvedCreatorEmail,
  sendDisputeResolvedContributorEmail,
  sendCampaignUpdatePostedEmail,
  sendWeeklyDigestEmail,
  sendTeamMemberInvitedEmail,
  isThankYouUnsubscribed,
  sendThankYouEmail,
  sendCampaignFraudFlaggedEmail,
  sendCampaignDeadlineReminderEmail,
  sendCampaignCommentEmail,
  sendCommentReplyEmail,
};
