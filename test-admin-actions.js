const assert = require('assert');
const crypto = require('crypto');
const {
  APPROVED_ADMIN_ACTIONS,
  actionForEvent,
  executeApprovedAdminAction
} = require('./admin-actions');

const action = APPROVED_ADMIN_ACTIONS[0];
const image = Buffer.from('authorized-test-image');
const testAction = {
  ...action,
  imageSha256: crypto.createHash('sha256').update(image).digest('hex')
};

const event = {
  type: 'message',
  channel: testAction.channelId,
  thread_ts: testAction.parentThreadTs,
  user: testAction.authorizedUserId,
  text: testAction.trigger,
  files: [{
    name: 'highlighted.jpg',
    mimetype: 'image/jpeg',
    url_private_download: 'https://files.slack.test/highlighted.jpg'
  }]
};

assert(actionForEvent(event, [testAction]), 'exact approved action must match');
assert(actionForEvent({ ...event, text: `${testAction.trigger}\n*Sent using ChatGPT*` }, [testAction]));
assert.strictEqual(actionForEvent({ ...event, user: 'U-TELLER' }, [testAction]), null);
assert.strictEqual(actionForEvent({ ...event, channel: 'C-WRONG' }, [testAction]), null);
assert.strictEqual(actionForEvent({ ...event, thread_ts: '1.000001' }, [testAction]), null);
assert.strictEqual(actionForEvent({ ...event, text: 'post something else' }, [testAction]), null);

(async () => {
  let uploads = 0;
  const deps = {
    threadReplies: async () => [],
    slackFileInfo: async () => event.files[0],
    downloadSlackFile: async () => ({ data: image, contentType: 'image/jpeg' }),
    uploadThreadImage: async (channel, thread, data, options) => {
      uploads++;
      assert.strictEqual(channel, testAction.channelId);
      assert.strictEqual(thread, testAction.parentThreadTs);
      assert.deepStrictEqual(data, image);
      assert.strictEqual(options.message, testAction.message);
      return { files: [{ id: 'F-TEST' }] };
    }
  };

  const posted = await executeApprovedAdminAction(event, deps, [testAction]);
  assert.strictEqual(posted.handled, true);
  assert.strictEqual(posted.duplicate, false);
  assert.strictEqual(uploads, 1);

  const duplicate = await executeApprovedAdminAction(event, {
    ...deps,
    threadReplies: async () => [{ ts: '123.456', text: testAction.message }]
  }, [testAction]);
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(duplicate.ts, '123.456');
  assert.strictEqual(uploads, 1, 'duplicate protection must prevent another upload');

  await assert.rejects(
    executeApprovedAdminAction(event, {
      ...deps,
      downloadSlackFile: async () => ({ data: Buffer.from('wrong'), contentType: 'image/jpeg' })
    }, [testAction]),
    /does not match/
  );
  await assert.rejects(
    executeApprovedAdminAction(
      { ...event, files: [] },
      { ...deps, slackFileInfo: async () => ({ mimetype: 'text/plain' }) },
      [testAction]
    ),
    /exactly one image/
  );

  const referencedFile = await executeApprovedAdminAction(
    { ...event, files: [] }, deps, [testAction]
  );
  assert.strictEqual(referencedFile.handled, true);

  console.log('approved admin action authentication, image, and duplicate tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
