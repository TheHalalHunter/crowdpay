const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmail } = require('./emailService');
const { isValidRole } = require('../lib/campaignPermissions');

const INVITE_TTL_DAYS = 7;

function inviteExpiresAt() {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function buildInviteUrl(campaignId, inviteToken) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/campaigns/${campaignId}/invite/${inviteToken}`;
}

async function sendCampaignInviteEmail({ email, role, campaignTitle, inviteUrl }) {
  await sendEmail({
    to: email,
    subject: `Invitation to join ${campaignTitle || 'a CrowdPay campaign'}`,
    text: [
      `You have been invited to join "${campaignTitle || 'a campaign'}" on CrowdPay as ${role}.`,
      '',
      `Accept your invitation (expires in ${INVITE_TTL_DAYS} days):`,
      inviteUrl,
    ].join('\n'),
  });
}

async function createCampaignInvite({ campaignId, email, role, invitedByUserId, campaignTitle }) {
  if (!isValidRole(role)) {
    const err = new Error('Invalid role. Must be owner, manager, editor, or viewer');
    err.statusCode = 422;
    throw err;
  }

  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.statusCode = 422;
    throw err;
  }

  const { rows: users } = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [
    normalizedEmail,
  ]);
  const inviteeUserId = users[0]?.id || null;

  const { rows: existing } = await db.query(
    'SELECT id, accepted_at FROM campaign_members WHERE campaign_id = $1 AND LOWER(email) = $2',
    [campaignId, normalizedEmail]
  );
  if (existing.length) {
    const err = new Error(
      existing[0].accepted_at
        ? 'User is already a member of this campaign'
        : 'Invitation already sent to this user'
    );
    err.statusCode = 409;
    throw err;
  }

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = inviteExpiresAt();

  const { rows } = await db.query(
    `INSERT INTO campaign_members
       (campaign_id, user_id, email, role, invited_by, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, campaign_id, user_id, email, role, accepted_at, invite_expires_at, created_at`,
    [campaignId, inviteeUserId, normalizedEmail, role, invitedByUserId, inviteToken, expiresAt]
  );

  const inviteUrl = buildInviteUrl(campaignId, inviteToken);
  try {
    await sendCampaignInviteEmail({
      email: normalizedEmail,
      role,
      campaignTitle,
      inviteUrl,
    });
  } catch (err) {
    logger.error('Failed to send campaign invite email', {
      campaign_id: campaignId,
      email: normalizedEmail,
      error: err.message,
    });
  }

  return { member: rows[0], inviteUrl };
}

async function resendCampaignInvite({ memberId, campaignId, campaignTitle }) {
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = inviteExpiresAt();

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET invite_token = $1,
         invite_expires_at = $2
     WHERE id = $3
       AND campaign_id = $4
       AND accepted_at IS NULL
     RETURNING id, campaign_id, email, role, accepted_at, invite_expires_at, created_at`,
    [inviteToken, expiresAt, memberId, campaignId]
  );

  if (!rows.length) {
    const err = new Error('Pending invitation not found');
    err.statusCode = 404;
    throw err;
  }

  const inviteUrl = buildInviteUrl(campaignId, inviteToken);
  try {
    await sendCampaignInviteEmail({
      email: rows[0].email,
      role: rows[0].role,
      campaignTitle,
      inviteUrl,
    });
  } catch (err) {
    logger.error('Failed to resend campaign invite email', {
      campaign_id: campaignId,
      member_id: memberId,
      error: err.message,
    });
  }

  return { member: rows[0], inviteUrl };
}

async function cancelCampaignInvite({ memberId, campaignId }) {
  const { rows } = await db.query(
    `DELETE FROM campaign_members
     WHERE id = $1
       AND campaign_id = $2
       AND accepted_at IS NULL
     RETURNING id`,
    [memberId, campaignId]
  );
  if (!rows.length) {
    const err = new Error('Pending invitation not found');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function getInvitePreview(inviteToken) {
  const { rows } = await db.query(
    `SELECT cm.id, cm.campaign_id, cm.email, cm.role, cm.accepted_at, cm.invite_expires_at,
            c.title AS campaign_title
     FROM campaign_members cm
     JOIN campaigns c ON c.id = cm.campaign_id
     WHERE cm.invite_token = $1`,
    [inviteToken]
  );
  if (!rows.length) return null;

  const invite = rows[0];
  const expired =
    !invite.accepted_at &&
    invite.invite_expires_at &&
    new Date(invite.invite_expires_at) < new Date();

  return {
    campaign_id: invite.campaign_id,
    campaign_title: invite.campaign_title,
    email: invite.email,
    role: invite.role,
    accepted_at: invite.accepted_at,
    invite_expires_at: invite.invite_expires_at,
    expired,
  };
}

async function acceptCampaignInvite({ inviteToken, userId, userEmail }) {
  const { rows: invites } = await db.query(
    `SELECT id, campaign_id, accepted_at, invite_expires_at, email, role
     FROM campaign_members
     WHERE invite_token = $1`,
    [inviteToken]
  );

  if (!invites.length) {
    const err = new Error('Invalid invitation token');
    err.statusCode = 404;
    throw err;
  }

  const invite = invites[0];
  if (invite.accepted_at) {
    const err = new Error('Invitation already accepted');
    err.statusCode = 409;
    throw err;
  }
  if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
    const err = new Error('Invitation has expired');
    err.statusCode = 410;
    throw err;
  }

  const normalizedUserEmail = String(userEmail || '')
    .trim()
    .toLowerCase();
  if (normalizedUserEmail && normalizedUserEmail !== String(invite.email).toLowerCase()) {
    const err = new Error('This invitation was sent to a different email address');
    err.statusCode = 403;
    throw err;
  }

  const { rows } = await db.query(
    `UPDATE campaign_members
     SET user_id = $1,
         accepted_at = NOW(),
         invite_token = NULL,
         invite_expires_at = NULL
     WHERE id = $2
     RETURNING id, campaign_id, user_id, email, role, accepted_at`,
    [userId, invite.id]
  );

  return rows[0];
}

async function countAcceptedOwners(campaignId) {
  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  if (!campaignRows.length) return 0;

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM campaign_members
     WHERE campaign_id = $1
       AND role = 'owner'
       AND accepted_at IS NOT NULL`,
    [campaignId]
  );

  // Creator is always treated as an implicit owner even if not in campaign_members.
  return Math.max(1, rows[0]?.count || 0);
}

async function resolveUserCampaignRole(campaignId, userId, isAdmin = false) {
  if (isAdmin) return 'owner';

  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  if (!campaignRows.length) return null;
  if (campaignRows[0].creator_id === userId) return 'owner';

  const { rows: memberRows } = await db.query(
    'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId]
  );
  if (memberRows.length && memberRows[0].accepted_at) {
    return memberRows[0].role;
  }
  return null;
}

module.exports = {
  INVITE_TTL_DAYS,
  createCampaignInvite,
  resendCampaignInvite,
  cancelCampaignInvite,
  getInvitePreview,
  acceptCampaignInvite,
  countAcceptedOwners,
  resolveUserCampaignRole,
  buildInviteUrl,
};
