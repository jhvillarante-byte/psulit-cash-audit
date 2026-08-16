const axios = require('axios');

const SLACK_API = 'https://slack.com/api';
const token = () => process.env.SLACK_BOT_TOKEN;

function client() {
  return axios.create({
    baseURL: SLACK_API,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// Fetches message history for a channel between two timestamps (inclusive).
// Auto-paginates through Slack's cursor until ALL messages in the requested
// window are retrieved — a busy day with hundreds of transactions should
// never be silently truncated. `limit` here just controls the page size per
// API call, not a cap on the total returned.
async function history(channelId, { oldest, latest, limit = 200 } = {}) {
  let allMessages = [];
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const params = { channel: channelId, oldest, latest, limit, inclusive: true };
    if (cursor) params.cursor = cursor;

    const res = await client().get('/conversations.history', { params });
    if (!res.data.ok) throw new Error(`Slack history error: ${res.data.error}`);

    allMessages = allMessages.concat(res.data.messages || []);
    hasMore = !!(res.data.has_more && res.data.response_metadata && res.data.response_metadata.next_cursor);
    cursor = hasMore ? res.data.response_metadata.next_cursor : undefined;
  }

  return allMessages;
}

// Posts a threaded reply on a message.
async function replyInThread(channelId, threadTs, text) {
  const res = await client().post('/chat.postMessage', {
    channel: channelId,
    thread_ts: threadTs,
    text,
    unfurl_links: false
  });
  if (!res.data.ok) throw new Error(`Slack postMessage error: ${res.data.error}`);
  return res.data;
}

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

// Fetches a thread's parent message + all replies. The Psulit Cash Count bot
// posts each report as a compact top-level summary with the full
// denomination breakdown in a threaded reply — this is how we retrieve that
// reply's text for denomination-level parsing.
async function fetchThreadReplies(channelId, threadTs) {
  const res = await client().get('/conversations.replies', {
    params: { channel: channelId, ts: threadTs }
  });
  if (!res.data.ok) throw new Error(`Slack replies error: ${res.data.error}`);
  return res.data.messages || []; // messages[0] is the parent itself, rest are replies
}

module.exports = { history, replyInThread, postMessage, fetchThreadReplies };
