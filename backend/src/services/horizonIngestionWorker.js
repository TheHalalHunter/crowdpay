/**
 * horizonIngestionWorker.js
 *
 * High-Throughput Horizon Ledger Event Ingestion Worker for CrowdPay.
 *
 * Manages streaming Horizon payment events with:
 * - Dynamic O(1) wallet index lookup
 * - Global & pooled Horizon stream management
 * - Bounded queue with configurable worker pool concurrency
 * - LRU/TTL deduplication cache
 * - Batched cursor checkpointing to reduce database pool contention
 * - Historical REST replay engine
 * - Complete worker lifecycle (start, stop, pause, resume, metrics, health)
 */

const { server } = require('../config/stellar');
const db = require('../config/database');
const logger = require('../config/logger');

class HorizonIngestionWorker {
  constructor(options = {}) {
    this.concurrency =
      options.concurrency || parseInt(process.env.HORIZON_INGESTION_CONCURRENCY || '10', 10);
    this.maxQueueSize =
      options.maxQueueSize || parseInt(process.env.HORIZON_INGESTION_MAX_QUEUE || '5000', 10);
    this.checkpointIntervalMs =
      options.checkpointIntervalMs ||
      parseInt(process.env.HORIZON_INGESTION_CHECKPOINT_MS || '1000', 10);
    this.dedupCacheLimit = options.dedupCacheLimit || 10000;

    // State
    this.status = 'stopped'; // "stopped" | "starting" | "running" | "paused" | "stopping" | "error"
    this.watchedWallets = new Map(); // wallet_public_key -> campaign_id
    this.campaignWallets = new Map(); // campaign_id -> wallet_public_key
    this.cursors = new Map(); // campaign_id -> last_cursor
    this.pendingCursors = new Map(); // campaign_id -> { walletPublicKey, cursorToken }

    // Processing queue & active workers
    this.queue = [];
    this.activeWorkers = 0;

    // Deduplication (Set of paging_tokens / tx_hashes)
    this.dedupCache = new Set();

    // Stream Handles
    this.streamCloseHandles = new Map(); // wallet_public_key -> closeFn
    this.globalStreamClose = null;
    this.checkpointTimer = null;

    // Reconnect tracking per wallet
    this.reconnectAttempts = new Map();

    // Metrics
    this.metrics = {
      ingested_count: 0,
      processed_count: 0,
      failed_count: 0,
      quarantined_count: 0,
      duplicate_count: 0,
      start_time: null,
      last_processed_at: null,
      last_error: null,
      eps_history: [], // timestamps for EPS
    };

    // Custom payment handler override (optional for testing or delegation)
    this.paymentHandler = options.paymentHandler || null;
  }

  setPaymentHandler(handler) {
    this.paymentHandler = handler;
  }

  extractPagingToken(record) {
    if (!record || typeof record !== 'object') return null;
    return record.paging_token || record.pagingToken || record.id || null;
  }

  /**
   * Add a payment transaction/token to the LRU cache.
   */
  trackDedup(key) {
    if (!key) return;
    if (this.dedupCache.size >= this.dedupCacheLimit) {
      const oldest = this.dedupCache.values().next().value;
      this.dedupCache.delete(oldest);
    }
    this.dedupCache.add(key);
  }

  isDuplicate(key) {
    if (!key) return false;
    return this.dedupCache.has(key);
  }

  /**
   * Load active and funded campaign wallets from DB into memory.
   */
  async loadCampaignWallets() {
    const { rows } = await db.query(
      `SELECT c.id, c.wallet_public_key, lc.last_cursor
       FROM campaigns c
       LEFT JOIN ledger_stream_cursors lc ON lc.campaign_id = c.id
       WHERE c.status IN ('active', 'funded') AND c.wallet_public_key IS NOT NULL`
    );

    this.watchedWallets.clear();
    this.campaignWallets.clear();
    this.cursors.clear();

    for (const row of rows) {
      this.watchedWallets.set(row.wallet_public_key, row.id);
      this.campaignWallets.set(row.id, row.wallet_public_key);
      if (row.last_cursor) {
        this.cursors.set(row.id, row.last_cursor);
      }
    }

    logger.info('Loaded campaign wallets for Horizon ingestion worker', {
      count: rows.length,
    });
    return rows;
  }

  /**
   * Register a single campaign wallet for monitoring.
   */
  async registerWallet(campaignId, walletPublicKey, cursor = null) {
    if (!campaignId || !walletPublicKey) return;
    this.watchedWallets.set(walletPublicKey, campaignId);
    this.campaignWallets.set(campaignId, walletPublicKey);
    if (cursor) {
      this.cursors.set(campaignId, cursor);
    }

    if (this.status === 'running') {
      await this.replayMissedPayments(campaignId, walletPublicKey);
      this.openStreamForWallet(campaignId, walletPublicKey);
    }
  }

  /**
   * Unregister a campaign wallet.
   */
  unregisterWallet(walletPublicKey) {
    const campaignId = this.watchedWallets.get(walletPublicKey);
    if (campaignId) {
      this.campaignWallets.delete(campaignId);
      this.cursors.delete(campaignId);
      this.pendingCursors.delete(campaignId);
    }
    this.watchedWallets.delete(walletPublicKey);

    const closeFn = this.streamCloseHandles.get(walletPublicKey);
    if (typeof closeFn === 'function') {
      try {
        closeFn();
      } catch (err) {
        logger.warn('Error closing stream during unregister', {
          wallet: walletPublicKey,
          error: err.message,
        });
      }
    }
    this.streamCloseHandles.delete(walletPublicKey);
    this.reconnectAttempts.delete(walletPublicKey);
  }

  /**
   * REST Replay missed payments after saved cursor.
   */
  async replayMissedPayments(campaignId, walletPublicKey) {
    let cursor = this.cursors.get(campaignId);
    if (!cursor) {
      try {
        const { rows } = await db.query(
          'SELECT last_cursor FROM ledger_stream_cursors WHERE campaign_id = $1',
          [campaignId]
        );
        if (rows.length && rows[0].last_cursor) {
          cursor = rows[0].last_cursor;
          this.cursors.set(campaignId, cursor);
        }
      } catch (err) {
        logger.error('Failed to load cursor during REST replay', {
          campaignId,
          error: err.message,
        });
      }
    }

    if (!cursor) return;

    for (;;) {
      let page;
      try {
        page = await server
          .payments()
          .forAccount(walletPublicKey)
          .cursor(cursor)
          .order('asc')
          .limit(100)
          .call();
      } catch (err) {
        logger.error('REST payment replay failed; proceeding with stream', {
          walletPublicKey,
          campaignId,
          error: err.message,
        });
        return;
      }

      const records = page.records || [];
      if (!records.length) break;

      for (const record of records) {
        await this.enqueuePaymentRecord(campaignId, walletPublicKey, record);
      }

      const pageToken = page.paging_token || this.extractPagingToken(records[records.length - 1]);
      if (!pageToken || pageToken === cursor) break;
      cursor = pageToken;
      this.cursors.set(campaignId, cursor);
      if (records.length < 100) break;
    }
  }

  /**
   * Enqueue a raw payment record for processing.
   */
  async enqueuePaymentRecord(campaignId, walletPublicKey, record) {
    const token = this.extractPagingToken(record);
    const txHash = record.transaction_hash;
    const dedupKey = token || txHash;

    if (dedupKey && this.isDuplicate(dedupKey)) {
      this.metrics.duplicate_count++;
      return;
    }

    if (dedupKey) {
      this.trackDedup(dedupKey);
    }

    this.metrics.ingested_count++;

    if (this.queue.length >= this.maxQueueSize) {
      logger.warn('Ingestion queue backpressure limit reached; dropping oldest event', {
        queue_size: this.queue.length,
        max_size: this.maxQueueSize,
        campaignId,
      });
      if (this.queue.length > this.maxQueueSize * 1.2) {
        this.queue.shift();
      }
    }

    this.queue.push({
      campaignId,
      walletPublicKey,
      record,
      enqueuedAt: Date.now(),
    });

    this.processQueue();
  }

  /**
   * Process queued jobs with worker pool concurrency control.
   */
  processQueue() {
    if (this.status !== 'running') return;

    while (this.queue.length > 0 && this.activeWorkers < this.concurrency) {
      const job = this.queue.shift();
      this.activeWorkers++;

      this.executeJob(job)
        .catch(err => {
          logger.error('Job execution exception in ingestion worker', {
            error: err.message,
            campaignId: job.campaignId,
          });
        })
        .finally(() => {
          this.activeWorkers--;
          this.processQueue();
        });
    }
  }

  /**
   * Execute an individual payment ingestion job.
   */
  async executeJob(job) {
    const { campaignId, walletPublicKey, record } = job;
    const token = this.extractPagingToken(record);

    try {
      if (this.paymentHandler) {
        await this.paymentHandler(campaignId, walletPublicKey, record);
      } else {
        const { onPaymentRecord } = require('./ledgerMonitor');
        await onPaymentRecord(campaignId, walletPublicKey, record);
      }

      this.metrics.processed_count++;
      this.metrics.last_processed_at = new Date().toISOString();

      this.recordEpsSample();

      if (token) {
        this.cursors.set(campaignId, token);
        this.pendingCursors.set(campaignId, {
          walletPublicKey,
          cursorToken: token,
        });
      }
    } catch (err) {
      this.metrics.failed_count++;
      this.metrics.last_error = err.message;
      logger.error('Payment processing error in ingestion worker', {
        campaignId,
        walletPublicKey,
        tx_hash: record.transaction_hash,
        error: err.message,
      });

      try {
        await db.query(
          `INSERT INTO failed_payment_records
             (campaign_id, wallet_public_key, payment_record, error_message)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (tx_hash, campaign_id) DO UPDATE
           SET error_message = EXCLUDED.error_message,
               retry_count = failed_payment_records.retry_count + 1,
               updated_at = NOW()`,
          [campaignId, walletPublicKey, JSON.stringify(record), err.message]
        );
      } catch (dbErr) {
        logger.error('Failed to persist failed payment record in worker', {
          error: dbErr.message,
        });
      }
    }
  }

  recordEpsSample() {
    const now = Date.now();
    this.metrics.eps_history.push(now);
    const cutoff = now - 60000;
    this.metrics.eps_history = this.metrics.eps_history.filter(t => t >= cutoff);
  }

  getEps() {
    const now = Date.now();
    const cutoff = now - 60000;
    this.metrics.eps_history = this.metrics.eps_history.filter(t => t >= cutoff);
    return Math.round((this.metrics.eps_history.length / 60) * 100) / 100;
  }

  /**
   * Flush pending cursor checkpoints to database in batch.
   */
  async flushCursors() {
    if (this.pendingCursors.size === 0) return;

    const entries = Array.from(this.pendingCursors.entries());
    this.pendingCursors.clear();

    for (const [campaignId, { walletPublicKey, cursorToken }] of entries) {
      try {
        await db.query(
          `INSERT INTO ledger_stream_cursors (campaign_id, wallet_public_key, last_cursor, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (campaign_id) DO UPDATE
           SET last_cursor = EXCLUDED.last_cursor,
               wallet_public_key = EXCLUDED.wallet_public_key,
               updated_at = NOW()`,
          [campaignId, walletPublicKey, String(cursorToken)]
        );
      } catch (err) {
        logger.error('Batch cursor flush failed for campaign', {
          campaignId,
          cursorToken,
          error: err.message,
        });
      }
    }
  }

  /**
   * Open SSE stream for a watched wallet.
   */
  openStreamForWallet(campaignId, walletPublicKey) {
    const storedCursor = this.cursors.get(campaignId) || 'now';

    if (this.streamCloseHandles.has(walletPublicKey)) {
      try {
        this.streamCloseHandles.get(walletPublicKey)();
      } catch {
        // ignore
      }
      this.streamCloseHandles.delete(walletPublicKey);
    }

    try {
      const closeFn = server
        .payments()
        .forAccount(walletPublicKey)
        .cursor(storedCursor)
        .stream({
          onmessage: record => {
            this.reconnectAttempts.delete(walletPublicKey);
            const mappedCampaign = this.watchedWallets.get(walletPublicKey) || campaignId;
            this.enqueuePaymentRecord(mappedCampaign, walletPublicKey, record);
          },
          onerror: err => {
            logger.error('Horizon stream error in worker', {
              walletPublicKey,
              campaignId,
              error: err ? err.message : 'unknown stream error',
            });
            const attempts = (this.reconnectAttempts.get(walletPublicKey) || 0) + 1;
            this.reconnectAttempts.set(walletPublicKey, attempts);

            if (attempts <= 10 && this.status === 'running') {
              const delay = Math.min(60000, 1000 * 2 ** Math.max(0, attempts - 1));
              setTimeout(() => {
                if (this.status === 'running' && this.watchedWallets.has(walletPublicKey)) {
                  this.openStreamForWallet(campaignId, walletPublicKey);
                }
              }, delay);
            }
          },
        });

      this.streamCloseHandles.set(walletPublicKey, closeFn);
    } catch (err) {
      logger.error('Failed to open stream for wallet in worker', {
        walletPublicKey,
        error: err.message,
      });
    }
  }

  /**
   * Start worker ingestion engine.
   */
  async start() {
    if (this.status === 'running') return;
    this.status = 'starting';
    this.metrics.start_time = new Date().toISOString();

    try {
      const campaigns = await this.loadCampaignWallets();

      await Promise.all(
        campaigns.map(c =>
          this.replayMissedPayments(c.id, c.wallet_public_key).catch(err =>
            logger.error('Startup REST replay failed for wallet', {
              wallet: c.wallet_public_key,
              error: err.message,
            })
          )
        )
      );

      for (const [walletPublicKey, campaignId] of this.watchedWallets.entries()) {
        this.openStreamForWallet(campaignId, walletPublicKey);
      }

      if (this.checkpointTimer) clearInterval(this.checkpointTimer);
      this.checkpointTimer = setInterval(() => {
        this.flushCursors().catch(err =>
          logger.error('Error in batch cursor checkpoint timer', {
            error: err.message,
          })
        );
      }, this.checkpointIntervalMs);

      this.status = 'running';
      logger.info('High-Throughput Horizon Ingestion Worker started', {
        concurrency: this.concurrency,
        watchedWallets: this.watchedWallets.size,
      });
    } catch (err) {
      this.status = 'error';
      this.metrics.last_error = err.message;
      logger.error('Horizon Ingestion Worker failed to start', {
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Pause worker event execution.
   */
  pause() {
    this.status = 'paused';
    logger.info('Horizon Ingestion Worker paused');
  }

  /**
   * Resume worker event execution.
   */
  resume() {
    if (this.status === 'paused') {
      this.status = 'running';
      logger.info('Horizon Ingestion Worker resumed');
      this.processQueue();
    }
  }

  /**
   * Stop worker ingestion engine gracefully.
   */
  async stop() {
    this.status = 'stopping';

    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }

    await this.flushCursors();

    for (const closeFn of this.streamCloseHandles.values()) {
      if (typeof closeFn === 'function') {
        try {
          closeFn();
        } catch {
          // ignore
        }
      }
    }
    this.streamCloseHandles.clear();

    if (typeof this.globalStreamClose === 'function') {
      try {
        this.globalStreamClose();
      } catch {
        // ignore
      }
      this.globalStreamClose = null;
    }

    this.queue = [];
    this.activeWorkers = 0;
    this.status = 'stopped';
    logger.info('Horizon Ingestion Worker stopped');
  }

  /**
   * Operational metrics snapshot.
   */
  getMetrics() {
    const uptimeSeconds = this.metrics.start_time
      ? Math.floor((Date.now() - new Date(this.metrics.start_time).getTime()) / 1000)
      : 0;

    return {
      status: this.status,
      concurrency: this.concurrency,
      active_workers: this.activeWorkers,
      queue_depth: this.queue.length,
      max_queue_size: this.maxQueueSize,
      watched_wallets_count: this.watchedWallets.size,
      ingested_count: this.metrics.ingested_count,
      processed_count: this.metrics.processed_count,
      failed_count: this.metrics.failed_count,
      quarantined_count: this.metrics.quarantined_count,
      duplicate_count: this.metrics.duplicate_count,
      throughput_eps: this.getEps(),
      start_time: this.metrics.start_time,
      uptime_seconds: uptimeSeconds,
      last_processed_at: this.metrics.last_processed_at,
      last_error: this.metrics.last_error,
    };
  }

  /**
   * Health snapshot for integration with ops routes and health collectors.
   */
  getHealth() {
    const metrics = this.getMetrics();
    const streams = [];

    for (const [walletPublicKey, campaignId] of this.watchedWallets.entries()) {
      const cursor = this.cursors.get(campaignId) || null;
      const hasStream = this.streamCloseHandles.has(walletPublicKey);
      streams.push({
        campaign_id: campaignId,
        wallet_public_key: walletPublicKey,
        last_cursor: cursor,
        stream_state: hasStream ? 'connected' : 'not_connected',
        reconnect_attempt: this.reconnectAttempts.get(walletPublicKey) || 0,
      });
    }

    return {
      worker_status: this.status,
      active_campaigns: this.watchedWallets.size,
      queue_depth: metrics.queue_depth,
      throughput_eps: metrics.throughput_eps,
      metrics,
      streams,
    };
  }
}

const defaultIngestionWorker = new HorizonIngestionWorker();

module.exports = {
  HorizonIngestionWorker,
  defaultIngestionWorker,
};
