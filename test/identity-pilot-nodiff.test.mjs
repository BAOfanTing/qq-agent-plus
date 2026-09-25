import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stable-infra-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { DEFAULT_CONFIG } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { IdentityPilotManager } = await import('../src/identity/identity-pilot.js');
const { IncidentPilotManager } = await import('../src/pilots/incident-pilot.js');

test('identity and incident infrastructure start without an approval owner; friend proposal stays retired', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allowAllWhenEmpty = true;
  cfg.identityPilot.friendProposal.ownerUin = '';
  cfg.incidentPilot.ownerUin = '';

  const store = new ChatStore(0, { dataDir: root });
  const identity = new IdentityPilotManager({
    store,
    dataDir: root,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      connected: true,
      call: async (action) => action === 'get_friend_list' ? [] : {}
    },
    log: () => {}
  });
  t.after(() => {
    identity.stop();
    store.close();
  });

  const identityStatus = await identity.start();
  assert.equal(identityStatus.enabled, true);
  assert.equal(identityStatus.active, true);
  assert.equal(identityStatus.friendProposal.enabled, false);
  assert.equal(identityStatus.friendProposal.activeDispatchEnabled, false);
  assert.equal(identityStatus.friendProposal.ownerConfigured, false);
  assert.equal(identityStatus.incomingFriendRequest.enabled, true);
  assert.equal(identityStatus.incomingFriendRequest.ownerConfigured, false);

  // Missing owner affects only the notification/approval edge. It must not
  // prevent the request from being durably recorded by the always-on manager.
  const incoming = await identity.receiveIncomingFriendRequest({
    userId: '123456',
    flag: 'stable-feature-test',
    comment: 'hello'
  });
  assert.equal(incoming.request.userId, '123456');
  assert.equal(identity.listIncomingFriendRequests().length, 1);

  const incidents = new IncidentPilotManager({
    dataDir: root,
    config: () => cfg,
    notifyAvailable: () => false,
    log: () => {}
  });
  t.after(() => incidents.stop());
  const incidentStatus = incidents.start();
  assert.equal(incidentStatus.enabled, true);
  assert.equal(incidentStatus.active, true);
  const captured = incidents.capture(new Error('stable infrastructure test'), {
    source: 'test',
    severity: 'error'
  });
  assert.ok(captured?.id);
  assert.equal(incidents.list({ state: 'open' }).length, 1);
});
