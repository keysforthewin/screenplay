export async function shouldIgnoreMessage(msg, botUserId) {
  const mentionsBot = msg.mentions?.users?.has?.(botUserId) ?? false;
  if (mentionsBot) return false;

  const userMentions = msg.mentions?.users;
  if (userMentions && userMentions.size > 0) return true;

  if (msg.mentions?.everyone) return true;

  if ((msg.mentions?.roles?.size ?? 0) > 0) return true;

  const ref = msg.reference;
  const isPlainReply = ref?.messageId && (ref.type === undefined || ref.type === 0);
  if (isPlainReply) {
    try {
      const referenced = await msg.fetchReference();
      const replyAuthorId = referenced?.author?.id;
      if (replyAuthorId && replyAuthorId !== botUserId) return true;
    } catch {
      // Fail open — if we can't fetch the referenced message, process normally.
    }
  }

  return false;
}
