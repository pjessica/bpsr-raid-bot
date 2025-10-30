export async function logPartyAction(db, {
  guildId,
  partyId,
  action,             // 'join' | 'leave' | 'remove'
  actorNickname,
  memberNickname,
  reason = null,
}) {
  try {
    await db.prepare(`
      INSERT INTO party_logs
      (guild_id, party_id, action, actor_nickname, member_nickname, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(guildId, partyId, action, actorNickname, memberNickname, reason)
    .run();
  } catch (err) {
    console.error("Failed to log party action:", err);
  }
}
