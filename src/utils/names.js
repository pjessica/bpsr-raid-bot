// Simple in-memory cache for display names
const nameCache = new Map(); // key: `${guildId}:${userId}` -> displayName

export async function resolveDisplayNames(client, guildId, userIds) {
  const results = new Map();
  const guild = await client.guilds.fetch(guildId);

  await Promise.all(userIds.map(async (uid) => {
    const key = `${guildId}:${uid}`;
    if (nameCache.has(key)) {
      results.set(uid, nameCache.get(key));
      return;
    }
    try {
      const member = await guild.members.fetch(uid);
      const name = member?.displayName || member?.user?.username || uid;
      nameCache.set(key, name);
      results.set(uid, name);
    } catch {
      // fallback if user not resolvable (left server etc.)
      results.set(uid, uid);
    }
  }));

  return results; // Map<userId, displayName>
}
