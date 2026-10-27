/* eslint-disable react/prop-types -- Component has many props; prop-types not used in this codebase */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getNetwork,
  isConnected as isFreighterConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { getDeviceFingerprint } from '../lib/deviceFingerprint';
import { stellarExpertTxUrl } from '../config/stellar';
import KycPrompt from './KycPrompt';
import { useExchangeRate } from '../hooks/useExchangeRate';

const SEND_OPTIONS = [
  { value: 'XLM', label: 'XLM', hint: 'Native Stellar' },
  { value: 'USDC', label: 'USDC', hint: 'Stable dollar' },
];

function friendlyQuoteError(err) {
  if (err.status === 404) {
    return 'No conversion path is available for this pair right now. Try the campaign’s asset or a different amount.';
  }
  return err.message || 'Could not load a quote.';
}

/** Render normalized Stellar asset objects (or plain codes) as route labels (#688). */
function pathLabels(path) {
  if (!Array.isArray(path)) return [];
  return path.map((asset) =>
    typeof asset === 'string'
      ? asset
      : asset?.asset_type === 'native'
        ? 'XLM'
        : asset?.asset_code || asset?.asset_type || ''
  );
}

function routeLabel(p, sendAsset, destAsset) {
  const hops = pathLabels(p.path);
  const route = hops.length ? ` → ${hops.join(' → ')}` : '';
  return `${Number(p.source_amount).toLocaleString()} ${sendAsset}${route} → ${destAsset}`;
}

function friendlyContributeError(err) {
  if (err.status === 422) {
    return err.message || 'Conversion failed. Try another amount or asset.';
  }
  if (err.status === 404) {
    return 'Campaign not found or no longer active.';
  }
  if (err.status === 400) {
    return err.message || 'Check your amount and asset selection.';
  }
  return err.message || 'Payment could not be submitted. Try again.';
}

const FREIGHTER_TIMEOUT_MS = 60000;
const SIGNING_CANCELLED = 'SIGNING_CANCELLED';

// Freighter never rejects when its popup is dismissed or hangs, so every call
// that opens the extension is raced against a timeout and a manual cancel.
function withFreighterTimeout(promise, { signal, timeoutMessage }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new Error(SIGNING_CANCELLED));
    const timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), FREIGHTER_TIMEOUT_MS);

    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => finish(resolve, value),
      (err) => finish(reject, err)
    );
  });
}

function friendlyFreighterError(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  if (typeof err.error === 'string') return err.error;
  if (err.error && typeof err.error.message === 'string') return err.error.message;
  return fallback;
}

function matchTier(tiers, amount) {
  if (!tiers || !Array.isArray(tiers) || !amount) return null;
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount)) return null;

  const eligible = tiers.filter((t) => numAmount >= parseFloat(t.min_amount) && !t.sold_out);

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => parseFloat(b.min_amount) - parseFloat(a.min_amount));
  return eligible[0];
}

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `contrib-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ContributeModal({
  campaign,
  onClose,
  onSuccess,
  guestFreighterMode = false,
  tiers = [],
  referralCode = null,
  initialAmount = '',
}) {
  const { user, token, updateUser } = useAuth();
  const [amount, setAmount] = useState(initialAmount);
  const { formatNaira } = useExchangeRate(campaign.asset_type || 'USDC');
  const nairaAmount = formatNaira(amount);
  const minNaira = campaign.min_contribution ? formatNaira(campaign.min_contribution) : null;
  const maxNaira = campaign.max_contribution ? formatNaira(campaign.max_contribution) : null;
  const [sendAsset, setSendAsset] = useState(campaign.asset_type);
  const [paymentMethod, setPaymentMethod] = useState(
    guestFreighterMode ? 'freighter' : 'custodial'
  );
  const [anchorInfo, setAnchorInfo] = useState({ anchors: [] });
  const [selectedAnchorId, setSelectedAnchorId] = useState('');
  const [anchorSession, setAnchorSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Submitting…');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quote, setQuote] = useState(null);
  const [rankedPaths, setRankedPaths] = useState([]);
  const [selectedPathIndex, setSelectedPathIndex] = useState(0);
  const [previewToken, setPreviewToken] = useState(null);
  const [phase, setPhase] = useState('form');
  const [result, setResult] = useState(null);
  const [rebuildRequested, setRebuildRequested] = useState(false);
  const [feeBps, setFeeBps] = useState(0);

  useEffect(() => {
    api
      .getPlatformConfig()
      .then((cfg) => setFeeBps(cfg.platform_fee_bps || 0))
      .catch(() => {});
  }, []);
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [freighterChecked, setFreighterChecked] = useState(false);
  const [existingContributions, setExistingContributions] = useState([]);
  const [displayName, setDisplayName] = useState('');
  const [giftEnabled, setGiftEnabled] = useState(false);
  const [giftRecipientName, setGiftRecipientName] = useState('');
  const [giftRecipientEmail, setGiftRecipientEmail] = useState('');
  const [giftMessage, setGiftMessage] = useState('');
  const anchorPopupRef = useRef(null);
  const submitLockRef = useRef(false);
  const activeSubmissionKeyRef = useRef(null);
  const signingAbortRef = useRef(null);
  const [signingInFlight, setSigningInFlight] = useState(false);

  const modalRef = useRef(null);

  const selectedAnchor =
    anchorInfo.anchors.find((anchor) => anchor.id === selectedAnchorId) || null;
  const effectiveSendAsset =
    paymentMethod === 'anchor' ? selectedAnchor?.asset?.code || campaign.asset_type : sendAsset;
  const isPathPayment = effectiveSendAsset !== campaign.asset_type;
  const destAmount = amount.trim();
  const matchedTier = matchTier(tiers, destAmount);
  const [unlockedTier, setUnlockedTier] = useState(null);

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';
  const needsKyc = kycRequired && user?.kyc_status !== 'verified';

  const handleCancelSigning = () => {
    signingAbortRef.current?.abort();
  };

  const handleClose = () => {
    signingAbortRef.current?.abort();
    if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
      anchorPopupRef.current.close();
    }
    setPhase('form');
    setError('');
    setQuoteError('');
    setAmount('');
    onClose();
  };

  // Fetch anchor info and existing contributions on mount
  useEffect(() => {
    api
      .getAnchorInfo()
      .then(setAnchorInfo)
      .catch(() => {});
    api
      .getContributions(campaign.id, { limit: 100 })
      .then((d) => setExistingContributions(d.contributions || []))
      .catch(() => {});
  }, [campaign.id]);

  // Check Freighter availability
  useEffect(() => {
    isFreighterConnected()
      .then((res) => {
        const connected = res?.isConnected ?? res;
        setFreighterAvailable(!!connected);
        setFreighterChecked(true);
      })
      .catch(() => setFreighterChecked(true));
  }, []);

  const fetchQuote = useCallback(async () => {
    if (!isPathPayment || !effectiveSendAsset || !destAmount || Number(destAmount) <= 0) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const q = await api.quoteContribution(campaign.id, {
        send_asset: effectiveSendAsset,
        dest_amount: destAmount,
      });
      if (q.direct) {
        setQuote(null);
        setQuoteError('');
        return;
      }
      const paths = Array.isArray(q.ranked_paths) ? q.ranked_paths : [];
      setRankedPaths(paths);
      setPreviewToken(q.preview_token || null);
      setSelectedPathIndex(0);
      if (paths.length) {
        const best = paths[0];
        setQuote({ ...q, ...best, preview_token: q.preview_token });
      } else {
        setQuote({ ...q, preview_token: q.preview_token });
      }
    } catch (err) {
      setQuote(null);
      setQuoteError(friendlyQuoteError(err));
    } finally {
      setQuoteLoading(false);
    }
  }, [campaign.id, isPathPayment, destAmount, effectiveSendAsset]);

  const handleSelectPath = (index) => {
    const selected = rankedPaths[index];
    if (!selected) return;
    setSelectedPathIndex(index);
    if (quote) {
      setQuote({
        ...quote,
        source_amount: selected.source_amount,
        max_send_amount: selected.max_send_amount,
        path: selected.path,
      });
    }
  };

  useEffect(() => {
    if (!isPathPayment) {
      setQuote(null);
      setQuoteError('');
      return;
    }
    const t = setTimeout(() => {
      fetchQuote();
    }, 450);
    return () => clearTimeout(t);
  }, [fetchQuote, isPathPayment]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => () => signingAbortRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const connection = await isFreighterConnected();
        if (active) {
          setFreighterAvailable(Boolean(connection?.isConnected));
        }
      } catch {
        if (active) {
          setFreighterAvailable(false);
        }
      } finally {
        if (active) {
          setFreighterChecked(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api
      .getAnchorInfo()
      .then((info) => {
        if (!active) return;
        setAnchorInfo(info || { anchors: [] });
        const firstAvailable = (info?.anchors || []).find((anchor) => anchor.available);
        if (firstAvailable) {
          setSelectedAnchorId(firstAvailable.id);
        }
      })
      .catch(() => {
        if (active) {
          setAnchorInfo({ anchors: [] });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'anchor' || !anchorSession?.id) return undefined;
    let stopped = false;

    const closePopup = () => {
      if (anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
    };

    const poll = async () => {
      try {
        const next = await api.getAnchorDepositStatus(anchorSession.id, token);
        if (stopped) return;
        setAnchorSession(next);
        if (next.contribution_tx_hash) {
          setResult({
            tx_hash: next.contribution_tx_hash,
            conversion_quote: next.conversion_quote,
            anchor_transaction_id: next.anchor_transaction_id,
            anchor_id: next.anchor_id,
          });
          setPhase('success');
          closePopup();
          onSuccess();
          return;
        }
        if (next.status === 'failed') {
          setError(next.last_error || 'The anchor deposit could not be completed.');
          setPhase('form');
          closePopup();
        }
      } catch (err) {
        if (!stopped) {
          setError(err.message || 'Could not refresh the anchor deposit status.');
        }
      }
    };

    poll();
    const intervalId = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [anchorSession?.id, onSuccess, phase, token]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    modal.addEventListener('keydown', trapTab);
    return () => modal.removeEventListener('keydown', trapTab);
  }, [phase]);

  // Attribution travels as a query parameter so it lands in the Stellar memo (#675)
  const referralQuery = referralCode ? { query: { ref: referralCode } } : {};

  async function submitWithCustodial() {
    setLoadingLabel('Submitting with CrowdPay wallet…');
    const device_fingerprint = await getDeviceFingerprint();
    return api.contribute(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        send_asset: sendAsset,
        display_name: displayName.trim() || undefined,
        ...(giftEnabled
          ? {
              gift: {
                recipient_name: giftRecipientName.trim(),
                recipient_email: giftRecipientEmail.trim(),
                message: giftMessage.trim() || undefined,
              },
            }
          : {}),
        device_fingerprint: device_fingerprint || undefined,
        idempotency_key: activeSubmissionKeyRef.current,
        ...(isPathPayment && previewToken
          ? { preview_token: previewToken, selected_path_index: selectedPathIndex }
          : {}),
      },
      referralQuery
    );
  }

  async function submitWithFreighter() {
    const abortController = new AbortController();
    signingAbortRef.current = abortController;
    setSigningInFlight(true);
    try {
      return await runFreighterFlow(abortController.signal);
    } finally {
      setSigningInFlight(false);
      signingAbortRef.current = null;
    }
  }

  async function runFreighterFlow(signal) {
    setLoadingLabel('Connecting to Freighter…');
    const access = await withFreighterTimeout(requestAccess(), {
      signal,
      timeoutMessage:
        'Freighter did not respond within 60 seconds. Open the extension and try again.',
    });
    if (access?.error) {
      throw new Error(friendlyFreighterError(access.error, 'Could not connect to Freighter.'));
    }
    const signerAddress = access?.address;
    if (!signerAddress) {
      throw new Error('Freighter did not return a Stellar account.');
    }

    setLoadingLabel('Preparing transaction…');
    const device_fingerprint = await getDeviceFingerprint();
    const prepared = await api.prepareContribution(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        send_asset: sendAsset,
        sender_public_key: signerAddress,
        display_name: displayName.trim() || undefined,
        device_fingerprint: device_fingerprint || undefined,
        idempotency_key: activeSubmissionKeyRef.current,
        ...(isPathPayment && previewToken
          ? { preview_token: previewToken, selected_path_index: selectedPathIndex }
          : {}),
      },
      referralQuery
    );

    setLoadingLabel('Checking Freighter network…');
    const network = await withFreighterTimeout(getNetwork(), {
      signal,
      timeoutMessage: 'Freighter did not report its network within 60 seconds. Try again.',
    });
    if (network?.error) {
      throw new Error(friendlyFreighterError(network.error, 'Could not read Freighter network.'));
    }
    if (network?.networkPassphrase !== prepared.network_passphrase) {
      const current = network?.network || 'another network';
      throw new Error(
        `Freighter is connected to the ${current} network. This campaign is configured for the ${prepared.network_name} network. ` +
          'Switch your wallet network and try again, or use the rebuild path below to generate a new quote for the correct network.'
      );
    }

    // Check if the prepared transaction is expired
    if (prepared.timeBounds && new Date(prepared.timeBounds.maxTime * 1000) < new Date()) {
      throw new Error(
        'This transaction has expired. Please <button className="link-btn" onClick={() => setPhase("rebuild")}>rebuild the quote</button> ' +
          'or refresh the page to generate a new quote for the current network.'
      );
    }

    setLoadingLabel('Waiting for signature…');
    const signed = await withFreighterTimeout(
      signTransaction(prepared.unsigned_xdr, {
        networkPassphrase: prepared.network_passphrase,
        address: signerAddress,
      }),
      {
        signal,
        timeoutMessage:
          'Freighter did not return a signature within 60 seconds. Approve the request in the extension, or cancel and try again.',
      }
    );
    if (signed?.error) {
      throw new Error(
        friendlyFreighterError(signed.error, 'Freighter could not sign this transaction.')
      );
    }
    if (!signed?.signedTxXdr) {
      throw new Error('Freighter did not return a signed transaction.');
    }

    setLoadingLabel('Submitting signed transaction…');
    return api.submitSignedContribution({
      prepare_token: prepared.prepare_token,
      signed_xdr: signed.signedTxXdr,
      idempotency_key: activeSubmissionKeyRef.current,
    });
  }

  async function submitWithAnchor() {
    if (!selectedAnchorId) {
      throw new Error('No deposit anchor is available right now.');
    }

    const popup = window.open('', 'crowdpay-anchor-deposit', 'popup,width=520,height=780');
    anchorPopupRef.current = popup;

    setLoadingLabel('Preparing deposit flow…');
    const session = await api.startAnchorDeposit(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        anchor_id: selectedAnchorId,
        idempotency_key: activeSubmissionKeyRef.current,
      },
      token
    );

    if (popup && !popup.closed) {
      popup.location.href = session.interactive_url;
    } else {
      window.open(session.interactive_url, '_blank', 'noopener,noreferrer');
    }

    setAnchorSession(session);
    setPhase('anchor');
    return api.contribute(
      {
        campaign_id: campaign.id,
        amount: destAmount,
        send_asset: effectiveSendAsset,
        display_name: displayName || undefined,
        ...(giftEnabled
          ? {
              gift: {
                recipient_name: giftRecipientName.trim(),
                recipient_email: giftRecipientEmail.trim(),
                message: giftMessage.trim() || undefined,
              },
            }
          : {}),
        idempotency_key: activeSubmissionKeyRef.current,
      },
      referralQuery
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitLockRef.current) return;
    if (quoteLoading) return;
    if (isPathPayment && (!quote || !!quoteError)) {
      setError('A valid quote is required before submitting.');
      return;
    }
    if (!destAmount || Number(destAmount) <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    const amountNum = Number(destAmount);
    if (campaign.min_contribution && amountNum < Number(campaign.min_contribution)) {
      setError(`Minimum contribution is ${campaign.min_contribution} ${campaign.asset_type}`);
      return;
    }
    if (campaign.max_contribution && amountNum > Number(campaign.max_contribution)) {
      setError(`Maximum contribution is ${campaign.max_contribution} ${campaign.asset_type}`);
      return;
    }
    if (campaign.max_per_user) {
      const existingSum = user?.wallet_public_key
        ? existingContributions
            .filter((c) => c.sender_public_key === user.wallet_public_key)
            .reduce((sum, c) => sum + Number(c.amount), 0)
        : 0;
      if (existingSum + amountNum > Number(campaign.max_per_user)) {
        setError(
          `You have already contributed ${existingSum} ${campaign.asset_type}. The per-contributor limit is ${campaign.max_per_user}.`
        );
        return;
      }
    }

    submitLockRef.current = true;
    activeSubmissionKeyRef.current = createIdempotencyKey();
    setLoading(true);
    setLoadingLabel('Submitting...');
    setError('');
    setUnlockedTier(matchedTier);
    try {
      const data =
        paymentMethod === 'anchor'
          ? await submitWithAnchor()
          : paymentMethod === 'freighter'
            ? await submitWithFreighter()
            : await submitWithCustodial();
      if (paymentMethod === 'anchor') return;

      setResult(data);
      setPhase('confirming');
      setLoadingLabel('Confirming on Stellar...');

      // Poll finalization endpoint until status is 'finalized' or 'failed'
      const pollFinalization = async (txHash, maxAttempts = 15) => {
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const finalizationResult = await api.getContributionFinalization(txHash, token);
            if (finalizationResult.finalization_status === 'finalized') {
              setPhase('success');
              onSuccess();
              return;
            }
            if (finalizationResult.finalization_status === 'failed') {
              setPhase('success');
              setError('The contribution transaction failed on Stellar. Please try again.');
              onSuccess();
              return;
            }
          } catch (_err) {
            // eslint-disable-line no-unused-vars -- intentionally unused, just continue polling
            // Keep polling on error
          }
        }
        // Timeout: show success screen with timeout message but allow user to view on Stellar Expert
        setPhase('success');
        setError(null);
        onSuccess();
      };

      pollFinalization(data.tx_hash);
    } catch (err) {
      if (paymentMethod === 'anchor' && anchorPopupRef.current && !anchorPopupRef.current.closed) {
        anchorPopupRef.current.close();
      }
      if (err?.message === SIGNING_CANCELLED) {
        setError('Signing cancelled. Nothing was sent — you can start the payment again.');
      } else if (err?.message && err.message.includes('expired')) {
        setError('This transaction has expired. Click "Rebuild quote" to generate a new quote, or refresh the page.');
        setRebuildRequested(true);
      } else if (err?.message && err.message.includes('network')) {
        setError('Network mismatch detected. Please switch your wallet to the correct network and try again.');
      } else {
        setError(
          paymentMethod === 'freighter'
            ? friendlyFreighterError(err, 'Freighter payment could not be submitted. Try again.')
            : friendlyContributeError(err)
        );
      }
    } finally {
      submitLockRef.current = false;
      activeSubmissionKeyRef.current = null;
      setLoading(false);
      setLoadingLabel('Submitting...');
    }
  }
  return (
    <div className="modal-overlay" style={styles.overlay} onClick={handleClose} role="presentation">
      <div
        className="modal-shell"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contribute-title"
        onClick={(e) => e.stopPropagation()}
      >
        {needsKyc ? (
          <>
            <h2 id="contribute-title" style={styles.title}>
              Identity verification required
            </h2>
            <KycPrompt onUserUpdate={updateUser} title="Verify your identity before contributing" />
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: '1rem', width: '100%' }}
              onClick={handleClose}
            >
              Close
            </button>
          </>
        ) : phase === 'form' ? (
          <>
            <h2 id="contribute-title" style={styles.title}>
              Support this campaign
            </h2>
            <p style={styles.subtitle}>
              Goal currency: <strong>{campaign.asset_type}</strong>. You choose what you send; the
              campaign receives the amount below in <strong>{campaign.asset_type}</strong>.
            </p>

            <form noValidate onSubmit={handleSubmit}>
              <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                  Payment method
                </legend>
                <div
                  className="asset-picker"
                  role="radiogroup"
                  aria-label="Contribution payment method"
                >
                  {!guestFreighterMode && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'custodial' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="custodial"
                        checked={paymentMethod === 'custodial'}
                        onChange={() => setPaymentMethod('custodial')}
                      />
                      <div className="asset-picker__code">CrowdPay Balance</div>
                      <div className="asset-picker__hint">Uses your existing CrowdPay balance</div>
                    </label>
                  )}
                  {anchorInfo.anchors.some((anchor) => anchor.available) && (
                    <label
                      className={`asset-picker__option${paymentMethod === 'anchor' ? ' asset-picker__option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value="anchor"
                        checked={paymentMethod === 'anchor'}
                        onChange={() => setPaymentMethod('anchor')}
                      />
                      <div className="asset-picker__code">Bank or card</div>
                      <div className="asset-picker__hint">
                        Pay from your bank or card — we handle the rest automatically
                      </div>
                    </label>
                  )}
                  <label
                    className={`asset-picker__option${paymentMethod === 'freighter' ? ' asset-picker__option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="payment_method"
                      value="freighter"
                      checked={paymentMethod === 'freighter'}
                      onChange={() => setPaymentMethod('freighter')}
                    />
                    <div className="asset-picker__code">My own wallet (advanced)</div>
                    <div className="asset-picker__hint">
                      {freighterAvailable
                        ? 'Connect a wallet you already control; you approve the payment yourself'
                        : 'Requires a browser wallet extension — see alternatives below'}
                    </div>
                  </label>
                </div>
                {freighterChecked &&
                  !freighterAvailable &&
                  (paymentMethod === 'freighter' || guestFreighterMode) && (
                    <span id="contrib-wallet-help" style={styles.help}>
                      No wallet extension detected.{' '}
                      <a
                        href="https://www.freighter.app/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Install Freighter
                      </a>{' '}
                      to pay from a wallet you control.
                    </span>
                  )}
              </fieldset>

              {paymentMethod === 'anchor' ? (
                <>
                  <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                    <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                      Deposit partner
                    </legend>
                    <div className="asset-picker" role="radiogroup" aria-label="Anchor selection">
                      {anchorInfo.anchors
                        .filter((anchor) => anchor.available)
                        .map((anchor) => (
                          <label
                            key={anchor.id}
                            className={`asset-picker__option${selectedAnchorId === anchor.id ? ' asset-picker__option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="anchor_id"
                              value={anchor.id}
                              checked={selectedAnchorId === anchor.id}
                              onChange={() => setSelectedAnchorId(anchor.id)}
                            />
                            <div className="asset-picker__code">{anchor.name}</div>
                            <div className="asset-picker__hint">
                              Deposit asset: {anchor.asset.code} · {anchor.environment}
                            </div>
                          </label>
                        ))}
                    </div>
                  </fieldset>
                  {selectedAnchor && (
                    <div
                      className="alert alert--info"
                      style={{ marginBottom: '1rem' }}
                      role="status"
                    >
                      <strong>{selectedAnchor.name}.</strong> We&apos;ll open a secure identity and
                      payment window. Once your payment clears, your contribution is submitted
                      automatically — no further steps needed.
                    </div>
                  )}
                </>
              ) : (
                <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                  <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                    Pay with
                  </legend>
                  <div className="asset-picker" role="radiogroup" aria-label="Asset to send">
                    {SEND_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className={`asset-picker__option${sendAsset === opt.value ? ' asset-picker__option--selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="send_asset"
                          value={opt.value}
                          checked={sendAsset === opt.value}
                          onChange={() => setSendAsset(opt.value)}
                        />
                        <div className="asset-picker__code">{opt.label}</div>
                        <div className="asset-picker__hint">{opt.hint}</div>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="form-stack" style={{ marginBottom: '0.25rem' }}>
                <label className="label-strong" htmlFor="contrib-amount">
                  Amount campaign receives ({campaign.asset_type})
                </label>
                <input
                  id="contrib-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.0000001"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby="contrib-amount-help"
                />
                {nairaAmount && (
                  <div
                    className="contrib-naira-approx"
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--color-text-secondary)',
                      marginTop: '0.35rem',
                      fontWeight: 500,
                    }}
                    aria-label={`approximate naira value: ₦${nairaAmount}`}
                  >
                    ≈ ₦{nairaAmount} (approx.)
                  </div>
                )}
                <span id="contrib-amount-help" style={styles.help}>
                  <span style={{ display: 'block', marginBottom: '0.25rem' }}>
                    This is the credited amount toward the campaign goal, in {campaign.asset_type}.
                  </span>
                  {(campaign.min_contribution ||
                    campaign.max_contribution ||
                    campaign.max_per_user) && (
                    <span
                      style={{
                        display: 'block',
                        marginTop: '0.35rem',
                        borderTop: '1px dashed var(--color-border-lighter)',
                        paddingTop: '0.35rem',
                      }}
                    >
                      <strong>Limits for this campaign:</strong>
                      <ul
                        style={{
                          margin: '0.25rem 0 0',
                          paddingLeft: '1rem',
                          listStyleType: 'disc',
                        }}
                      >
                        {campaign.min_contribution && (
                          <li>
                            Minimum per contribution:{' '}
                            {Number(campaign.min_contribution).toLocaleString()}{' '}
                            {campaign.asset_type}
                            {minNaira && ` (≈ ₦${minNaira} approx.)`}
                          </li>
                        )}
                        {campaign.max_contribution && (
                          <li>
                            Maximum per contribution:{' '}
                            {Number(campaign.max_contribution).toLocaleString()}{' '}
                            {campaign.asset_type}
                            {maxNaira && ` (≈ ₦${maxNaira} approx.)`}
                          </li>
                        )}
                        {campaign.max_per_user &&
                          (() => {
                            const existingSum = user?.wallet_public_key
                              ? existingContributions
                                  .filter((c) => c.sender_public_key === user.wallet_public_key)
                                  .reduce((sum, c) => sum + Number(c.amount), 0)
                              : 0;
                            const remaining = Math.max(
                              0,
                              Number(campaign.max_per_user) - existingSum
                            );
                            return (
                              <li>
                                Per-contributor limit:{' '}
                                {Number(campaign.max_per_user).toLocaleString()}{' '}
                                {campaign.asset_type}
                                {existingSum > 0 &&
                                  ` (You have contributed ${existingSum.toLocaleString()} ${campaign.asset_type}; ${remaining.toLocaleString()} remaining)`}
                              </li>
                            );
                          })()}
                      </ul>
                    </span>
                  )}
                </span>
              </div>

              {tiers.length > 0 &&
                destAmount &&
                Number(destAmount) > 0 &&
                (matchedTier ? (
                  <div
                    className="alert alert--success"
                    style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
                    role="status"
                  >
                    <strong>Unlocks tier:</strong> {matchedTier.title} (from{' '}
                    {Number(matchedTier.min_amount).toLocaleString()} {campaign.asset_type})
                  </div>
                ) : (
                  <div
                    className="alert alert--info"
                    style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
                    role="status"
                  >
                    This amount does not yet reach a reward tier.
                  </div>
                ))}

              <div className="form-stack" style={{ marginBottom: '1rem' }}>
                <label className="label-strong" htmlFor="contrib-display-name">
                  Display name{' '}
                  <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>
                    (optional)
                  </span>
                </label>
                <input
                  id="contrib-display-name"
                  placeholder="e.g. Satoshi"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={50}
                />
                <span style={styles.help}>
                  Visible on the campaign’s backer wall. Leave blank to contribute anonymously.
                </span>
              </div>

              {paymentMethod !== 'freighter' && (
                <fieldset className="form-stack" style={{ marginBottom: '1rem' }}>
                  <legend className="label-strong">Gift this contribution</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={giftEnabled}
                      onChange={(event) => setGiftEnabled(event.target.checked)}
                    />{' '}
                    Notify someone that you contributed in their honor
                  </label>
                  {giftEnabled && (
                    <>
                      <label htmlFor="gift-recipient-name">Recipient name</label>
                      <input
                        id="gift-recipient-name"
                        value={giftRecipientName}
                        onChange={(event) => setGiftRecipientName(event.target.value)}
                        maxLength={100}
                        required
                      />
                      <label htmlFor="gift-recipient-email">Recipient email</label>
                      <input
                        id="gift-recipient-email"
                        type="email"
                        value={giftRecipientEmail}
                        onChange={(event) => setGiftRecipientEmail(event.target.value)}
                        maxLength={254}
                        required
                      />
                      <label htmlFor="gift-message">Message (optional)</label>
                      <textarea
                        id="gift-message"
                        value={giftMessage}
                        onChange={(event) => setGiftMessage(event.target.value)}
                        maxLength={280}
                      />
                      <span style={styles.help}>
                        The recipient is emailed only after the contribution is confirmed on
                        Stellar.
                      </span>
                    </>
                  )}
                </fieldset>
              )}

              {isPathPayment && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>Automatic conversion.</strong> We&apos;ll convert your{' '}
                  {effectiveSendAsset} to {campaign.asset_type} when you confirm. Fees are minimal.
                </div>
              )}

              {paymentMethod === 'freighter' && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>You stay in control.</strong> We&apos;ll prepare the payment, your wallet
                  will ask you to approve it, and only your approval comes back to us — we never see
                  your keys.
                </div>
              )}

              {paymentMethod === 'anchor' && selectedAnchor && (
                <div className="alert alert--info" style={{ marginTop: '0.85rem' }} role="status">
                  <strong>{selectedAnchor.name}.</strong> Your bank or card payment is verified,
                  then your contribution is submitted for you automatically.
                </div>
              )}

              {isPathPayment && destAmount && Number(destAmount) > 0 && (
                <div style={{ marginTop: '0.85rem', minHeight: '3.5rem' }}>
                  {quoteLoading && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                      Fetching live quote…
                    </p>
                  )}
                  {!quoteLoading && quote && (
                    <div className="alert alert--success" role="status">
                      <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
                        Estimated from your wallet
                      </div>
                      <div style={{ fontSize: '0.875rem', lineHeight: 1.45 }}>
                        Up to <strong>{quote.max_send_amount}</strong> {effectiveSendAsset}{' '}
                        (includes a small slippage buffer).
                        {pathLabels(quote.path).length > 0 && (
                          <>
                            {' '}
                            Route: {effectiveSendAsset} → {pathLabels(quote.path).join(' → ')} →{' '}
                            {campaign.asset_type}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {!quoteLoading && quote && rankedPaths.length > 1 && (
                    <div className="form-stack" style={{ marginTop: '0.5rem' }}>
                      <label
                        className="label-strong"
                        htmlFor="contrib-path-select"
                        style={{ display: 'block', marginBottom: '0.3rem' }}
                      >
                        Conversion route
                      </label>
                      <select
                        id="contrib-path-select"
                        value={selectedPathIndex}
                        onChange={(e) => handleSelectPath(Number(e.target.value))}
                        style={{ width: '100%' }}
                      >
                        {rankedPaths.map((p) => (
                          <option key={p.index} value={p.index}>
                            {routeLabel(p, effectiveSendAsset, campaign.asset_type)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {!quoteLoading && quoteError && (
                    <p className="alert alert--error" role="alert">
                      {quoteError}
                    </p>
                  )}
                </div>
              )}

              {feeBps > 0 && destAmount && Number(destAmount) > 0 && (
                <div
                  className="alert alert--info"
                  style={{ marginTop: '0.85rem', fontSize: '0.875rem' }}
                  role="status"
                >
                  {(() => {
                    const feeAmt = ((Number(destAmount) * feeBps) / 10000).toFixed(7);
                    const netAmt = (Number(destAmount) - Number(feeAmt)).toFixed(7);
                    return (
                      <>
                        <strong>Platform fee:</strong> {feeBps / 100}% = {feeAmt}{' '}
                        {campaign.asset_type} — campaign receives{' '}
                        <strong>
                          {netAmt} {campaign.asset_type}
                        </strong>
                      </>
                    );
                  })()}
                </div>
              )}

              {error && (
                <p className="alert alert--error" style={{ marginTop: '0.85rem' }} role="alert">
                  {error}
                </p>
              )}
              {rebuildRequested && (
                <div style={{ marginTop: '0.85rem', minHeight: '3.5rem' }}>
                  <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                    Enter the contribution amount to rebuild the quote for the correct network.
                  </p>
                  <input
                    id="contrib-amount"
                    type="number"
                    inputMode="decimal"
                    min="0.0000001"
                    step="any"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ marginTop: '0.5rem' }}
                    onClick={async () => {
                      setRebuildRequested(false);
                      setPhase('form');
                      fetchQuote();
                    }}
                  >
                    Rebuild quote
                  </button>
                </div>
              )}

              <div style={styles.actions}>
                {signingInFlight ? (
                  <button type="button" className="btn-secondary" onClick={handleCancelSigning}>
                    Cancel signing
                  </button>
                ) : (
                  <button type="button" className="btn-secondary" onClick={handleClose}>
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={loading || quoteLoading || (isPathPayment && (!!quoteError || !quote))}
                  aria-busy={loading ? 'true' : 'false'}
                >
                  {loading ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: '0.95rem',
                          height: '0.95rem',
                          border: '2px solid rgba(255, 255, 255, 0.35)',
                          borderTopColor: '#fff',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite',
                          flexShrink: 0,
                        }}
                      />
                      <span>{loadingLabel}</span>
                    </span>
                  ) : quoteLoading ? (
                    'Loading quote…'
                  ) : paymentMethod === 'anchor' ? (
                    'Open deposit flow'
                  ) : paymentMethod === 'freighter' ? (
                    'Review in Freighter'
                  ) : (
                    'Confirm payment'
                  )}
                </button>
              </div>
            </form>
          </>
        ) : phase === 'anchor' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Complete your deposit
            </h2>
            <p className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
              Finish the hosted deposit flow in the popup window. CrowdPay is polling the anchor and
              will submit the campaign contribution automatically when the funds arrive.
            </p>
            {anchorSession?.anchor_transaction_id && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                <strong>Anchor transaction:</strong> {anchorSession.anchor_transaction_id}
              </p>
            )}
            {anchorSession?.conversion_quote && (
              <div
                className="alert alert--success"
                style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
              >
                <strong>Planned contribution:</strong> up to{' '}
                {anchorSession.conversion_quote.max_send_amount}{' '}
                {anchorSession.conversion_quote.send_asset} will be used so the campaign receives{' '}
                {anchorSession.conversion_quote.campaign_amount}{' '}
                {anchorSession.conversion_quote.campaign_asset}.
              </div>
            )}
            {anchorSession?.interactive_url && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginBottom: '0.75rem' }}
                onClick={() =>
                  window.open(anchorSession.interactive_url, '_blank', 'noopener,noreferrer')
                }
              >
                Reopen deposit window
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={handleClose}
            >
              Close
            </button>
          </div>
        ) : phase === 'confirming' ? (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Confirming your payment…
            </h2>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  border: '4px solid var(--color-border-lighter)',
                  borderTop: '4px solid var(--color-accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  margin: '0 auto',
                  marginBottom: '1rem',
                }}
              />
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.95rem' }}>
                Your payment was submitted and is being confirmed, which usually takes just a few
                seconds.
              </p>
            </div>
            {result?.tx_hash && (
              <details style={{ textAlign: 'center', marginBottom: '1rem' }}>
                <summary
                  style={{
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-hint)',
                    display: 'inline-block',
                  }}
                >
                  Technical details
                </summary>
                <p style={{ fontSize: '0.875rem', marginTop: '0.5rem', wordBreak: 'break-all' }}>
                  <a
                    href={stellarExpertTxUrl(result.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                  >
                    View transaction on Stellar Expert
                  </a>
                </p>
              </details>
            )}
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        ) : (
          <div>
            <h2 id="contribute-title" style={styles.title}>
              Payment submitted
            </h2>
            <p className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
              Your contribution is on its way. It usually confirms in just a few seconds.
            </p>
            {unlockedTier && (
              <p
                className="alert alert--success"
                style={{ marginBottom: '1rem', fontSize: '0.9rem' }}
                role="status"
              >
                🎉 {"You've"} unlocked: <strong>{unlockedTier.title}</strong>
              </p>
            )}
            {result?.nft_reward && (
              <p
                className="alert alert--info"
                style={{ marginBottom: '1rem', fontSize: '0.9rem' }}
                role="status"
              >
                NFT reward record is being prepared for this contribution. Its status will appear in
                your profile once available.
              </p>
            )}
            {(result?.tx_hash || result?.conversion_quote || result?.anchor_transaction_id) && (
              <details style={{ marginBottom: '1rem' }}>
                <summary
                  style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}
                >
                  Technical details
                </summary>
                <div style={{ marginTop: '0.6rem' }}>
                  {result?.tx_hash && (
                    <p
                      style={{
                        fontSize: '0.875rem',
                        marginBottom: '0.5rem',
                        wordBreak: 'break-all',
                      }}
                    >
                      <strong>Transaction</strong>{' '}
                      <a
                        href={stellarExpertTxUrl(result.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                      >
                        View on Stellar Expert
                      </a>
                    </p>
                  )}
                  {result?.conversion_quote && (
                    <div
                      className="alert alert--info"
                      style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}
                    >
                      <strong>Conversion summary:</strong> up to{' '}
                      {result.conversion_quote.max_send_amount} {result.conversion_quote.send_asset}{' '}
                      authorized for {result.conversion_quote.campaign_amount}{' '}
                      {result.conversion_quote.campaign_asset} received.
                    </div>
                  )}
                  {result?.anchor_transaction_id && (
                    <div className="alert alert--info" style={{ fontSize: '0.85rem' }}>
                      <strong>Anchor reference:</strong> {result.anchor_transaction_id}
                    </div>
                  )}
                </div>
              </details>
            )}

            {error && (
              <p className="alert alert--error" style={{ marginBottom: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div
              style={{
                marginTop: '1.5rem',
                borderTop: '1px solid var(--color-border-lighter)',
                paddingTop: '1.25rem',
              }}
            >
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                Tell your friends!
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  aria-label="Share on X"
                  onClick={() => {
                    const shareUrl = window.location.href;
                    const pct = Math.min(
                      100,
                      (campaign.raised_amount / campaign.target_amount) * 100
                    ).toFixed(1);
                    const daysLeft = Math.max(
                      0,
                      Math.ceil((new Date(campaign.end_date) - new Date()) / (1000 * 60 * 60 * 24))
                    );
                    const text = encodeURIComponent(
                      `Back ${campaign.title} on CrowdPay — ${pct}% funded, ${daysLeft} days left. ${shareUrl} #CrowdPay`
                    );
                    window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
                  }}
                >
                  Share on X
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  aria-label="Share on WhatsApp"
                  onClick={() => {
                    const shareUrl = window.location.href;
                    const pct = Math.min(
                      100,
                      (campaign.raised_amount / campaign.target_amount) * 100
                    ).toFixed(1);
                    const text = encodeURIComponent(
                      `Hey! Check out this campaign on CrowdPay: ${campaign.title}. They're ${pct}% funded and need your help. ${shareUrl}`
                    );
                    window.open(`https://wa.me/?text=${text}`, '_blank');
                  }}
                >
                  WhatsApp
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  aria-label="Share on LinkedIn"
                  onClick={() => {
                    const shareUrl = window.location.href;
                    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
                    window.open(linkedInUrl, '_blank');
                  }}
                >
                  LinkedIn
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={handleClose}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '0.75rem',
  },
  title: {
    fontSize: '1.2rem',
    fontWeight: 800,
    marginBottom: '0.5rem',
    color: 'var(--color-text-primary)',
  },
  subtitle: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    marginBottom: '1.1rem',
  },
  help: { fontSize: '0.78rem', color: 'var(--color-text-hint)', marginTop: '0.2rem' },
  actions: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '0.65rem',
    justifyContent: 'stretch',
    marginTop: '1.1rem',
  },
};
