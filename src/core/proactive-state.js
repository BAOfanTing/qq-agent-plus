// 主动开话题的"上次判定时间"：群聊和私聊各记一份。
//
// 旧版只有一个全局 lastAttemptAt，群聊和私聊共用同一次机会：群的机会可能被私聊占掉，
// 反过来也一样。现在两个范围各自排程、各自掷骰、各自记录，互不占用。
//
// 状态文件保持向后兼容：旧格式 `{lastAttemptAt: 123}` 读出来会同时作为群聊和私聊的
// 上次判定时间，升级后的第一轮不会因为"没有记录"而额外多开一次话题。
import fs from 'node:fs';

/** 读状态文件；损坏/缺失按 0 处理。旧数字格式迁移成两个范围共用。 */
export function readProactiveAttempts(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = raw?.lastAttemptAt;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        group: Number(value.group) || 0,
        private: Number(value.private) || 0
      };
    }
    const legacy = Number(value) || 0;
    return { group: legacy, private: legacy };
  } catch {
    return { group: 0, private: 0 };
  }
}

/** 只更新一个范围，另一个范围的时间保持不变；原子写，避免半个 JSON 落盘。 */
export function writeProactiveAttempt(file, scope, ts) {
  const key = scope === 'private' ? 'private' : 'group';
  try {
    const current = readProactiveAttempts(file);
    current[key] = Number(ts) || Date.now();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastAttemptAt: current }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 写不进去也不影响正常发言 */ }
}
