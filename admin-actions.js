'use strict';

const crypto = require('crypto');

const APPROVED_ADMIN_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'correct-ar-0001630-cad-direction',
    trigger: 'APPROVE CASH AUDIT ACTION: correct-ar-0001630-cad-direction',
    authorizedUserId: 'U0B8SV8CG9L',
    channelId: 'C0B734364T0',
    parentThreadTs: '1788925450.692769',
    imageSha256: '16c99ff9d471fa42ef4d2c7cb078b0b4ab08a30d67b801cae99f2a482a1de2c0',
    message: 'Ate Tina, please correct the 1,150 CAD entry from BUY to SELL. Since we sold the CAD to Czarina, the correct entry should be SELL. Please reply in the app with the corrected entry.'
  })
]);

function actionForEvent(event, actions = APPROVED_ADMIN_ACTIONS) {
  return actions.find(action =>
    event && event.channel === action.channelId &&
    event.thread_ts === action.parentThreadTs &&
    event.user === action.authorizedUserId &&
    String(event.text || '').trim() === action.trigger
  ) || null;
}

async function executeApprovedAdminAction(event, deps, actions = APPROVED_ADMIN_ACTIONS) {
  const action = actionForEvent(event, actions);
  if (!action) return { handled: false };

  const files = (event.files || []).filter(file =>
    String(file.mimetype || '').startsWith('image/') && file.url_private_download
  );
  if (files.length !== 1) {
    throw new Error('Approved admin action requires exactly one image attachment');
  }

  const replies = await deps.threadReplies(action.channelId, action.parentThreadTs);
  const duplicate = replies.find(reply => reply.text === action.message);
  if (duplicate) {
    return { handled: true, duplicate: true, ts: duplicate.ts };
  }

  const downloaded = await deps.downloadSlackFile(files[0].url_private_download);
  const digest = crypto.createHash('sha256').update(downloaded.data).digest('hex');
  if (digest !== action.imageSha256) {
    throw new Error('Approved admin action image does not match the authorized attachment');
  }

  const posted = await deps.uploadThreadImage(
    action.channelId,
    action.parentThreadTs,
    downloaded.data,
    {
      filename: files[0].name || 'ar-0001630-cad-correction.jpg',
      title: 'AR 0001630 — CAD direction correction',
      contentType: downloaded.contentType,
      message: action.message
    }
  );

  return { handled: true, duplicate: false, posted };
}

module.exports = {
  APPROVED_ADMIN_ACTIONS,
  actionForEvent,
  executeApprovedAdminAction
};
