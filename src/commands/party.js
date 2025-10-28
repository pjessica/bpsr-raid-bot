// src/commands/party.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from "discord.js";
import { exec } from "../db/d1Client.js";
import { shortId } from "../utils/id.js";
import { buildEventEmbedDetail } from "../utils/embeds.js";
import { eventCache } from "../state/cache.js";
import { isManager } from "../utils/perm.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load templates once at boot (restart to refresh)
const templates = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "events_templates.json"), "utf8")
);

// (6) Precompute template map for O(1) access
const templateMap = new Map(templates.events.map((t) => [t.id, t]));

// (5) Channel name cache for autocomplete
const channelNameCache = new Map(); // id -> { name, ts }
const CHANNEL_TTL_MS = 10 * 60 * 1000;
function getCachedChannelName(id) {
  const hit = channelNameCache.get(id);
  if (hit && Date.now() - hit.ts < CHANNEL_TTL_MS) return hit.name;
  return null;
}
function setCachedChannelName(id, name) {
  channelNameCache.set(id, { name, ts: Date.now() });
}

export const data = new SlashCommandBuilder()
  .setName("party")
  .setDescription("Create or manage parties")
  // /party create
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a new party event")
      .addStringOption((opt) => {
        let o = opt.setName("event").setDescription("Choose an event template").setRequired(true);
        for (const t of templates.events.slice(0, 25)) {
          o = o.addChoices({ name: t.name, value: t.id });
        }
        return o;
      })
      .addStringOption((opt) =>
        opt.setName("date").setDescription("YYYY-MM-DD (creator's local time)").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("time").setDescription("HH:mm (24h)").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("my_role")
          .setDescription("Your role in this party")
          .setRequired(true)
          .addChoices(
            { name: "Tank", value: "tank" },
            { name: "DPS", value: "dps" },
            { name: "Support", value: "support" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("Optional description").setRequired(false)
      )
  )
  // /party close
  .addSubcommand((sub) =>
    sub
      .setName("close")
      .setDescription("Close a party (delete VC, lock thread, disable sign-ups)")
      .addStringOption((opt) =>
        opt
          .setName("event")
          .setDescription("Select the party to close")
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // -----------------------------
  // /party create
  // -----------------------------
  if (sub === "create") {
    await interaction.deferReply(); // acknowledge ASAP
    try {
      // Inputs
      const eventKey = interaction.options.getString("event");
      const dateStr = interaction.options.getString("date")?.trim();
      const timeStr = interaction.options.getString("time")?.trim();
      const chosenRole = interaction.options.getString("my_role");
      const desc = interaction.options.getString("description")?.trim() || undefined;

      // Validate template
      const template = templateMap.get(eventKey);
      if (!template) {
        await interaction.editReply({ content: "❌ Unknown event template." });
        return;
      }
      if (!Array.isArray(template.lanes) || template.lanes.length === 0) {
        await interaction.editReply({
          content: "❌ Template has no lanes configured. Please fix `events_templates.json`.",
        });
        return;
      }
      for (const [i, l] of template.lanes.entries()) {
        if (
          !l ||
          typeof l.key !== "string" ||
          typeof l.name !== "string" ||
          !Number.isFinite(Number(l.capacity))
        ) {
          await interaction.editReply({
            content: `❌ Lane #${i + 1} is invalid. Each lane needs { key, name, capacity } (emoji optional).`,
          });
          return;
        }
      }

      // Validate date/time
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
        await interaction.editReply({
          content: "❌ Invalid date/time. Use **YYYY-MM-DD** and **HH:mm** (24h).",
        });
        return;
      }
      const localISO = `${dateStr}T${timeStr}:00`;
      const start = new Date(localISO);
      if (Number.isNaN(start.getTime())) {
        await interaction.editReply({ content: "❌ Could not parse the date/time you entered." });
        return;
      }
      if (start.getTime() < Date.now() + 30_000) {
        await interaction.editReply({
          content: "❌ Start time must be in the future. Please pick a later time.",
        });
        return;
      }
      const startUtc = start.toISOString();
      const unix = Math.floor(start.getTime() / 1000);

      // Insert event
      const eventId = shortId("evt");
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const creatorId = interaction.user.id;
      const nowIso = new Date().toISOString();

      await exec(
        `INSERT INTO events
         (id, guild_id, channel_id, message_id, thread_id, voice_channel_id,
          template_id, title, description, image_url, start_time_utc, reminder_offset_m,
          status, creator_id, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, '', '', '',
                 ?, ?, ?, ?, ?, 10, 'open', ?, ?, ?);`,
        [
          eventId,
          guildId,
          channelId,
          template.id,
          template.name,
          desc,
          template.image_url || undefined,
          startUtc,
          creatorId,
          nowIso,
          nowIso,
        ]
      );

      // (2) Bulk insert lanes in one statement
      {
        const values = [];
        const params = [];
        template.lanes.forEach((l, i) => {
          values.push("(?, ?, ?, ?, ?, ?)");
          params.push(eventId, l.key, l.name, l.emoji || "", Number(l.capacity), i);
        });
        await exec(
          `INSERT INTO lanes (event_id, lane_key, name, emoji, capacity, sort_order)
           VALUES ${values.join(",")};`,
          params
        );
      }

      // Fetch lanes
      const lanes = await exec(
        `SELECT id, lane_key, name, emoji, capacity, sort_order
         FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
        [eventId]
      );

      // Auto-signup creator
      const laneRow = await exec(
        `SELECT id FROM lanes WHERE event_id = ? AND lane_key = ? LIMIT 1;`,
        [eventId, chosenRole]
      );
      if (laneRow[0]) {
        await exec(
          `INSERT INTO signups (event_id, lane_id, user_id, joined_at_utc)
           VALUES (?, ?, ?, datetime('now'));`,
          [eventId, laneRow[0].id, creatorId]
        );
      }

      // Build signups-by-lane (reflecting creator)
      const signupsByLane = new Map(lanes.map((l) => [l.id, []]));
      if (laneRow[0]) {
        signupsByLane.get(laneRow[0].id).push(creatorId);
      }

      // Cache static display info
      eventCache.set(eventId, {
        title: template.name,
        description: desc,
        image_url: template.image_url || undefined,
        unix,
        creator_id: creatorId,
        channel_id: channelId,
        message_id: "", // set after send
      });

      // Build embed
      const embed = buildEventEmbedDetail({
        title: template.name,
        description: desc,
        image_url: template.image_url || undefined,
        unix,
        lanes,
        signupsByLane,
        creatorId,
        status: "open",
      });

      // Buttons (one row for joins + controls row)
      const joinRow = new ActionRowBuilder().addComponents(
        ...lanes.map((l) =>
          new ButtonBuilder()
            .setCustomId(`join:${eventId}:${l.lane_key}:v1`)
            .setLabel(`${String(l.emoji ?? "").trim()} ${String(l.name ?? "Role")}`.trim())
            .setStyle(ButtonStyle.Primary)
        )
      );
      const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`leave:${eventId}:v1`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mgr:${eventId}:v1`).setLabel("⚙️ Manage").setStyle(ButtonStyle.Secondary)
      );

      // Send message
      await interaction.editReply({ embeds: [embed], components: [joinRow, controls] });
      const msg = await interaction.fetchReply();

      // (3) Start thread + create VC in parallel
      const display = interaction.member?.displayName || interaction.user.username;
      const vcName = `${display}'s – ${template.name}`;
      const categoryId = process.env.DISCORD_PARTY_VOICE_CATEGORY_ID || null;

      const [threadRes, vcRes] = await Promise.allSettled([
        msg.startThread({ name: `party-${eventId}`, autoArchiveDuration: 1440 }),
        interaction.guild.channels.create({
          name: vcName,
          type: ChannelType.GuildVoice,
          parent: categoryId || undefined,
        }),
      ]);

      const threadId = threadRes.status === "fulfilled" ? threadRes.value.id : "";
      const vcId = vcRes.status === "fulfilled" ? vcRes.value.id : "";

      // Update event with message/thread/voice IDs
      await exec(
        `UPDATE events
           SET message_id=?, thread_id=?, voice_channel_id=?, updated_at_utc=?
         WHERE id=?;`,
        [msg.id, threadId, vcId, new Date().toISOString(), eventId]
      );

      // Update cache
      const cached = eventCache.get(eventId);
      if (cached) eventCache.set(eventId, { ...cached, message_id: msg.id });

      return;
    } catch (err) {
      console.error("💥 /party create error:", err);
      try {
        await interaction.editReply({ content: "❌ Failed to create party. Check logs." });
      } catch {}
      return;
    }
  }

  // -----------------------------
  // /party close
  // -----------------------------
  if (sub === "close") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const eventId = interaction.options.getString("event");
      const rows = await exec(
        `SELECT id, guild_id, channel_id, message_id, thread_id, voice_channel_id,
                title, description, image_url, start_time_utc, status, creator_id
         FROM events WHERE id=?;`,
        [eventId]
      );
      if (!rows.length) {
        await interaction.editReply({ content: "❌ Party not found." });
        return;
      }
      const ev = rows[0];

      if (!isManager({ interaction, eventCreatorId: ev.creator_id })) {
        await interaction.editReply({ content: "⛔ You don’t have permission to close this party." });
        return;
      }

      if (ev.status !== "open") {
        await interaction.editReply({ content: `ℹ️ This party is already **${ev.status}**.` });
        return;
      }

      // Mark closed
      await exec(`UPDATE events SET status='closed', updated_at_utc=datetime('now') WHERE id=?;`, [eventId]);

      // Delete VC (best-effort)
      if (ev.voice_channel_id) {
        try {
          const vc = await interaction.client.channels.fetch(ev.voice_channel_id);
          if (vc) await vc.delete("Party closed");
        } catch {}
      }

      // Archive + lock thread (best-effort)
      if (ev.thread_id) {
        try {
          const thread = await interaction.client.channels.fetch(ev.thread_id);
          if (thread?.isThread()) {
            await thread.setArchived(true, "Party closed");
            if (thread.setLocked) await thread.setLocked(true, "Party closed");
          }
        } catch {}
      }

      // Rebuild embed with lanes + signups preserved
      try {
        const channel = await interaction.client.channels.fetch(ev.channel_id);
        const msg = await channel.messages.fetch(ev.message_id);

        const lanes = await exec(
          `SELECT id, lane_key, name, emoji, capacity, sort_order
           FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
          [eventId]
        );
        const signupRows = await exec(
          `SELECT lane_id, user_id
           FROM signups WHERE event_id=? ORDER BY joined_at_utc ASC;`,
          [eventId]
        );
        const signupsByLane = new Map(lanes.map((l) => [l.id, []]));
        for (const r of signupRows) {
          signupsByLane.get(r.lane_id)?.push(r.user_id);
        }

        const unix = Math.floor(new Date(ev.start_time_utc).getTime() / 1000);
        const closedEmbed = buildEventEmbedDetail({
          title: ev.title,
          description: ev.description || undefined,
          image_url: ev.image_url || undefined,
          unix,
          lanes,
          signupsByLane,
          creatorId: ev.creator_id,
          status: "closed",
        });

        await msg.edit({ embeds: [closedEmbed], components: [] }); // disable all buttons
      } catch (e) {
        console.warn("⚠️ Could not edit closed event message:", e.message);
      }

      eventCache.delete(eventId);
      await interaction.editReply({ content: `✅ Closed **${ev.title}**.` });
      return;
    } catch (err) {
      console.error("💥 /party close error:", err);
      try {
        await interaction.editReply({ content: "❌ Failed to close party. Check logs." });
      } catch {}
      return;
    }
  }
}

// -----------------------------
// Autocomplete for /party close (guild-wide, cached channel names)
// -----------------------------
export async function autocomplete(interaction) {
  try {
    if (interaction.options.getSubcommand() !== "close") return;

    const rows = await exec(
      `SELECT id, title, start_time_utc, channel_id
       FROM events
       WHERE guild_id=? AND status='open'
       ORDER BY created_at_utc DESC
       LIMIT 25;`,
      [interaction.guild.id]
    );

    // Resolve channel names via cache, fetch missing ones
    await Promise.all(
      rows.map(async (r) => {
        if (!getCachedChannelName(r.channel_id)) {
          try {
            const ch = await interaction.client.channels.fetch(r.channel_id);
            setCachedChannelName(r.channel_id, ch?.name || "#unknown");
          } catch {
            setCachedChannelName(r.channel_id, "#unknown");
          }
        }
      })
    );

    const focused = (interaction.options.getFocused() || "").toLowerCase();
    const choices = rows
      .map((r) => {
        const when = new Date(r.start_time_utc).toLocaleString();
        const ch = getCachedChannelName(r.channel_id);
        return {
          name: `${r.title} — ${when}  •  #${ch}  •  ${r.id.slice(0, 6)}`,
          value: r.id,
        };
      })
      .filter((c) => !focused || c.name.toLowerCase().includes(focused))
      .slice(0, 25);

    await interaction.respond(choices);
  } catch {
    // ignore autocomplete errors
  }
}
