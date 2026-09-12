'use strict';

// Corrections are immutable, management-approved audit records. They replace
// an effective opening value during reconciliation; original cash-count Slack
// messages remain untouched.
const APPROVED_CORRECTIONS = Object.freeze([
  Object.freeze({
    id: 'PSC-MTS2WZJV-9LGR:EUR:1788908073.626909',
    openingRef: 'PSC-MTS2WZJV-9LGR',
    currency: 'EUR',
    originalValue: 235,
    correctedValue: 255,
    evidence: Object.freeze({
      teller: 'Tina',
      sourceChannelId: 'C0B734364T0',
      sourceThreadTs: '1788837409.940699',
      sourceMessageTs: '1788839438.476819'
    }),
    approval: Object.freeze({
      status: 'approved',
      approver: 'Corporate Psulit',
      approverRole: 'management',
      sourceChannelId: 'C0B734364T0',
      sourceThreadTs: '1788900807.638049',
      sourceMessageTs: '1788908073.626909'
    })
  })
]);

const APPROVED_TRANSACTION_CORRECTIONS = Object.freeze([
  Object.freeze({
    id: 'AR-0001630:CAD:BUY-SELL:1788933135.318999',
    transactionRef: '1630',
    transactionDate: '09/08/2026',
    counterparty: 'CZARINA',
    currency: 'CAD',
    amount: 1150,
    originalDirection: 'BUY',
    correctedDirection: 'SELL',
    phpSettlement: 51474,
    evidence: Object.freeze({
      originalReceiptRef: 'AR 0001630',
      sourceChannelId: 'C0B734364T0',
      sourceThreadTs: '1788925450.692769'
    }),
    approval: Object.freeze({
      status: 'approved',
      approver: 'Corporate Psulit',
      approverRole: 'management',
      sourceChannelId: 'C0B734364T0',
      sourceThreadTs: '1788925450.692769',
      sourceMessageTs: '1788933135.318999'
    })
  })
]);

function isApprovedTransactionCorrection(correction) {
  return !!(correction && correction.id && correction.transactionRef &&
    correction.transactionDate && correction.counterparty &&
    /^[A-Z]{3}$/.test(correction.currency || '') &&
    Number.isFinite(correction.amount) && Number.isFinite(correction.phpSettlement) &&
    ['BUY', 'SELL'].includes(correction.originalDirection) &&
    ['BUY', 'SELL'].includes(correction.correctedDirection) &&
    correction.originalDirection !== correction.correctedDirection &&
    correction.evidence && correction.evidence.originalReceiptRef &&
    correction.evidence.sourceChannelId && correction.evidence.sourceThreadTs &&
    correction.approval && correction.approval.status === 'approved' &&
    correction.approval.approverRole === 'management' &&
    correction.approval.sourceMessageTs);
}

function buildTransactionCorrectionRegistry(corrections = APPROVED_TRANSACTION_CORRECTIONS) {
  const registry = new Map();
  for (const correction of corrections) {
    if (!isApprovedTransactionCorrection(correction)) continue;
    const key = `${correction.transactionRef}|${correction.currency}|${correction.amount}`;
    if (registry.has(key)) throw new Error(`Duplicate or conflicting transaction correction for ${key}`);
    registry.set(key, correction);
  }
  return registry;
}

function applyApprovedTransactionCorrections(transaction, corrections = APPROVED_TRANSACTION_CORRECTIONS) {
  if (!transaction) return { effectiveTransaction: transaction, applied: [] };
  const registry = buildTransactionCorrectionRegistry(corrections);
  const effectiveTransaction = {
    ...transaction,
    movements: (transaction.movements || []).map(movement => ({ ...movement }))
  };
  const applied = [];

  for (const correction of registry.values()) {
    if (String(transaction.ref) !== String(correction.transactionRef)) continue;
    if (!String(transaction.raw || '').includes(correction.transactionDate) ||
        !String(transaction.raw || '').toUpperCase().includes(correction.counterparty)) {
      throw new Error(`Approved transaction correction source evidence mismatch for AR ${correction.transactionRef}`);
    }
    const matches = effectiveTransaction.movements.filter(movement =>
      movement.ccy === correction.currency &&
      Math.abs(movement.fcyAmount - correction.amount) < 0.000001
    );
    if (matches.length !== 1) throw new Error(`Approved transaction correction movement mismatch for AR ${correction.transactionRef}`);
    const movement = matches[0];
    if (movement.action !== correction.originalDirection) {
      throw new Error(`Approved transaction correction original direction mismatch for AR ${correction.transactionRef}`);
    }
    if (Number.isFinite(movement.phpAmount) && Math.abs(movement.phpAmount - correction.phpSettlement) > 0.01) {
      throw new Error(`Approved transaction correction PHP settlement mismatch for AR ${correction.transactionRef}`);
    }
    movement.phpAmount = correction.phpSettlement;
    movement.action = correction.correctedDirection;
    applied.push(correction);
  }

  return { effectiveTransaction, applied };
}

function correctionKey(correction) {
  return `${correction.cashCountRef || correction.openingRef}|${correction.currency}`;
}

function isExplicitlyApproved(correction) {
  const approval = correction && correction.approval;
  const evidence = correction && correction.evidence;
  return !!(
    correction && correction.id && (correction.cashCountRef || correction.openingRef) &&
    /^[A-Z]{3}$/.test(correction.currency || '') &&
    Number.isFinite(correction.originalValue) &&
    Number.isFinite(correction.correctedValue) &&
    evidence && evidence.teller && evidence.sourceChannelId &&
    evidence.sourceThreadTs && evidence.sourceMessageTs &&
    approval && approval.status === 'approved' &&
    approval.approver && approval.approverRole === 'management' &&
    approval.sourceChannelId && approval.sourceThreadTs &&
    approval.sourceMessageTs
  );
}

function buildCorrectionRegistry(corrections = APPROVED_CORRECTIONS) {
  const registry = new Map();

  for (const correction of corrections) {
    if (!isExplicitlyApproved(correction)) continue;
    const key = correctionKey(correction);
    if (registry.has(key)) {
      const existing = registry.get(key);
      const conflict = existing.originalValue !== correction.originalValue ||
        existing.correctedValue !== correction.correctedValue ||
        existing.id !== correction.id;
      throw new Error(conflict
        ? `Conflicting approved corrections for ${key}`
        : `Duplicate approved correction for ${key}`);
    }
    registry.set(key, correction);
  }

  return registry;
}

function correctionsForOpening(openingRef, corrections = APPROVED_CORRECTIONS) {
  const registry = buildCorrectionRegistry(corrections);
  return [...registry.values()].filter(
    correction => (correction.cashCountRef || correction.openingRef) === openingRef
  );
}

function applyApprovedOpeningCorrections(openingCount, corrections = APPROVED_CORRECTIONS) {
  const effectiveTotals = { ...(openingCount && openingCount.totals || {}) };
  const applied = [];

  for (const correction of correctionsForOpening(openingCount && openingCount.refCode, corrections)) {
    const recorded = effectiveTotals[correction.currency];
    if (!Number.isFinite(recorded) || Math.abs(recorded - correction.originalValue) > 0.01) {
      throw new Error(`Approved correction original value mismatch for ${correction.cashCountRef || correction.openingRef} ${correction.currency}`);
    }
    effectiveTotals[correction.currency] = correction.correctedValue;
    applied.push(correction);
  }

  return { effectiveTotals, applied };
}

module.exports = {
  APPROVED_CORRECTIONS,
  APPROVED_TRANSACTION_CORRECTIONS,
  applyApprovedTransactionCorrections,
  applyApprovedOpeningCorrections,
  buildTransactionCorrectionRegistry,
  buildCorrectionRegistry,
  correctionsForOpening,
  isExplicitlyApproved,
  isApprovedTransactionCorrection
};
