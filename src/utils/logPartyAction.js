import { exec } from "../db/client.js"; // adjust the path as needed

export async function logPartyAction({
  guildId,
  partyId,
  action,             // 'join' | 'leave' | 'remove' | 'switch'
  actorNickname,
  memberNickname,
  reason = null,
}) {
  try {
    await exec(
      `INSERT INTO party_logs
       (guild_id, party_id, action, actor_nickname, member_nickname, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [guildId, partyId, action, actorNickname, memberNickname, reason]
    );
  } catch (err) {
    console.error("⚠️ Failed to log party action:", err);
  }
}
