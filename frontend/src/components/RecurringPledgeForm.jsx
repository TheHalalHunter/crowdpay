import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { getNetwork, signTransaction } from '@stellar/freighter-api';

const PERIOD_OPTIONS = [
  { months: 1, label: 'Monthly' },
  { months: 3, label: 'Quarterly' },
  { months: 6, label: 'Semi-annual' },
];

const MIN_PERIODS = 2;
const MAX_PERIODS = 24;
const PERIOD_DAYS = 30;

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function firstPaymentDate(periodMonths) {
  return formatDate(Date.now() + periodMonths * PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

function ConfirmLockModal({
  amountPerPeriod,
  asset,
  periodMonths,
  totalPeriods,
  totalCommitment,
  submitting,
  error,
  onConfirm,
  onClose,
}) {
  const periodLabel = PERIOD_OPTIONS.find((p) => p.months === periodMonths)?.label.toLowerCase();
  const modalRef = useRef(null);

  useEffect(() => {
    const trigger = document.activeElement;
    return () => {
      if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const initialFocusable = modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    initialFocusable[0]?.focus();

    function trapTab(e) {
      if (e.key !== 'Tab') return;
      const focusable = modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        e.preventDefault();
        if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!modal.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    modal.addEventListener('keydown', trapTab);
    return () => modal.removeEventListener('keydown', trapTab);
  }, []);

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={onClose} role="presentation">
      <div
        className="modal-shell"
        ref={modalRef}
        style={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-lock-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-lock-title" style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>
          Lock {totalCommitment} {asset} now?
        </h2>
        <p
          style={{
            margin: '0 0 1rem',
            color: 'var(--color-text-secondary)',
            fontSize: '0.88rem',
            lineHeight: 1.5,
          }}
        >
          Stellar has no recurring payments, so the whole commitment leaves your wallet immediately
          and is held in {totalPeriods} claimable balances on the ledger — one per period. CrowdPay
          releases each one to the campaign on its scheduled date.
        </p>
        <ul
          style={{
            margin: '0 0 1rem',
            paddingLeft: '1.1rem',
            color: 'var(--color-text-secondary)',
            fontSize: '0.85rem',
            lineHeight: 1.6,
          }}
        >
          <li>
            {amountPerPeriod} {asset} {periodLabel}, {totalPeriods} times
          </li>
          <li>First payment on {firstPaymentDate(periodMonths)}</li>
          <li>
            Cancelling stops any payment more than 7 days away; you reclaim those funds yourself 30
            days after their scheduled date
          </li>
        </ul>

        {error && (
          <p className="alert alert--error" style={{ marginBottom: '0.75rem' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            data-modal-close="true"
            style={{ fontSize: '0.85rem', padding: '0.4rem 1rem' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onConfirm}
            disabled={submitting}
            aria-busy={submitting}
            style={{ fontSize: '0.85rem', padding: '0.4rem 1rem' }}
          >
            {submitting ? 'Locking funds…' : 'Confirm & Lock Funds'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RecurringPledgeForm({ campaignId, asset, walletType, onSubscribed }) {
  const [open, setOpen] = useState(false);
  const [amountPerPeriod, setAmountPerPeriod] = useState('');
  const [periodMonths, setPeriodMonths] = useState(1);
  const [totalPeriods, setTotalPeriods] = useState(6);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [signing, setSigning] = useState(false);

  const amount = parseFloat(amountPerPeriod);
  const amountValid = Number.isFinite(amount) && amount > 0;
  const totalCommitment = amountValid ? Number((amount * totalPeriods).toFixed(7)) : 0;

  const isFreighter = walletType === 'freighter';

  async function confirmPledge() {
    setSubmitting(true);
    setError('');
    try {
      if (isFreighter) {
        await confirmPledgeFreighter();
      } else {
        const subscription = await api.createSubscription(campaignId, {
          amountPerPeriod: amount,
          asset,
          periodMonths,
          totalPeriods,
        });
        setCreated(subscription);
        setShowConfirm(false);
        setOpen(false);
        setAmountPerPeriod('');
        onSubscribed?.(subscription);
      }
    } catch (err) {
      setError(err.message || 'Could not start this recurring pledge');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmPledgeFreighter() {
    const prepared = await api.prepareSubscription(campaignId, {
      amountPerPeriod: amount,
      asset,
      periodMonths,
      totalPeriods,
    });

    const network = await getNetwork();
    if (network?.error) throw new Error('Could not read Freighter network');

    // Check if the transaction XDR is expired
    if (prepared.unsignedXdr.timeBounds?.maxTime) {
      const maxTime = Number(prepared.unsignedXdr.timeBounds.maxTime);
      if (Math.floor(Date.now() / 1000) > maxTime) {
        throw new Error('This transaction has expired. Please request a new quote.');
      }
    }

    const signed = await signTransaction(prepared.unsignedXdr, {
      networkPassphrase: network?.networkPassphrase,
      address: prepared.walletPublicKey,
    });
    if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
    if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

    const subscription = await api.submitSubscription(campaignId, {
      unsignedXdr: prepared.unsignedXdr,
      signedXdr: signed.signedTxXdr,
      amountPerPeriod: amount,
      asset,
      periodMonths,
      totalPeriods,
    });
    setCreated(subscription);
    } catch (err) {
      if (err?.message && err.message.includes('expired')) {
        setError('This transaction has expired. Please request a new quote.');
      } else if (err?.message && err.message.includes('network')) {
        setError('Network mismatch detected. Please switch your wallet to the correct network.');
      } else {
        setError(err.message || 'Freighter signing failed');
      }
    }
    setShowConfirm(false);
    setOpen(false);
    setAmountPerPeriod('');
    onSubscribed?.(subscription);
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <button
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => !prev);
          setCreated(null);
        }}
        style={{ width: '100%', padding: '0.6rem 1rem' }}
      >
        {open ? 'Hide monthly pledge' : 'Pledge Monthly'}
      </button>

      {created && !open && (
        <p className="alert alert--success" style={{ marginTop: '0.65rem', fontSize: '0.85rem' }}>
          Recurring pledge active — {created.totalCommitment} {asset} locked across{' '}
          {created.balanceIds.length} payments, first on {formatDate(created.firstPaymentDate)}.
        </p>
      )}

      {open && (
        <div
          style={{
            marginTop: '0.75rem',
            padding: '1rem',
            border: '1px solid var(--color-border)',
            borderRadius: '10px',
          }}
        >
          <label htmlFor="pledge-amount" style={styles.label}>
            Amount per period ({asset})
          </label>
          <input
            id="pledge-amount"
            type="number"
            min="0"
            step="0.0000001"
            value={amountPerPeriod}
            onChange={(e) => setAmountPerPeriod(e.target.value)}
            style={styles.input}
          />

          <fieldset style={{ border: 0, padding: 0, margin: '0.9rem 0 0' }}>
            <legend style={styles.label}>Frequency</legend>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.months}
                  type="button"
                  className={periodMonths === option.months ? 'btn-primary' : 'btn-secondary'}
                  aria-pressed={periodMonths === option.months}
                  onClick={() => setPeriodMonths(option.months)}
                  style={{ fontSize: '0.82rem', padding: '0.35rem 0.8rem' }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="pledge-periods" style={{ ...styles.label, marginTop: '0.9rem' }}>
            Number of periods: {totalPeriods}
          </label>
          <input
            id="pledge-periods"
            type="range"
            min={MIN_PERIODS}
            max={MAX_PERIODS}
            value={totalPeriods}
            onChange={(e) => setTotalPeriods(Number(e.target.value))}
            style={{ width: '100%' }}
          />

          <div
            style={{
              marginTop: '0.9rem',
              padding: '0.75rem',
              borderRadius: '8px',
              background: 'var(--color-surface, rgba(0,0,0,0.04))',
            }}
          >
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>
              Total commitment
            </div>
            <strong style={{ fontSize: '1.35rem' }}>
              {totalCommitment} {asset}
            </strong>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--color-text-secondary)',
                marginTop: '0.2rem',
              }}
            >
              First payment {firstPaymentDate(periodMonths)} · locked on Stellar up front
            </div>
          </div>

          {error && !showConfirm && (
            <p className="alert alert--error" style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
              {error}
            </p>
          )}

          <button
            type="button"
            className="btn-primary"
            disabled={!amountValid}
            onClick={() => {
              setError('');
              setShowConfirm(true);
            }}
            style={{ width: '100%', marginTop: '0.9rem', padding: '0.6rem 1rem' }}
          >
            Confirm &amp; Lock Funds
          </button>
        </div>
      )}

      {showConfirm && (
        <ConfirmLockModal
          amountPerPeriod={amount}
          asset={asset}
          periodMonths={periodMonths}
          totalPeriods={totalPeriods}
          totalCommitment={totalCommitment}
          submitting={submitting}
          error={error}
          onConfirm={confirmPledge}
          onClose={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

const styles = {
  label: {
    display: 'block',
    fontSize: '0.82rem',
    fontWeight: 600,
    marginBottom: '0.3rem',
  },
  input: {
    width: '100%',
    padding: '0.5rem',
    borderRadius: '8px',
    border: '1px solid var(--color-border)',
    fontSize: '0.9rem',
    boxSizing: 'border-box',
  },
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--color-bg)',
    borderRadius: '12px',
    padding: '1.5rem',
    maxWidth: '480px',
    width: '90%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
};
