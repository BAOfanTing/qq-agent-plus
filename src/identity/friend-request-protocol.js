import jce from 'jce';

const GET_SETTING_COMMAND = 'friendlist.getUserAddFriendSetting';
const SEND_REQUEST_COMMAND = 'friendlist.addFriend';
const FRIEND_LIST_SERVANT = 'mqq.IMService.FriendListServiceServantObj';
const SUPPORTED_SETTINGS = new Set([0, 1, 4]);
const GROUP_SOURCE_ID = 3004;
const DEFAULT_SOURCE_ID = 3999;

function encodeStruct(fields) {
  return jce.encode([jce.encodeNested(fields)]);
}

function encodeWrapper(values, functionName) {
  return jce.encode([
    null,
    3,
    0,
    0,
    0,
    FRIEND_LIST_SERVANT,
    functionName,
    jce.encode([values]),
    0,
    {},
    {}
  ]);
}

function decodeWrapper(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('SnowLuma 返回了无效的 JCE 响应');
  }
  const wrapper = jce.decode(Buffer.from(hex, 'hex'));
  const values = jce.decode(Buffer.from(wrapper[7]))[0];
  if (!values || typeof values !== 'object') {
    throw new Error('SnowLuma 返回的 JCE 响应缺少结果映射');
  }
  const first = values[Object.keys(values)[0]];
  const nested = Buffer.isBuffer(first)
    ? first
    : first && typeof first === 'object'
      ? first[Object.keys(first)[0]]
      : null;
  if (!Buffer.isBuffer(nested)) {
    throw new Error('SnowLuma 返回的 JCE 响应缺少结果结构');
  }
  return jce.decode(nested)[0];
}

function normalizeUin(value, field) {
  const text = String(value ?? '').trim();
  if (!/^\d{5,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new FriendRequestProtocolError(`${field} 必须是有效 QQ 号`, {
      phase: 'validation',
      outcome: 'failed'
    });
  }
  return Number(text);
}

function encodeUnsignedVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function sourceForChat(chatKey) {
  const match = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (!match) return { sourceId: DEFAULT_SOURCE_ID, friendSource: null };
  const groupId = Number(match[1]);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new FriendRequestProtocolError('来源群号无效', {
      phase: 'validation',
      outcome: 'failed'
    });
  }
  return {
    sourceId: GROUP_SOURCE_ID,
    friendSource: Buffer.concat([Buffer.from([0x08]), encodeUnsignedVarint(groupId)])
  };
}

export class FriendRequestProtocolError extends Error {
  constructor(message, {
    phase = 'dispatch',
    outcome = 'unknown',
    businessCode = null,
    setting = null,
    cause
  } = {}) {
    super(message, { cause });
    this.name = 'FriendRequestProtocolError';
    this.phase = phase;
    this.outcome = outcome;
    this.businessCode = businessCode;
    this.setting = setting;
  }
}

async function sendPacket(onebot, command, data, { signal, phase }) {
  try {
    return await onebot.call(
      'send_packet',
      { cmd: command, data: Buffer.from(data).toString('hex'), rsp: true },
      15000,
      signal
    );
  } catch (error) {
    throw new FriendRequestProtocolError(
      `SnowLuma ${phase === 'preflight' ? '好友设置查询' : '好友申请发送'}失败：${String(error?.message ?? error)}`,
      {
        phase,
        outcome: phase === 'preflight' ? 'failed' : 'unknown',
        cause: error
      }
    );
  }
}

export async function getFriendRequestSetting(onebot, {
  selfId,
  userId,
  sourceChatKey = '',
  signal
}) {
  const selfUin = normalizeUin(selfId, '机器人 QQ');
  const targetUin = normalizeUin(userId, '目标 QQ');
  const { sourceId } = sourceForChat(sourceChatKey);
  const request = encodeWrapper({
    FS: encodeStruct([selfUin, targetUin, sourceId, 0, null, 1])
  }, 'GetUserAddFriendSettingReq');
  const response = await sendPacket(onebot, GET_SETTING_COMMAND, request, {
    signal,
    phase: 'preflight'
  });
  let decoded;
  try {
    decoded = decodeWrapper(response);
  } catch (error) {
    throw new FriendRequestProtocolError(
      `无法解析好友设置响应：${String(error?.message ?? error)}`,
      { phase: 'preflight', outcome: 'failed', cause: error }
    );
  }
  const setting = Number(decoded?.[2]);
  if (!Number.isInteger(setting)) {
    throw new FriendRequestProtocolError('好友设置响应缺少验证类型', {
      phase: 'preflight',
      outcome: 'failed'
    });
  }
  return setting;
}

export async function sendFriendRequestViaSnowLuma(onebot, {
  selfId,
  userId,
  sourceChatKey = '',
  verificationMessage = '',
  signal
}) {
  const selfUin = normalizeUin(selfId, '机器人 QQ');
  const targetUin = normalizeUin(userId, '目标 QQ');
  if (selfUin === targetUin) {
    throw new FriendRequestProtocolError('不能向机器人自身发送好友申请', {
      phase: 'validation',
      outcome: 'failed'
    });
  }

  const setting = await getFriendRequestSetting(onebot, {
    selfId: selfUin,
    userId: targetUin,
    sourceChatKey,
    signal
  });
  if (!SUPPORTED_SETTINGS.has(setting)) {
    throw new FriendRequestProtocolError(`对方的加好友验证类型暂不支持（${setting}）`, {
      phase: 'preflight',
      outcome: 'failed',
      setting
    });
  }

  const comment = String(verificationMessage || '').trim().slice(0, 50);
  const { sourceId, friendSource } = sourceForChat(sourceChatKey);
  // ⚠️ 候选修复（Issue #10）：这里原本在 [5] 单独编码了一个 Buffer.byteLength(comment)
  // 字节长度、[6] 才是消息本体——JCE 字符串自带长度前缀，额外长度字段会让服务端从
  // [5] 起整体错位，实测对"已是好友"的目标也返回与陌生人完全相同的笼统错误
  // （result=1「添加失败，请稍后再试」），说明请求在好友逻辑之前就被拒了。
  // 现按 JCE 惯例移除手工长度，消息本体落在 [5]、后续字段整体前移一位。
  // 验证方式（无害）：向"已经是好友"的号发申请——结构修对了应得到语义化错误
  // （如"已是好友"）而不是笼统 result=1。
  const request = encodeWrapper({
    AF: encodeStruct([
      selfUin,                     // [0]
      targetUin,                   // [1]
      setting ? 1 : 0,             // [2]
      1,                           // [3]
      0,                           // [4]
      comment,                     // [5]
      0,                           // [6]
      1,                           // [7]
      null,                        // [8]
      sourceId,                    // [9]
      11,                          // [10]
      null,                        // [11]
      null,                        // [12]
      friendSource,                // [13]
      0,                           // [14]
      null,                        // [15]
      null,                        // [16]
      0                            // [17]
    ])
  }, 'AddFriendReq');
  const response = await sendPacket(onebot, SEND_REQUEST_COMMAND, request, {
    signal,
    phase: 'dispatch'
  });

  let decoded;
  try {
    decoded = decodeWrapper(response);
  } catch (error) {
    throw new FriendRequestProtocolError(
      `好友申请已发出，但无法解析 QQ 响应：${String(error?.message ?? error)}`,
      { phase: 'dispatch', outcome: 'unknown', setting, cause: error }
    );
  }
  const businessCode = Number(decoded?.[6]);
  const wording = String(decoded?.[8] || '').trim();
  if (!Number.isInteger(businessCode)) {
    throw new FriendRequestProtocolError('好友申请已发出，但 QQ 响应缺少业务结果码', {
      phase: 'dispatch',
      outcome: 'unknown',
      setting
    });
  }
  if (businessCode !== 0) {
    throw new FriendRequestProtocolError(
      wording || `QQ 拒绝了好友申请（业务码 ${businessCode}）`,
      {
        phase: 'dispatch',
        outcome: 'failed',
        businessCode,
        setting
      }
    );
  }
  return {
    accepted: true,
    businessCode,
    setting,
    wording
  };
}

export const FRIEND_REQUEST_PROTOCOL = Object.freeze({
  getSettingCommand: GET_SETTING_COMMAND,
  sendRequestCommand: SEND_REQUEST_COMMAND,
  groupSourceId: GROUP_SOURCE_ID,
  defaultSourceId: DEFAULT_SOURCE_ID,
  supportedSettings: Object.freeze([...SUPPORTED_SETTINGS])
});
