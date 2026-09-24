import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fp-redispatch-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力清理 */ } });

const { IdentityStore } = await import('../src/identity/identity-store.js');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return new IdentityStore({ dataDir: dir });
}

function seedFailedProposal(store, { outcome = 'failed' } = {}) {
  store.observe('group:433397830', { senderId: '2371394771', senderName: 'sakura', ts: Date.now() });
  const created = store.createFriendProposal({
    userId: '2371394771',
    sourceChatKey: 'group:433397830',
    reasonCode: 'frequent',
    reason: '测试：互动频繁（Issue #10 验证路径）',
    verificationMessage: '测试验证消息',
    minMessageCount: 1
  });
  assert.equal(created.created, true);
  const proposal = created.proposal;
  store.decideFriendProposal(proposal.id, 'approve', { dispatch: true, decidedBy: 'test' });
  const dispatching = store.getFriendProposal(proposal.id);
  assert.equal(dispatching.status, 'dispatching');
  store.completeFriendProposalDispatch(
    proposal.id,
    dispatching.dispatchAttemptId,
    outcome,
    { error: '好友申请发送失败：businessCode=1（SnowLuma 能力缺口，Issue #10）' }
  );
  return store.getFriendProposal(proposal.id);
}

test('failed 候选可重置为 dispatching 并生成新 attempt id，之后照常完成派发', () => {
  const store = freshStore();
  try {
    const failed = seedFailedProposal(store, { outcome: 'failed' });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.dispatchError.includes('businessCode=1'));

    const reset = store.resetFriendProposalForRedispatch(failed.id);
    assert.equal(reset.status, 'dispatching');
    assert.notEqual(reset.dispatchAttemptId, failed.dispatchAttemptId);
    assert.match(reset.dispatchAttemptId, /^fd_[0-9a-f]{16}$/);
    assert.equal(reset.dispatchError, '');
    assert.ok(reset.dispatchStartedAt > 0);
    assert.equal(reset.dispatchedAt, 0);

    const sent = store.completeFriendProposalDispatch(reset.id, reset.dispatchAttemptId, 'sent');
    assert.equal(sent.status, 'sent');
  } finally {
    store.close();
  }
});

test('held_unknown 候选同样可以重置重派', () => {
  const store = freshStore();
  try {
    const held = seedFailedProposal(store, { outcome: 'held_unknown' });
    assert.equal(held.status, 'held_unknown');
    const reset = store.resetFriendProposalForRedispatch(held.id);
    assert.equal(reset.status, 'dispatching');
  } finally {
    store.close();
  }
});

test('pending 等非终态候选不能重置（防误触把未审批的提案绕过审批）', () => {
  const store = freshStore();
  try {
    store.observe('group:433397830', { senderId: '2371394772', senderName: 'another', ts: Date.now() });
    const created = store.createFriendProposal({
      userId: '2371394772',
      sourceChatKey: 'group:433397830',
      reasonCode: 'interest',
      reason: '测试：pending 状态不可重派',
      minMessageCount: 1
    });
    assert.equal(created.created, true);
    assert.throws(
      () => store.resetFriendProposalForRedispatch(created.proposal.id),
      /只有失败或结果未知的候选可以重新派发/
    );
  } finally {
    store.close();
  }
});

test('不存在的候选报「好友候选不存在」', () => {
  const store = freshStore();
  try {
    assert.throws(
      () => store.resetFriendProposalForRedispatch('fp_000000000000'),
      /好友候选不存在/
    );
  } finally {
    store.close();
  }
});
