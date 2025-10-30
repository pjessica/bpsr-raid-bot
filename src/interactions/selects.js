import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { exec } from "../db/d1Client.js";
import { buildEventEmbedDetail } from "../utils/embeds.js";
import { eventCache } from "../state/cache.js";
import { resolveDisplayNames } from "../utils/names.js";
import { logPartyAction } from "../utils/logPartyAction.js";

/** Components for the main event message */
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
    new ButtonBuilder().setCustomId(`leave:${eventId}:v1`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mgr:${eventId}:v1`).setLabel("⚙️ Manage").setStyle(ButtonStyle.Secondary)
  );

  return [joinRow, controls];
}

/** Lanes + signups (signups as objects: { user_id, gear_score }) */
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

  const signupsByLane = new Map(lanes.map(l => [l.id, []]));
  for (const r of rows) {
    signupsByLane.get(r.lane_id)?.push({
      user_id: r.user_id,
      gear_score: r.gear_score,
    });
  }
  return { lanes, signupsByLane };
}

export async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu?.()) return;

  // Ack quickly to avoid 10062
  await interaction.deferUpdate();

  const [kind, eventId, laneIdStr] = (interaction.customId || "").split(":");
  if (kind !== "msel") return;

  try {
    const laneId = Number(laneIdStr);
    const userIds = (interaction.values || []).filter((v) => v !== "none");

    // Delete selected users from that lane (if any)
    if (userIds.length) {
      const qs = userIds.map(() => "?").join(",");
      await exec(
        `DELETE FROM signups WHERE event_id=? AND lane_id=? AND user_id IN (${qs});`,
        [eventId, laneId, ...userIds]
      );
    }

    // Rebuild main event message
    const evRow = (await exec(
      `SELECT channel_id, message_id, title, description, image_url, start_time_utc, creator_id, min_gear_score
       FROM events WHERE id=?;`,
      [eventId]
    ))[0];

    if (!evRow) {
      await interaction.editReply({
        content: "❌ Party no longer exists.",
        components: [],
      });
      return;
    }

    let ev = eventCache.get(eventId);
    if (!ev) {
      ev = {
        title: evRow.title,
        description: evRow.description || undefined,
        image_url: evRow.image_url || undefined,
        unix: Math.floor(new Date(evRow.start_time_utc).getTime() / 1000),
        creator_id: evRow.creator_id,
      };
      eventCache.set(eventId, ev);
    }

    const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
    const components = buildComponents(eventId, lanes, signupsByLane);

    // Edit the public event message
    try {
      const channel = await interaction.client.channels.fetch(evRow.channel_id);
      const msg = await channel.messages.fetch(evRow.message_id);
      const embed = buildEventEmbedDetail({
        title: ev.title,
        description: ev.description,
        image_url: ev.image_url,
        unix: ev.unix,
        lanes,
        signupsByLane,                // [{ user_id, gear_score }]
        creatorId: ev.creator_id,
        status: "open",
        minGs: evRow.min_gear_score,  // keep Min GS visible
      });
      await msg.edit({ embeds: [embed], components });
    } catch (e) {
      console.warn("⚠️ Could not edit event message:", e.message);
    }

    // Refresh the ephemeral manage panel (with display names)
    const allUserIds = lanes.flatMap((l) =>
      (signupsByLane.get(l.id) || []).map(s => s.user_id)
    );
    const nameMap = await resolveDisplayNames(interaction.client, interaction.guild.id, allUserIds);

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

    // Actor = the manager clicking the menu
    const actorNickname =
      interaction.member?.displayName || interaction.user.username || String(interaction.user.id);

    // Log one row per removed member (readable names)
    const removedNameMap = await resolveDisplayNames(
      interaction.client,
      interaction.guild.id,
      userIds
    );
    for (const uid of userIds) {
      const memberNickname = removedNameMap.get(uid) || uid;
      await logPartyAction({
        guildId: interaction.guild.id,
        partyId: eventId,
        action: "remove",
        actorNickname,
        memberNickname,
      });
    }

    // Update the ephemeral manage panel in-place
    await interaction.editReply({
      content: "⚙️ **Manage Party** — select players to remove. Changes update instantly.",
      components: rows,
    });
  } catch (err) {
    console.error("💥 handleSelect error:", err);
    try {
      await interaction.editReply({
        content: "❌ Failed to process removal. Please try again.",
      });
    } catch {}
  }
}
