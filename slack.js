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

// Fetches message history for a channel between two timestamps (exclusive of `latest`).
async function history(channelId, { oldest, latest, limit = 200 } = {}) {
  const res = await client().get('/conversations.history', {
    params: { channel: channelId, oldest, latest, limit, inclusive: true }
  });
  if (!res.data.ok) throw new Error(`Slack history error: ${res.data.error}`);
  return res.data.messages || [];
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

module.exports = { history, replyInThread, postMessage };
