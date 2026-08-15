// ============================================================================
// ADD THIS to slack.js — append after replyInThread, then add `postMessage`
// to the module.exports list at the end.
// ============================================================================

// Posts a new top-level message (not threaded) — used for the opening
// discrepancy check so teller @-tags render prominently in the channel.
async function postMessage(channelId, text) {
  const res = await client().post('/chat.postMessage', {
    channel: channelId,
    text,
    unfurl_links: false
  });
  if (!res.data.ok) throw new Error(`Slack postMessage error: ${res.data.error}`);
  return res.data;
}

// Add `postMessage` here:
// module.exports = { history, replyInThread, postMessage };
