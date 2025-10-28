// src/interactions/modals.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "../db/d1Client.js";
import { shortId } from "../utils/id.js";
import { buildEventEmbedDetail } from "../utils/embeds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templates = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "events_templates.json"), "utf8")
);

export async function handleModalSubmit(interaction) {
  if (!interaction.isModalSubmit()) return;
  const customId = interaction.customId || "";
  if (!customId.startsWith("startdesc:")) return;

  console.log("🟦 Modal received:", customId);

  try {
    const eventKey = customId.split(":")[1];
    console.log("➡️  Event key:", eventKey);

    // 1) Extract fields
    const dateStr = (interaction.fields.getTextInputValue("date") || "").trim();
    const timeStr = (interaction.fields.getTextInputValue("time") || "").trim();
    const desc = (interaction.fields.getTextInputValue("desc_text") || "").trim();

    console.log("➡️  User input:", { dateStr, timeStr, desc });

    // 2) Parse date/time
    const localISO = `${dateStr}T${timeStr}:00`;
    const start = new Date(localISO);
    if (Number.isNaN(start.getTime())) {
      console.log("❌ Invalid date/time parse:", localISO);
      return interaction.reply({
        content: "❌ Could not parse date/time. Use YYYY-MM-DD + HH:mm.",
        ephemeral: true,
      });
    }

    const startUtc = start.toISOString();
    const unix = Math.floor(start.getTime() / 1000);
    console.log("✅ Parsed time:", startUtc, unix);

    // 3) Find template
    const template = templates.events.find((t) => t.id === eventKey);
    if (!template) {
      console.log("❌ Template not found:", eventKey);
      return interaction.reply({
        content: "❌ Unknown event template.",
        ephemeral: true,
      });
    }

    console.log("✅ Template loaded:", template.name);

    // 4) Insert event
    const eventId = shortId("evt");
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    const creatorId = interaction.user.id;
    const nowIso = new Date().toISOString();

    console.log("➡️  Inserting event into D1...");
    await exec(
      `INSERT INTO events
       (id, guild_id, channel_id, message_id, thread_id, voice_channel_id,
        template_id, title, description, image_url, start_time_utc,
        reminder_offset_m, status, creator_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, '', '', '',
               ?, ?, ?, ?, ?, 10, 'open', ?, ?, ?);`,
      [
        eventId,
        guildId,
        channelId,
        template.id,
        template.name,
        desc,
        template.image_url || "",
        startUtc,
        creatorId,
        nowIso,
        nowIso,
      ]
    );
    console.log("✅ Event inserted:", eventId);

    // 5) Insert lanes
    for (let i = 0; i < template.lanes.length; i++) {
      const l = template.lanes[i];
      await exec(
        `INSERT INTO lanes (event_id, lane_key, name, emoji, capacity, sort_order)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [eventId, l.key, l.name, l.emoji || "", l.capacity, i]
      );
    }
    console.log("✅ Lanes inserted");

    const lanes = await exec(
      `SELECT id, lane_key, name, emoji, capacity, sort_order
       FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
      [eventId]
    );

    const signupsByLane = new Map(lanes.map((l) => [l.id, []]));
    const embed = buildEventEmbedDetail({
      title: template.name,
      description: desc,
      image_url: template.image_url,
      unix,
      lanes,
      signupsByLane,
    });

    const joinRow = new ActionRowBuilder().addComponents(
      ...lanes.map((l) =>
        new ButtonBuilder()
          .setCustomId(`join:${eventId}:${l.lane_key}:v1`)
          .setLabel(`${l.emoji || ""} ${l.name}`.trim())
          .setStyle(ButtonStyle.Primary)
      )
    );
    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`leave:${eventId}:v1`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mgr:${eventId}:v1`).setLabel("⚙️ Manage").setStyle(ButtonStyle.Secondary)
    );

    console.log("➡️  Sending embed...");
    await interaction.reply({ embeds: [embed], components: [joinRow, controls] });
    const msg = await interaction.fetchReply();
    console.log("✅ Message sent:", msg.id);

    // Create thread
    let threadId = "";
    try {
      const thread = await msg.startThread({
        name: `party-${eventId}`,
        autoArchiveDuration: 1440,
      });
      threadId = thread.id;
      console.log("✅ Thread created:", threadId);
    } catch (e) {
      console.error("⚠️ Thread creation failed:", e.message);
    }

    // Create voice channel
    let vcId = "";
    try {
      const display = interaction.member?.displayName || interaction.user.username;
      const vcName = `${display}'s – ${template.name}`;
      const vc = await interaction.guild.channels.create({
        name: vcName,
        type: ChannelType.GuildVoice,
      });
      vcId = vc.id;
      console.log("✅ Voice channel created:", vcId);
    } catch (e) {
      console.error("⚠️ Voice channel creation failed:", e.message);
    }

    await exec(
      `UPDATE events
         SET message_id=?, thread_id=?, voice_channel_id=?, updated_at_utc=?
       WHERE id=?;`,
      [msg.id, threadId, vcId, new Date().toISOString(), eventId]
    );

    console.log("✅ Event updated successfully:", eventId);
  } catch (err) {
    console.error("💥 handleModalSubmit crashed:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ Internal error: ${err.message || err}`,
        ephemeral: true,
      });
    }
  }
}
