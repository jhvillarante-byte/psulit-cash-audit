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

function correctionKey(correction) {
  return `${correction.openingRef}|${correction.currency}`;
}

function isExplicitlyApproved(correction) {
  const approval = correction && correction.approval;
  const evidence = correction && correction.evidence;
  return !!(
    correction && correction.id && correction.openingRef &&
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
  return [...registry.values()].filter(correction => correction.openingRef === openingRef);
}

function applyApprovedOpeningCorrections(openingCount, corrections = APPROVED_CORRECTIONS) {
  const effectiveTotals = { ...(openingCount && openingCount.totals || {}) };
  const applied = [];

  for (const correction of correctionsForOpening(openingCount && openingCount.refCode, corrections)) {
    const recorded = effectiveTotals[correction.currency];
    if (!Number.isFinite(recorded) || Math.abs(recorded - correction.originalValue) > 0.01) {
      throw new Error(`Approved correction original value mismatch for ${correction.openingRef} ${correction.currency}`);
    }
    effectiveTotals[correction.currency] = correction.correctedValue;
    applied.push(correction);
  }

  return { effectiveTotals, applied };
}

module.exports = {
  APPROVED_CORRECTIONS,
  applyApprovedOpeningCorrections,
  buildCorrectionRegistry,
  correctionsForOpening,
  isExplicitlyApproved
};
