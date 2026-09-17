const crypto = require('crypto');

const ACTION_ID = 'resolve_discrepancy';
const REASON_ACTION_ID = 'resolution_reason_changed';
const CALLBACK_ID = 'resolve_discrepancy_modal';
const RESOLUTION_EVENT = 'psulit_discrepancy_resolution';
const REASONS = [
  'Cash count encoding error',
  'Late-posted transaction',
  'Verified cash movement',
  'Teller recount confirmed',
  'Other'
];

function managerIds(env = process.env) {
  return new Set(String(env.SLACK_MANAGER_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
}

function resolutionKey(details) {
  return [details.branch, details.parentTs, details.openingRef, details.closingRef, details.currency].join('|');
}

function uuidFor(value) {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function reportBlocks(text, discrepancies) {
  const sections = [];
  let remaining = text;
  while (remaining.length) {
    let end = Math.min(remaining.length, 2900);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end);
      if (newline > 0) end = newline;
    }
    sections.push({ type: 'section', text: { type: 'mrkdwn', text: remaining.slice(0, end) } });
    remaining = remaining.slice(end).replace(/^\n/, '');
  }
  for (const discrepancy of discrepancies) {
    sections.push({
      type: 'actions',
      block_id: `resolve_${discrepancy.currency}`,
      elements: [{
        type: 'button', action_id: ACTION_ID, style: 'primary',
        text: { type: 'plain_text', text: '✅ Resolve Discrepancy' },
        value: JSON.stringify(discrepancy)
      }]
    });
  }
  return sections;
}

function resolutionFromReplies(replies, key) {
  return replies.find(reply => reply.metadata?.event_type === RESOLUTION_EVENT && reply.metadata?.event_payload?.resolution_key === key) || null;
}

function parseConfirmedBalance(text) {
  const patterns = [
    /(?:[A-Z]{3}\s+)?actual\s+(?:cash\s+)?confirmed\s*:\s*(?:PHP\s*)?(?:[₱$€£¥]|NT\$|C\$|A\$|S\$)?\s*([\d,]+(?:\.\d+)?)/i,
    /correct(?:ed)?\s+(?:balance|value|amount)\s*(?:was|is|:)\s*(?:[A-Z]{3}\s*)?(?:[₱$€£¥]|NT\$|C\$|A\$|S\$)?\s*([\d,]+(?:\.\d+)?)/i
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return null;
}

function correctionFromResolution(reply, lockedCount, context = {}) {
  const payload = reply?.metadata?.event_payload;
  if (reply?.metadata?.event_type !== RESOLUTION_EVENT) return null;
  const isEncodingCorrection = payload?.reason === 'Cash count encoding error';
  const isStructuredRecount = payload?.reason === 'Teller recount confirmed' &&
    payload?.affected_ref && payload?.corrected_value != null;
  if (!isEncodingCorrection && !isStructuredRecount) return null;
  const legacyTargetRef = /HANDOVER CHECK|🔄|\bClose\b[\s\S]*→[\s\S]*\bOpen\b/i.test(context.parentText || '')
    ? payload.opening_ref
    : payload.closing_ref;
  const targetRef = payload.affected_ref || (isEncodingCorrection ? legacyTargetRef : null);
  if (!targetRef || targetRef !== lockedCount?.refCode ||
      !(/^[A-Z]{3}$/.test(payload.currency || '') || payload.currency === 'Hive')) return null;
  const correctedValue = payload.corrected_value != null && Number.isFinite(Number(payload.corrected_value))
    ? Number(payload.corrected_value)
    : isEncodingCorrection ? parseConfirmedBalance(reply.text) : null;
  const recordedValue = lockedCount?.totals?.[payload.currency] ?? lockedCount?.others?.[payload.currency];
  const originalValue = recordedValue == null ? 0 : recordedValue;
  if (!Number.isFinite(correctedValue) || !Number.isFinite(originalValue)) return null;
  return {
    id: `resolution:${reply.ts || payload.resolved_at}:${targetRef}:${payload.currency}`,
    cashCountRef: targetRef,
    openingRef: targetRef,
    currency: payload.currency,
    originalValue,
    correctedValue,
    resolutionOverlay: true,
    evidence: {
      teller: 'Formal discrepancy resolution',
      sourceChannelId: payload.channel || context.channel || '',
      sourceThreadTs: payload.parent_ts || context.parentTs || '',
      sourceMessageTs: reply.ts || payload.resolved_at
    },
    approval: {
      status: 'approved', approver: payload.resolver,
      approverRole: 'management', sourceChannelId: payload.channel || context.channel || '',
      sourceThreadTs: payload.parent_ts || context.parentTs || '', sourceMessageTs: reply.ts || payload.resolved_at
    }
  };
}

function modal(details, selectedReason = null) {
  const encodingRequired = selectedReason === 'Cash count encoding error';
  const reasonOptions = REASONS.map(reason => ({ text: { type: 'plain_text', text: reason }, value: reason }));
  return {
    type: 'modal', callback_id: CALLBACK_ID,
    private_metadata: JSON.stringify(details),
    title: { type: 'plain_text', text: 'Resolve discrepancy' },
    submit: { type: 'plain_text', text: 'Record resolution' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'reason', dispatch_action: true,
        label: { type: 'plain_text', text: 'Resolution Reason' },
        element: {
          type: 'static_select', action_id: REASON_ACTION_ID,
          placeholder: { type: 'plain_text', text: 'Select a reason' }, options: reasonOptions,
          ...(selectedReason ? { initial_option: reasonOptions.find(option => option.value === selectedReason) } : {})
        }
      },
      {
        type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Notes' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 1000 }
      },
      {
        type: 'input', block_id: 'affected_count', optional: !encodingRequired,
        label: { type: 'plain_text', text: encodingRequired ? 'Affected cash count — Required' : 'Affected cash count' },
        element: { type: 'static_select', action_id: 'value', options: [
          { text: { type: 'plain_text', text: 'Opening' }, value: 'opening' },
          { text: { type: 'plain_text', text: 'Closing' }, value: 'closing' }
        ] }
      },
      {
        type: 'input', block_id: 'corrected_balance', optional: !encodingRequired,
        label: { type: 'plain_text', text: encodingRequired ? 'Confirmed corrected balance — Required' : 'Confirmed corrected balance' },
        element: { type: 'plain_text_input', action_id: 'value' }
      }
    ]
  };
}

function formatResolution({ reason, notes, userId, resolvedAt }) {
  const lines = ['✅ *DISCREPANCY RESOLVED*', `Reason: ${reason}`];
  if (notes) lines.push(`Notes: ${notes}`);
  lines.push(`Resolved by: <@${userId}>`, `Date/Time: ${resolvedAt}`);
  if (reason === 'Cash count encoding error' || reason === 'Teller recount confirmed') lines.push('No actual cash shortage/overage.');
  return lines.join('\n');
}

function validateDetails(details, payload, allowedChannels) {
  return details && allowedChannels.has(details.channel) && details.channel === payload.channel?.id &&
    details.parentTs === payload.container?.message_ts && details.branch && details.openingRef &&
    details.closingRef && details.currency && Number.isFinite(Number(details.amount));
}

function submissionValues(payload) {
  const values = payload.view?.state?.values || {};
  const reason = values.reason?.[REASON_ACTION_ID]?.selected_option?.value || values.reason?.value?.selected_option?.value;
  const notes = String(values.notes?.value?.value || '').trim();
  const affectedSide = values.affected_count?.value?.selected_option?.value || null;
  const correctedRaw = String(values.corrected_balance?.value?.value || '').trim();
  const normalizedBalance = correctedRaw
    .replace(/^\s*[A-Z]{3}\s*/i, '')
    .replace(/^\s*(?:PHP|HK\$|NT\$|C\$|A\$|S\$|[₱$€£¥])\s*/i, '')
    .replace(/,/g, '')
    .trim();
  const correctedValue = normalizedBalance === '' || !/^\d+(?:\.\d+)?$/.test(normalizedBalance)
    ? null
    : Number(normalizedBalance);
  return { reason, notes, affectedSide, correctedRaw, correctedValue };
}

function submissionErrors(payload) {
  const { reason, affectedSide, correctedRaw, correctedValue } = submissionValues(payload);
  const errors = {};
  if (!REASONS.includes(reason)) errors.reason = 'Please select a resolution reason.';
  if (reason === 'Cash count encoding error') {
    const message = 'Please select the affected cash count and enter the confirmed corrected balance.';
    if (!['opening', 'closing'].includes(affectedSide)) errors.affected_count = message;
    if (correctedRaw === '' || !Number.isFinite(correctedValue) || correctedValue < 0) errors.corrected_balance = message;
  }
  return errors;
}

function createResolutionWorkflow({ threadReplies, openView, updateView = async () => {}, postEphemeral, postResolution, env = process.env, now = () => new Date() }) {
  const allowedChannels = new Set(String(env.BRANCHES || '').split(',').map(entry => entry.split(':')[1]?.trim()).filter(Boolean));
  const authorized = managerIds(env);

  async function blockAction(payload) {
    const userId = payload.user?.id;
    if (payload.actions?.[0]?.action_id === REASON_ACTION_ID) {
      if (!authorized.has(userId)) throw new Error('Unauthorized discrepancy resolution manager.');
      const details = JSON.parse(payload.view?.private_metadata || '{}');
      if (!allowedChannels.has(details.channel)) throw new Error('Invalid discrepancy resolution channel.');
      const selectedReason = payload.actions[0]?.selected_option?.value || null;
      if (!REASONS.includes(selectedReason)) throw new Error('Invalid discrepancy resolution reason.');
      await updateView(payload.view?.id, payload.view?.hash, modal(details, selectedReason));
      return { updated: true };
    }
    const details = { ...JSON.parse(payload.actions?.[0]?.value || '{}'), parentTs: payload.container?.message_ts };
    if (!authorized.has(userId)) {
      await postEphemeral(payload.channel?.id, userId, 'You are not authorized to resolve this discrepancy.');
      return { authorized: false };
    }
    if (!validateDetails(details, payload, allowedChannels)) throw new Error('Invalid discrepancy resolution target.');
    const existing = resolutionFromReplies(await threadReplies(details.channel, details.parentTs), resolutionKey(details));
    if (existing) {
      await postEphemeral(details.channel, userId, `This discrepancy has already been resolved.\n${existing.text || ''}`);
      return { duplicate: true };
    }
    await openView(payload.trigger_id, modal(details));
    return { opened: true };
  }

  async function viewSubmission(payload) {
    const userId = payload.user?.id;
    if (!authorized.has(userId)) return { authorized: false };
    const details = JSON.parse(payload.view?.private_metadata || '{}');
    if (!allowedChannels.has(details.channel)) throw new Error('Invalid discrepancy resolution channel.');
    const errors = submissionErrors(payload);
    if (Object.keys(errors).length) throw new Error('Invalid discrepancy resolution submission.');
    const { reason, notes, affectedSide, correctedValue } = submissionValues(payload);
    const key = resolutionKey(details);
    const existing = resolutionFromReplies(await threadReplies(details.channel, details.parentTs), key);
    if (existing) {
      await postEphemeral(details.channel, userId, `This discrepancy has already been resolved.\n${existing.text || ''}`);
      return { duplicate: true };
    }
    const resolvedInstant = now();
    const resolvedAt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'medium' }).format(resolvedInstant);
    const text = formatResolution({ reason, notes, userId, resolvedAt });
    const posted = await postResolution(details.channel, details.parentTs, text, {
      clientMsgId: uuidFor(key),
      metadata: { event_type: RESOLUTION_EVENT, event_payload: { resolution_key: key, branch: details.branch, channel: details.channel, parent_ts: details.parentTs, opening_ref: details.openingRef, closing_ref: details.closingRef, affected_side: affectedSide, affected_ref: affectedSide === 'opening' ? details.openingRef : affectedSide === 'closing' ? details.closingRef : null, currency: details.currency, amount: String(details.amount), corrected_value: correctedValue == null ? null : String(correctedValue), reason, resolver: userId, resolved_at: resolvedInstant.toISOString() } }
    });
    return { posted };
  }

  function validateSubmission(payload) {
    const userId = payload.user?.id;
    if (!authorized.has(userId)) return { reason: 'You are not authorized to resolve this discrepancy.' };
    let details;
    try { details = JSON.parse(payload.view?.private_metadata || '{}'); } catch { return { reason: 'This resolution target is invalid. Please close the form and try again.' }; }
    if (!allowedChannels.has(details.channel)) return { reason: 'This resolution target is invalid. Please close the form and try again.' };
    return submissionErrors(payload);
  }

  async function notifyFailure(payload, message) {
    const channel = payload.channel?.id || (() => { try { return JSON.parse(payload.view?.private_metadata || '{}').channel; } catch { return null; } })();
    const userId = payload.user?.id;
    if (channel && userId) await postEphemeral(channel, userId, message);
  }

  return { blockAction, viewSubmission, validateSubmission, notifyFailure };
}

module.exports = { ACTION_ID, CALLBACK_ID, REASON_ACTION_ID, REASONS, RESOLUTION_EVENT, correctionFromResolution, createResolutionWorkflow, formatResolution, parseConfirmedBalance, reportBlocks, resolutionKey, resolutionFromReplies, submissionErrors };
