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
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a new party event")
      .addStringOption((opt) => {
        let o = opt.setName("event")
          .setDescription("Choose an event template")
          .setRequired(true);
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
          .setName("tz_offset")
          .setDescription("Your UTC offset, e.g. +13, +13:45, +08, -05")
          .setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("min_gs")
          .setDescription("Minimum Gear Score required to join (blank = no minimum)")
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(50000)
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("Optional description").setRequired(false)
      )
  )
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
  function parseUtcOffsetToTZSuffix(raw) {
    if (!raw) return null;
    const m = String(raw).trim().match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!m) return null;
    const sign = m[1] === "-" ? "-" : "+";
    const hh = String(m[2]).padStart(2, "0");
    const mm = String(m[3] ?? "00").padStart(2, "0");
    // Limit sanity: HH 00..14, MM 00 or 15/30/45 (handles weird zones like +12:45)
    const H = Number(hh), M = Number(mm);
    if (H < 0 || H > 14) return null;
    if (![0,15,30,45].includes(M)) return null;
    return `${sign}${hh}:${mm}`;
  }

  const allowed = process.env.DISCORD_PARTY_CHANNEL_ID;
  if (!allowed || interaction.channelId !== allowed) {
    return interaction.reply({
      content: `⛔ This command can only be used in <#${allowed || "SET_DISCORD_PARTY_CHANNEL_ID"}>.`,
      ephemeral: true,
    });
  }

  const sub = interaction.options.getSubcommand();

  // -----------------------------
  // /party create
  // -----------------------------
  if (sub === "create") {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply(); // not ephemeral
    }
    try {
      const eventKey = interaction.options.getString("event");
      const dateStr = interaction.options.getString("date")?.trim();
      const timeStr = interaction.options.getString("time")?.trim();
      const tzRaw = interaction.options.getString("tz_offset")?.trim()
        || null;
      const tzSuffix = parseUtcOffsetToTZSuffix(tzRaw);
      const minGs = interaction.options.getInteger("min_gs") ?? null;
      const desc = interaction.options.getString("description")?.trim() || undefined;

      // 🔐 Host GS validation (main character must meet Min GS if provided)
      if (minGs != null) {
        // Fetch host's MAIN character
        const mainChar = (await exec(
          `SELECT c.gear_score AS gs, LOWER(cl.role) AS role
            FROM characters c
            JOIN classes cl ON cl.id = c.class_id
            WHERE c.user_id = ? AND c.guild_id = ? AND c.is_main = 1
            LIMIT 1;`,
          [interaction.user.id, interaction.guild.id]
        ))[0];

        if (!mainChar) {
          return interaction.editReply({
            content:
              `⛔ You set a Minimum GS of **${minGs}**, but you don’t have a **main** character.\n` +
              `Add one with **/character add** (tick “main”) or remove the minimum.`,
          });
        }
        if ((mainChar.gs ?? 0) < minGs) {
          // Optional: show their best GS across all chars to help them decide
          const best = (await exec(
            `SELECT MAX(c.gear_score) AS best_gs
              FROM characters c
              WHERE c.user_id = ? AND c.guild_id = ?;`,
            [interaction.user.id, interaction.guild.id]
          ))[0]?.best_gs ?? 0;

          return interaction.editReply({
            content:
              `⛔ Your main character’s GS is **${mainChar.gs ?? 0}**, below the Min GS **${minGs}**.\n` +
              `Your highest character GS is **${best}**. Either set that one as main with **/character add --main true** (or **/character setgs** as needed), or lower the Min GS.`,
          });
        }
      }

      if (!tzSuffix) {
        return interaction.editReply({
          content:
            "⚠️ No valid UTC offset provided, so your date/time was interpreted in the server's timezone. " +
            "Next time, add **tz_offset** (e.g. `+13`, `+08:30`, `-05`). " +
            "Tip: set `DEFAULT_TZ_OFFSET` in the bot env for a sensible default.",
        });
      }
      
      const template = templateMap.get(eventKey);
      if (!template) return interaction.editReply({ content: "❌ Unknown event template." });

      const localISO = `${dateStr}T${timeStr}:00${tzSuffix ?? ""}`;
      const start = new Date(localISO);
      if (Number.isNaN(start.getTime())) {
        return interaction.editReply({ content: "❌ Invalid date/time." });
      }
      if (start.getTime() < Date.now() + 30_000) {
        return interaction.editReply({ content: "❌ Start time must be in the future." });
      }
      const startUtc = start.toISOString();
      const unix = Math.floor(start.getTime() / 1000);

      const eventId = shortId("evt");
      const guildId = interaction.guild.id;
      const channelId = interaction.channel.id;
      const creatorId = interaction.user.id;
      const nowIso = new Date().toISOString();

      // create event
      await exec(
        `INSERT INTO events
         (id, guild_id, channel_id, message_id, thread_id, voice_channel_id,
          template_id, title, description, image_url, start_time_utc, reminder_offset_m,
          status, creator_id, created_at_utc, updated_at_utc, min_gear_score)
         VALUES (?, ?, ?, '', '', '',
                 ?, ?, ?, ?, ?, 10, 'open', ?, ?, ?, ?);`,
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
          minGs,
        ]
      );

      // insert lanes for this event
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

      // load lanes (for embed + auto-signup)
      const lanes = await exec(
        `SELECT id, lane_key, name, emoji, capacity, sort_order
           FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
        [eventId]
      );

      // 🔹 auto-signup host using their MAIN character (if any)
      // get main character (role + GS)
      const mainChar = (await exec(
        `SELECT c.gear_score AS gs, LOWER(cl.role) AS role
           FROM characters c
           JOIN classes cl ON cl.id = c.class_id
          WHERE c.user_id = ? AND c.guild_id = ? AND c.is_main = 1
          LIMIT 1;`,
        [creatorId, guildId]
      ))[0];

      let creatorAutoLaneId = null;
      let creatorAutoGS = null;

      if (mainChar) {
        const lane = lanes.find((l) => (l.lane_key || "").toLowerCase() === (mainChar.role || ""));
        if (lane) {
          // If event has min GS, assume host meets it (per your request), but we still store their GS.
          await exec(
            `INSERT INTO signups (event_id, lane_id, user_id, gear_score, joined_at_utc)
             VALUES (?, ?, ?, ?, datetime('now'));`,
            [eventId, lane.id, creatorId, mainChar.gs ?? null]
          );
          creatorAutoLaneId = lane.id;
          creatorAutoGS = mainChar.gs ?? null;
        }
      }

      // build signups-by-lane map for embed
      const signupsByLane = new Map(lanes.map((l) => [l.id, []]));
      if (creatorAutoLaneId) {
        signupsByLane.get(creatorAutoLaneId).push({
          user_id: creatorId,
          gear_score: creatorAutoGS,
        });
      }

      eventCache.set(eventId, {
        title: template.name,
        description: desc,
        image_url: template.image_url || undefined,
        unix,
        creator_id: creatorId,
        channel_id: channelId,
        message_id: "",
      });

      // 🔹 make sure minGs always appears on the embed
      const embed = buildEventEmbedDetail({
        title: template.name,
        description: desc,
        image_url: template.image_url || undefined,
        unix,
        lanes,
        signupsByLane,
        creatorId,
        status: "open",
        minGs,
      });

      // build buttons
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

      // post message
      await interaction.editReply({ embeds: [embed], components: [joinRow, controls] });
      const msg = await interaction.fetchReply();

      // create thread + voice channel
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

      await exec(
        `UPDATE events
           SET message_id=?, thread_id=?, voice_channel_id=?, updated_at_utc=?
         WHERE id=?;`,
        [msg.id, threadId, vcId, new Date().toISOString(), eventId]
      );

      const cached = eventCache.get(eventId);
      if (cached) eventCache.set(eventId, { ...cached, message_id: msg.id });

      // If the host had no main character or no matching lane, give an FYI (but event still created)
      if (!mainChar) {
        await interaction.followUp({
          content: "ℹ️ Party created. You don’t have a **main** character set—use `/character add ... --main true` to mark one.",
          ephemeral: true,
        });
      }

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
                title, description, image_url, start_time_utc, status, creator_id, min_gear_score
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
          `SELECT lane_id, user_id, gear_score
           FROM signups WHERE event_id=? ORDER BY joined_at_utc ASC;`,
          [eventId]
        );

        const signupsByLane = new Map(lanes.map((l) => [l.id, []]));
        for (const r of signupRows) {
          signupsByLane.get(r.lane_id).push({
            user_id: r.user_id,
            gear_score: r.gear_score,
          });
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
          minGs: ev.min_gear_score,
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
  const allowed = process.env.DISCORD_PARTY_CHANNEL_ID;
  if (!allowed || interaction.channelId !== allowed) {
    // Refuse to suggest outside the allowed channel
    return interaction.respond([]);
  }

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
