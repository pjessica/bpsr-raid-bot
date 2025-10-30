import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { exec } from "../db/d1Client.js";
import { buildEventEmbedDetail } from "../utils/embeds.js";
import { eventCache } from "../state/cache.js";
import { isManager } from "../utils/perm.js";
import { resolveDisplayNames } from "../utils/names.js";
import { logPartyAction } from "../utils/logPartyAction.js";

/** Build components based on capacity */
function buildComponents(eventId, lanes, signupsByLane) {
  const joinRow = new ActionRowBuilder().addComponents(
    ...lanes.map((l) => {
      const current = (signupsByLane.get(l.id) || []).length;
      const cap = Number(l.capacity) || 0;
      const full = cap > 0 && current >= cap;
      return new ButtonBuilder()
        .setCustomId(`join:${eventId}:${l.lane_key}:v1`)
        .setLabel(`${String(l.emoji ?? "").trim()} ${String(l.name ?? "Role")}`.trim())
        .setStyle(ButtonStyle.Primary)
        .setDisabled(full);
    })
  );

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leave:${eventId}:v1`)
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mgr:${eventId}:v1`)
      .setLabel("⚙️ Manage")
      .setStyle(ButtonStyle.Secondary)
  );

  return [joinRow, controls];
}

/** Get lanes + signups map in parallel */
async function getLanesAndSignups(eventId) {
  const [lanes, rows] = await Promise.all([
    exec(
      `SELECT id, lane_key, name, emoji, capacity, sort_order
       FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
      [eventId]
    ),
    exec(
      `SELECT lane_id, user_id, gear_score
       FROM signups
       WHERE event_id=?
       ORDER BY joined_at_utc ASC;`,
      [eventId]
    ),
  ]);

  const signupsByLane = new Map();
  for (const r of rows) {
    if (!signupsByLane.has(r.lane_id)) signupsByLane.set(r.lane_id, []);
    signupsByLane.get(r.lane_id).push({
      user_id: r.user_id,
      gear_score: r.gear_score,
    });
  }
  return { lanes, signupsByLane };
}

export async function handleButton(interaction) {
  if (!interaction.isButton()) return;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const [kind, eventId, laneKey] = (interaction.customId || "").split(":");
  if (!["join", "leave", "mgr"].includes(kind)) return;

  let ev = eventCache.get(eventId);
  if (!ev) {
    const row = (
      await exec(
        `SELECT title, description, image_url, start_time_utc, creator_id,
                channel_id, message_id, min_gear_score
           FROM events WHERE id=?;`,
        [eventId]
      )
    )[0];
    if (!row) {
      await interaction.editReply({});
      await interaction.followUp({
        content: "❌ This party no longer exists.",
        flags: 64,
      });
      return;
    }
    ev = {
      title: row.title,
      description: row.description,
      image_url: row.image_url,
      unix: Math.floor(new Date(row.start_time_utc).getTime() / 1000),
      creator_id: row.creator_id,
      channel_id: row.channel_id,
      message_id: row.message_id,
      min_gear_score: row.min_gear_score,
    };
    eventCache.set(eventId, ev);
  }

  try {
    if (kind === "join") {
      // Load event (need status + min GS + message pointers)
      const eventRow = (
        await exec(
          `SELECT e.id, e.min_gear_score, e.status, e.channel_id, e.message_id,
                  e.creator_id, e.title, e.description, e.image_url, e.start_time_utc
            FROM events e WHERE e.id=? LIMIT 1;`,
          [eventId]
        )
      )[0];

      if (!eventRow || eventRow.status !== "open") {
        return interaction.editReply({ content: "🔒 This party is closed." });
      }

      // Target lane
      const lane = (
        await exec(
          `SELECT id, lane_key, name, emoji, capacity
            FROM lanes WHERE event_id=? AND lane_key=? LIMIT 1;`,
          [eventId, laneKey]
        )
      )[0];
      if (!lane) return interaction.editReply({ content: "❌ Role not found." });

      const userId = interaction.user.id;
      const guildId = interaction.guild.id;

      // Best GS for this role
      const best = (
        await exec(
          `SELECT MAX(c.gear_score) AS gs
            FROM characters c
            JOIN classes cl ON cl.id=c.class_id
            WHERE c.user_id=? AND c.guild_id=? AND LOWER(cl.role)=LOWER(?);`,
          [userId, guildId, laneKey]
        )
      )[0];
      const gs = best?.gs ?? 0;

      if (eventRow.min_gear_score != null && gs < eventRow.min_gear_score) {
        return interaction.editReply({
          content: `⛔ Minimum GS **${eventRow.min_gear_score}**, your best **${laneKey}** GS is **${gs}**.`,
        });
      }

      // Existing signup?
      const existing = (
        await exec(
          `SELECT id, lane_id FROM signups WHERE event_id=? AND user_id=? LIMIT 1;`,
          [eventId, userId]
        )
      )[0];

      if (!existing) {
        // Fresh sign-up: try insert guarded by capacity
        await exec(
          `INSERT INTO signups (event_id, lane_id, user_id, gear_score, joined_at_utc)
          SELECT ?, ?, ?, ?, datetime('now')
            WHERE (SELECT COUNT(*) FROM signups WHERE event_id=? AND lane_id=?) <
                  (SELECT capacity FROM lanes WHERE id=?);`,
          [eventId, lane.id, userId, gs, eventId, lane.id, lane.id]
        );

        // ✅ DO NOT check .changes — verify with SELECT instead
        const verify = (
          await exec(
            `SELECT id FROM signups WHERE event_id=? AND user_id=? LIMIT 1;`,
            [eventId, userId]
          )
        )[0];
        if (!verify) {
          return interaction.editReply({ content: "⛔ That role is full." });
        }

        // Rebuild embed & components
        const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
        const components = buildComponents(eventId, lanes, signupsByLane);
        const unix = Math.floor(new Date(eventRow.start_time_utc).getTime() / 1000);
        const embed = buildEventEmbedDetail({
          title: eventRow.title,
          description: eventRow.description || undefined,
          image_url: eventRow.image_url || undefined,
          unix,
          lanes,
          signupsByLane,         // [{ user_id, gear_score }]
          creatorId: eventRow.creator_id,
          status: "open",
          minGs: eventRow.min_gear_score, // always show Min GS
        });

        const ch = await interaction.client.channels.fetch(eventRow.channel_id);
        const msg = await ch.messages.fetch(eventRow.message_id);
        await msg.edit({ embeds: [embed], components });
        
        await logPartyAction({
          guildId: interaction.guild.id,
          partyId: eventId,
          action: 'join',
          actorNickname: interaction.member?.displayName || interaction.user.username,
          memberNickname: interaction.member?.displayName || interaction.user.username,
          reason: lane.name,
        });

        return interaction.editReply({
          content: `✅ Signed up to **${lane.name}** (GS ${gs}).`,
        });
      }

      // Already signed up → same lane?
      if (existing.lane_id === lane.id) {
        return interaction.editReply({ content: `ℹ️ You’re already in **${lane.name}**.` });
      }

      // Switch lanes (capacity-guarded) — UPDATE then verify
      await exec(
        `UPDATE signups
            SET lane_id = ?, gear_score = ?
          WHERE id = ?
            AND (
              (SELECT COUNT(*) FROM signups WHERE event_id=? AND lane_id=?) <
              (SELECT capacity FROM lanes WHERE id=?)
            );`,
        [lane.id, gs, existing.id, eventId, lane.id, lane.id]
      );

      const switched = (
        await exec(
          `SELECT 1 FROM signups WHERE id=? AND lane_id=? LIMIT 1;`,
          [existing.id, lane.id]
        )
      )[0];

      if (!switched) {
        return interaction.editReply({ content: `⛔ **${lane.name}** is full.` });
      }

      // Rebuild embed & components after switching
      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
      const components = buildComponents(eventId, lanes, signupsByLane);
      const unix = Math.floor(new Date(eventRow.start_time_utc).getTime() / 1000);
      const embed = buildEventEmbedDetail({
        title: eventRow.title,
        description: eventRow.description || undefined,
        image_url: eventRow.image_url || undefined,
        unix,
        lanes,
        signupsByLane,
        creatorId: eventRow.creator_id,
        status: "open",
        minGs: eventRow.min_gear_score,
      });

      const ch = await interaction.client.channels.fetch(eventRow.channel_id);
      const msg = await ch.messages.fetch(eventRow.message_id);
      await msg.edit({ embeds: [embed], components });

      await logPartyAction({
          guildId: interaction.guild.id,
          partyId: eventId,
          action: 'switch',
          actorNickname: interaction.member?.displayName || interaction.user.username,
          memberNickname: interaction.member?.displayName || interaction.user.username,
          reason: lane.name,
      });

      return interaction.editReply({
        content: `🔁 Switched to **${lane.name}** (GS ${gs}).`,
      });
    }

    if (kind === "leave") {
      const userId = String(interaction.user.id);

      // Find the exact signup row
      const existing = (
        await exec(
          `SELECT id FROM signups WHERE event_id=? AND user_id=? LIMIT 1;`,
          [eventId, userId]
        )
      )[0];

      if (!existing) {
        return interaction.editReply({ content: "❌ You’re not signed up for this party." });
      }

      // Delete by PRIMARY KEY (most reliable)
      await exec(`DELETE FROM signups WHERE id=?;`, [existing.id]);

      // Verify deletion (since exec() doesn't return .changes for DELETE)
      const stillThere = (
        await exec(`SELECT 1 FROM signups WHERE id=? LIMIT 1;`, [existing.id])
      )[0];

      if (stillThere) {
        console.error("🚨 Leave delete verify failed:", { eventId, userId, signupId: existing.id });
        return interaction.editReply({
          content: "⚠️ Something went wrong removing your signup. Please try again.",
        });
      }

      // Rebuild public message
      const eventRow = (
        await exec(
          `SELECT title, description, image_url, start_time_utc,
                  creator_id, channel_id, message_id, min_gear_score, status
            FROM events WHERE id=? LIMIT 1;`,
          [eventId]
        )
      )[0];

      if (!eventRow) {
        return interaction.editReply({ content: "❌ Party not found (it may have been closed)." });
      }

      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
      const components = buildComponents(eventId, lanes, signupsByLane);

      const embed = buildEventEmbedDetail({
        title: eventRow.title,
        description: eventRow.description || undefined,
        image_url: eventRow.image_url || undefined,
        unix: Math.floor(new Date(eventRow.start_time_utc).getTime() / 1000),
        lanes,
        signupsByLane, // [{ user_id, gear_score }]
        creatorId: eventRow.creator_id,
        status: eventRow.status || "open",
        minGs: eventRow.min_gear_score, // keep Min GS visible
      });

      const ch = await interaction.client.channels.fetch(eventRow.channel_id);
      const msg = await ch.messages.fetch(eventRow.message_id);
      await msg.edit({ embeds: [embed], components });

      await logPartyAction({
          guildId: interaction.guild.id,
          partyId: eventId,
          action: 'leave',
          actorNickname: interaction.member?.displayName || interaction.user.username,
          memberNickname: interaction.member?.displayName || interaction.user.username,
      });

      return interaction.editReply({ content: "🚪 You left the party." });
    }

    if (kind === "mgr") {
      const hasAccess = isManager({ interaction, eventCreatorId: ev.creator_id });
      if (!hasAccess) {
        return interaction.editReply({ content: "⛔ You don’t have permission to manage this party." });
      }

      const eventRow = (
        await exec(
          `SELECT min_gear_score FROM events WHERE id=? LIMIT 1;`,
          [eventId]
        )
      )[0];

      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
      const allUserIds = lanes.flatMap((l) =>
        (signupsByLane.get(l.id) || []).map((s) => s.user_id)
      );
      const nameMap = await resolveDisplayNames(
        interaction.client,
        interaction.guild.id,
        allUserIds
      );

      const rows = [];
      for (const l of lanes) {
        const users = signupsByLane.get(l.id) || [];
        if (users.length === 0) {
          const disabled = new StringSelectMenuBuilder()
            .setCustomId(`msel:${eventId}:${l.id}`)
            .setPlaceholder(`${(l.emoji ?? "")} ${l.name} — no players`)
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(true)
            .addOptions({ label: "No players to remove", value: "none" });
          rows.push(new ActionRowBuilder().addComponents(disabled));
          continue;
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId(`msel:${eventId}:${l.id}`)
          .setPlaceholder(`${(l.emoji ?? "")} ${l.name} — remove players`)
          .setMinValues(1)
          .setMaxValues(Math.min(users.length, 25));

        const options = users.map((s, i) => ({
          label: `${i + 1}) ${nameMap.get(s.user_id) || s.user_id}`,
          description: `Remove <@${s.user_id}>`,
          value: s.user_id,
        }));
        select.addOptions(...options);
        rows.push(new ActionRowBuilder().addComponents(select));
      }

      await interaction.editReply({
        content: "⚙️ **Manage Party** — select players to remove. Changes update instantly.",
        components: rows,
      });
      return;
    }
  } catch (err) {
    console.error("💥 handleButton error:", err);
    try {
      await interaction.editReply({});
    } catch {}
    await interaction.editReply({ content: "❌ Something went wrong processing your action." })
  }
}
