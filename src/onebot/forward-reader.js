// 合并转发的读取：先拿"转发资源 id"，再向 OneBot 要节点列表。
//
// 为什么要走资源 id（2026-09-21，SnowLuma v1.14.15 实测）：新收到的转发卡片用
// get_forward_msg({ message_id }) 查会返回 `retcode=100 download forward message
// payload is empty`，用卡片里的资源 id 查才能拿到内容。资源 id 从当前事件或 get_msg
// 现取，所以是新鲜的；存档里存的是消息 id（资源 id 会过期，不能存）。
//
// 但老适配器/老版本只认 message_id，所以资源 id 这条路失败（报错或空结果）时一律
// 回落 message_id —— 回落也失败才把错误抛出去，不至于把能读的场景读坏。
function nodes(result) {
  return Array.isArray(result?.messages) ? result.messages
    : Array.isArray(result?.data?.messages) ? result.data.messages : [];
}

/**
 * @param onebot  OneBot 客户端（只用它的 call）
 * @param messageId  转发卡片自己的 QQ 消息 id（存档里那个 #数字）
 * @param segments  可选：收消息时的原始段数组，有就直接从里面取资源 id
 */
export async function readForwardMessages(onebot, messageId, segments) {
  let message = segments;
  if (!Array.isArray(message)) {
    // 工具路径（读存档）只给了消息 id：get_msg 取回卡片拿到资源 id。
    // 取不到不算错误 —— 老适配器可能不支持 get_msg，直接走下面的兼容路径。
    try {
      const result = await onebot.call('get_msg', { message_id: Number(messageId) });
      message = result?.message ?? result?.data?.message;
    } catch { /* 兼容路径见文件头 */ }
  }
  const id = Array.isArray(message)
    ? message.find((segment) => segment?.type === 'forward' && segment.data?.id)?.data.id
    : null;
  if (id) {
    try {
      const messages = nodes(await onebot.call('get_forward_msg', { id: String(id) }));
      if (messages.length) return messages;
    } catch { /* 回落 message_id */ }
  }
  return nodes(await onebot.call('get_forward_msg', { message_id: Number(messageId) }));
}
