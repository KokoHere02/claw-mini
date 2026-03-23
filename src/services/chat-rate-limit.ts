const chatRateLimit = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of chatRateLimit) {
    if (now - ts > 5_000) chatRateLimit.delete(id);
  }
}, 10_000);

export function isChatRateLimited(chatId: string, now = Date.now()): boolean {
  const lastTs = chatRateLimit.get(chatId) ?? 0;
  if (now - lastTs < 5_000) {
    return true;
  }

  chatRateLimit.set(chatId, now);
  return false;
}
