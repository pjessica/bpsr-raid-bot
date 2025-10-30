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

async function getLanesAndSignups(eventId) {
  const [lanes, rows] = await Promise.all([
    exec(
      `SELECT id, lane_key, name, emoji, capacity, sort_order
       FROM lanes WHERE event_id=? ORDER BY sort_order ASC;`,
      [eventId]
    ),
    exec(
      `SELECT lane_id, user_id
       FROM signups
       WHERE event_id=?
       ORDER BY joined_at_utc ASC;`,
      [eventId]
    ),
  ]);

  const signupsByLane = new Map();
  for (const r of rows) {
    if (!signupsByLane.has(r.lane_id)) signupsByLane.set(r.lane_id, []);
    signupsByLane.get(r.lane_id).push(r.user_id);
  }
  return { lanes, signupsByLane };
}

export async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu?.()) return;

  // ✅ Acknowledge immediately to avoid 10062
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
      `SELECT channel_id, message_id, title, description, image_url, start_time_utc
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
        description: evRow.description,
        image_url: evRow.image_url,
        unix: Math.floor(new Date(evRow.start_time_utc).getTime() / 1000),
      };
      eventCache.set(eventId, ev);
    }

    const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
    const components = buildComponents(eventId, lanes, signupsByLane);

    // Edit the public event message (errors here shouldn't fail the interaction)
    try {
      const channel = await interaction.client.channels.fetch(evRow.channel_id);
      const msg = await channel.messages.fetch(evRow.message_id);
      const embed = buildEventEmbedDetail({
        title: ev.title,
        description: ev.description,
        image_url: ev.image_url,
        unix: ev.unix,
        lanes,
        signupsByLane,
      });
      await msg.edit({ embeds: [embed], components });
    } catch (e) {
      console.warn("⚠️ Could not edit event message:", e.message);
    }

    // Refresh the ephemeral manage panel (with display names)
    const allUserIds = lanes.flatMap((l) => signupsByLane.get(l.id) || []);
    const nameMap = await resolveDisplayNames(interaction.client, interaction.guild.id, allUserIds);

    const rows = [];
    for (const l of lanes) {
      const users = signupsByLane.get(l.id) || [];

      if (users.length === 0) {
        // Disabled menu MUST include at least one option
        const disabled = new StringSelectMenuBuilder()
          .setCustomId(`msel:${eventId}:${l.id}`)
          .setPlaceholder(`${(l.emoji ?? "")} ${l.name} — no players`)
          .setMinValues(1)
          .setMaxValues(1)
          .setDisabled(true)
          .addOptions({ label: "No players to remove", value: "none" }); // 👈 use addOptions
        rows.push(new ActionRowBuilder().addComponents(disabled));
        continue;
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`msel:${eventId}:${l.id}`)
        .setPlaceholder(`${(l.emoji ?? "")} ${l.name} — remove players`)
        .setMinValues(1)
        .setMaxValues(Math.min(users.length, 25));

      const options = users.map((uid, i) => ({
        label: `${i + 1}) ${nameMap.get(uid) || uid}`,
        description: `Remove <@${uid}>`,
        value: uid,
      }));

      // 👇 In discord.js v14, prefer addOptions(...options)
      select.addOptions(...options);

      rows.push(new ActionRowBuilder().addComponents(select));
    }

    // Actor = the manager clicking the menu
    const actorNickname =
      interaction.member?.displayName || interaction.user.username || String(interaction.user.id);

    // Resolve nicknames for the removed users (readable logs)
    const removedNameMap = await resolveDisplayNames(
      interaction.client,
      interaction.guild.id,
      userIds
    );

    // One row per removed member
    for (const uid of userIds) {
      const memberNickname = removedNameMap.get(uid) || uid;
      await logPartyAction(db, {
        guildId: interaction.guild.id,
        eventId,
        action: 'remove',
        actorNickname,
        memberNickname,
      });
    }

    // Update the ephemeral panel in-place
    await interaction.editReply({
      content: "⚙️ **Manage Party** — select players to remove. Changes update instantly.",
      components: rows,
    });
  } catch (err) {
    console.error("💥 handleSelect error:", err);
    // ensure we complete the interaction cycle even if something blew up
    try {
      await interaction.editReply({
        content: "❌ Failed to process removal. Please try again.",
      });
    } catch {}
  }
}
