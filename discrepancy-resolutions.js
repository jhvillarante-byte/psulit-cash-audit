const crypto = require('crypto');

const ACTION_ID = 'resolve_discrepancy';
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
  if (reply?.metadata?.event_type !== RESOLUTION_EVENT ||
      payload?.reason !== 'Cash count encoding error') return null;
  const legacyTargetRef = /HANDOVER CHECK|🔄|\bClose\b[\s\S]*→[\s\S]*\bOpen\b/i.test(context.parentText || '')
    ? payload.opening_ref
    : payload.closing_ref;
  const targetRef = payload.affected_ref || legacyTargetRef;
  if (!targetRef || targetRef !== lockedCount?.refCode ||
      !/^[A-Z]{3}$/.test(payload.currency || '')) return null;
  const correctedValue = payload.corrected_value != null && Number.isFinite(Number(payload.corrected_value))
    ? Number(payload.corrected_value)
    : parseConfirmedBalance(reply.text);
  const originalValue = lockedCount?.totals?.[payload.currency] ?? lockedCount?.others?.[payload.currency];
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

function modal(details) {
  return {
    type: 'modal', callback_id: CALLBACK_ID,
    private_metadata: JSON.stringify(details),
    title: { type: 'plain_text', text: 'Resolve discrepancy' },
    submit: { type: 'plain_text', text: 'Record resolution' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'reason', label: { type: 'plain_text', text: 'Resolution Reason' },
        element: {
          type: 'static_select', action_id: 'value', placeholder: { type: 'plain_text', text: 'Select a reason' },
          options: REASONS.map(reason => ({ text: { type: 'plain_text', text: reason }, value: reason }))
        }
      },
      {
        type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Notes' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 1000 }
      },
      {
        type: 'input', block_id: 'affected_count', optional: true,
        label: { type: 'plain_text', text: 'Affected cash count (encoding errors)' },
        element: { type: 'static_select', action_id: 'value', options: [
          { text: { type: 'plain_text', text: 'Opening' }, value: 'opening' },
          { text: { type: 'plain_text', text: 'Closing' }, value: 'closing' }
        ] }
      },
      {
        type: 'input', block_id: 'corrected_balance', optional: true,
        label: { type: 'plain_text', text: 'Confirmed corrected balance' },
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

function createResolutionWorkflow({ threadReplies, openView, postEphemeral, postResolution, env = process.env, now = () => new Date() }) {
  const allowedChannels = new Set(String(env.BRANCHES || '').split(',').map(entry => entry.split(':')[1]?.trim()).filter(Boolean));
  const authorized = managerIds(env);

  async function blockAction(payload) {
    const userId = payload.user?.id;
    const details = { ...JSON.parse(payload.actions?.[0]?.value || '{}'), parentTs: payload.container?.message_ts };
    if (!authorized.has(userId)) {
      await postEphemeral(payload.channel?.id, userId, 'Only an authorized manager can resolve audit discrepancies.');
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
    const reason = payload.view?.state?.values?.reason?.value?.selected_option?.value;
    const notes = String(payload.view?.state?.values?.notes?.value?.value || '').trim();
    if (!REASONS.includes(reason)) throw new Error('Invalid discrepancy resolution reason.');
    const affectedSide = payload.view?.state?.values?.affected_count?.value?.selected_option?.value || null;
    const correctedRaw = String(payload.view?.state?.values?.corrected_balance?.value?.value || '').replace(/,/g, '').trim();
    const correctedValue = correctedRaw === '' ? null : Number(correctedRaw);
    if (reason === 'Cash count encoding error' &&
        (!['opening', 'closing'].includes(affectedSide) || !Number.isFinite(correctedValue) || correctedValue < 0)) {
      throw new Error('Cash count encoding corrections require the affected count and confirmed corrected balance.');
    }
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

  return { blockAction, viewSubmission };
}

module.exports = { ACTION_ID, CALLBACK_ID, REASONS, RESOLUTION_EVENT, correctionFromResolution, createResolutionWorkflow, formatResolution, parseConfirmedBalance, reportBlocks, resolutionKey, resolutionFromReplies };
