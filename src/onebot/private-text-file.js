import { privateFileMaxKiB } from '../core/platform-gates.js';

// 固定的安全回执，不接收协议端原始错误正文；not_attempted 仅表示本次没有上传。
const SEND_FAILURES = {
  PRIVATE_FILE_DISABLED: ['私聊文本文件发送未开启，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_PAUSED: ['机器人已暂停，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_MODE_BLOCKED: ['当前运行模式不允许发送，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_ACCESS_DENIED: ['当前私聊未获发送权限，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_INACTIVE: ['当前不在允许发送的时段内，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_BLOCKED: ['本次上传被发送前检查阻止，请检查发送设置。', 'not_attempted'],
  PRIVATE_FILE_CANCELLED: ['任务已取消，本次未上传。', 'not_attempted'],
  PRIVATE_FILE_SIZE_LIMIT: ['正文超过当前大小设置，本次未上传，请缩短正文或调整上限。', 'not_attempted'],
  PRIVATE_FILE_RATE_LIMITED: ['发送频率已达上限，本次未上传，请稍后再处理。', 'not_attempted'],
  PRIVATE_FILE_HELD: ['当前私聊有待核对的发送记录，本次已阻止上传，请先核对已有发送，不要重复发送。', 'not_attempted'],
  PRIVATE_FILE_REJECTED: ['私聊文本文件确定未送达，不会自动重试。', 'failed'],
  PRIVATE_FILE_UNCONFIRMED: ['私聊文本文件投递结果未知，请先核对，不要重复发送。', 'unknown']
};

export function privateTextFileError(code) {
  const key = typeof code === 'string' && Object.hasOwn(SEND_FAILURES, code) ? code : 'PRIVATE_FILE_UNCONFIRMED';
  const [message, delivery] = SEND_FAILURES[key];
  return Object.assign(new Error(message), { code: key, delivery, outcome: delivery === 'unknown' ? 'unknown' : 'failed' });
}

// 不接收协议端 file 参数：只能把本次提供的文字在内存中编码，不能读路径或代抓 URL。
export function preparePrivateTextFile(args, platform = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => key !== 'text' && key !== 'name')) {
    throw new Error('只支持 text 和 name 参数，不能指定地址、路径或接收人');
  }
  const { text, name = 'notes.txt' } = args;
  const limitKiB = privateFileMaxKiB(platform);
  const maxBytes = limitKiB * 1024;
  if (typeof text !== 'string' || text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes || !text.trim()) {
    throw new Error(`正文必须是非空文字，UTF-8 大小不能超过 ${limitKiB} KiB`);
  }
  // 文件名是一个 basename；跨平台保守取交集，避免目录、设备名和伪装的可执行文件。
  if (typeof name !== 'string' || name.length > 120 || Buffer.byteLength(name, 'utf8') > 120
    || /^[.\s]/u.test(name) || /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)
    || /[.\s]$/u.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
    || !/\.(txt|md|csv|json)$/i.test(name)) {
    throw new Error('文件名须为安全的单个文件名（最多 120 字节），扩展名只支持 txt/md/csv/json');
  }
  return { name, bytes: Buffer.byteLength(text, 'utf8'), file: `base64://${Buffer.from(text, 'utf8').toString('base64')}` };
}
