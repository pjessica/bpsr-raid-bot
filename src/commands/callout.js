// src/commands/callout.js
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { exec } from "../db/d1Client.js";

// Global cooldown tracker (event_id -> timestamp)
const calloutCooldowns = new Map();

// Read cooldown from ENV (default 5 min)
const CALLOUT_COOLDOWN_MS = Number(process.env.CALLOUT_COOLDOWN_MS ?? 60000);

export const data = new SlashCommandBuilder()
  .setName("callout")
  .setDescription("Tag everyone signed up for this party (use inside the party thread only)");

export async function execute(interaction) {
  // Defer ASAP so Discord never times out
  await interaction.deferReply({ flags: 64 }); // ephemeral
  console.log("🟦 /callout execute hit");

  try {
    // Must be in a guild + thread
    if (!interaction.inGuild?.() || interaction.channel?.isThread?.() !== true) {
      await interaction.editReply({ content: "❌ Use this **inside the party’s thread**." });
      return;
    }

    // Perms: send in thread
    const me = interaction.guild?.members?.me;
    const perms = interaction.channel.permissionsFor(me || interaction.client.user);
    if (!perms?.has(PermissionFlagsBits.SendMessagesInThreads)) {
      await interaction.editReply({ content: "⛔ I need **Send Messages in Threads** here." });
      return;
    }

    // Find event by thread
    const ev = (await exec(
      `SELECT id, title, voice_channel_id, start_time_utc, status, creator_id
         FROM events
        WHERE thread_id = ?;`,
      [interaction.channel.id]
    ))?.[0];

    if (!ev) {
      await interaction.editReply({ content: "❌ This thread isn’t linked to any party." });
      return;
    }

    if (ev.status !== "open") {
      await interaction.editReply({ content: "🔒 This party is not open. Callout aborted." });
      return;
    }

    const now = Date.now();
    const last = calloutCooldowns.get(ev.id) || 0;
    const diff = now - last;
    if (diff < CALLOUT_COOLDOWN_MS) {
        const remainingSec = Math.ceil((CALLOUT_COOLDOWN_MS - diff) / 1000);
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;

        const pretty = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        await interaction.editReply({
            content: `⏳ Please wait **${pretty}** before calling out again.`,
        });
        return;
    }

    calloutCooldowns.set(ev.id, now);

    // Collect signups
    const rows = await exec(
      `SELECT DISTINCT user_id
         FROM signups
        WHERE event_id = ?
        ORDER BY joined_at_utc ASC;`,
      [ev.id]
    );
    const userIds = rows.map(r => String(r.user_id)).filter(Boolean);

    if (userIds.length === 0) {
      await interaction.editReply({ content: "ℹ️ No one has signed up yet." });
      return;
    }

    const unix = Math.floor(new Date(ev.start_time_utc).getTime() / 1000);
    const vcLink = ev.voice_channel_id ? `<#${ev.voice_channel_id}>` : "";
    const title = ev.title || "Party";

    const header =
      `📣 **Callout** — **${title}** starts <t:${unix}:R>\n` +
      (vcLink ? `Join VC: ${vcLink}\n` : "") +
      `Host: <@${ev.creator_id}>\n\n` +
      `**Signed-up players:**`;

    // Split mentions into safe chunks
    const chunks = [];
    let buf = [];
    let len = header.length;
    const MAX = 1500;

    for (const uid of userIds) {
      const mention = `<@${uid}>`;
      if (len + mention.length + 1 > MAX) {
        chunks.push(buf.join(" "));
        buf = [mention];
        len = mention.length;
      } else {
        buf.push(mention);
        len += mention.length + 1;
      }
    }
    if (buf.length) chunks.push(buf.join(" "));

    // Post header (no pings)
    await interaction.channel.send({
      content: header,
      allowedMentions: { parse: [], users: [] },
    });

    // Post mention chunks with explicit allow-list
    for (const part of chunks) {
      const ids = [...part.matchAll(/<@(\d+)>/g)].map(m => m[1]);
      await interaction.channel.send({
        content: part,
        allowedMentions: { parse: [], users: ids },
      });
    }

    await interaction.editReply({ content: `✅ Called out ${userIds.length} player(s).` });
  } catch (err) {
    console.error("💥 /callout error:", err);
    try {
      await interaction.editReply({ content: "❌ Callout failed. Check bot permissions & logs." });
    } catch {}
  }
}
