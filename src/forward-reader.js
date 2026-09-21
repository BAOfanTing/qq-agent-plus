// Resolve the resource ID from the received card (or a fresh get_msg result).
// SnowLuma 1.14.15 accepts {id}; passing the QQ message ID alone can return
// "download forward message payload is empty" even for a newly received card.
function nodes(result) {
  return Array.isArray(result?.messages) ? result.messages
    : Array.isArray(result?.data?.messages) ? result.data.messages : [];
}

export async function readForwardMessages(onebot, messageId, segments) {
  let message = segments;
  if (!Array.isArray(message)) {
    try {
      const result = await onebot.call('get_msg', { message_id: Number(messageId) });
      message = result?.message ?? result?.data?.message;
    } catch { /* Older adapters may only support lookup by message_id. */ }
  }
  const id = Array.isArray(message)
    ? message.find((segment) => segment?.type === 'forward' && segment.data?.id)?.data.id
    : null;
  if (id) {
    try {
      const messages = nodes(await onebot.call('get_forward_msg', { id: String(id) }));
      if (messages.length) return messages;
    } catch (error) {
      // Compatibility fallback is limited to a rejected/empty resource lookup.
      // Authentication and transport failures must remain visible.
      if (error?.retcode !== 100) throw error;
    }
  }
  return nodes(await onebot.call('get_forward_msg', { message_id: Number(messageId) }));
}
