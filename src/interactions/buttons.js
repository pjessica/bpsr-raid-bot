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
    new ButtonBuilder().setCustomId(`leave:${eventId}:v1`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mgr:${eventId}:v1`).setLabel("⚙️ Manage").setStyle(ButtonStyle.Secondary)
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

/** UPSERT signup (single write; no pre-check read) */
async function upsertSignup(eventId, userId, targetLaneId) {
  await exec(
    `INSERT INTO signups (event_id, user_id, lane_id, joined_at_utc)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(event_id, user_id) DO UPDATE SET
       lane_id=excluded.lane_id,
       joined_at_utc=datetime('now');`,
    [eventId, userId, targetLaneId]
  );
}

/** Delete signup (leave) */
async function deleteSignup(eventId, userId) {
  await exec(`DELETE FROM signups WHERE event_id=? AND user_id=?;`, [eventId, userId]);
}

export async function handleButton(interaction) {
  if (!interaction.isButton()) return;

  // Prevent 10062: acknowledge immediately
  await interaction.deferUpdate();

  const [kind, eventId, laneKey] = (interaction.customId || "").split(":");
  if (!["join", "leave", "mgr"].includes(kind)) return;

  // Static event info from cache (fallback to DB once)
  let ev = eventCache.get(eventId);
  if (!ev) {
    const row = (await exec(
      `SELECT title, description, image_url, start_time_utc, creator_id, channel_id, message_id
       FROM events WHERE id=?;`,
      [eventId]
    ))[0];
    if (!row) {
      await interaction.editReply({});
      await interaction.followUp({ content: "❌ This party no longer exists.", flags: 64 });
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
    };
    eventCache.set(eventId, ev);
  }

  try {
    if (kind === "join") {
        // Fetch fresh status (cache can be stale after /party close)
        const statusRow = (await exec(`SELECT status FROM events WHERE id=?;`, [eventId]))[0];
        if (!statusRow || statusRow.status !== "open") {
            await interaction.editReply({}); // complete the deferral
            await interaction.followUp({ content: "🔒 This party is closed.", flags: 64 });
            return;
        }

      // Target lane + quick capacity guard
      const lane = (await exec(
        `SELECT id, name, capacity FROM lanes WHERE event_id=? AND lane_key=?;`,
        [eventId, laneKey]
      ))[0];
      if (!lane) {
        await interaction.editReply({});
        await interaction.followUp({ content: "❌ That lane doesn't exist.", flags: 64 });
        return;
      }

      const [{ c: filled = 0 } = {}] = await exec(
        `SELECT COUNT(*) AS c FROM signups WHERE event_id=? AND lane_id=?;`,
        [eventId, lane.id]
      );
      const cap = Number(lane.capacity) || 0;
      if (cap > 0 && filled >= cap) {
        await interaction.editReply({});
        await interaction.followUp({ content: `❌ **${lane.name}** is full.`, flags: 64 });
        return;
      }

      await upsertSignup(eventId, interaction.user.id, lane.id);

      // Rebuild UI
      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
      const components = buildComponents(eventId, lanes, signupsByLane);
      const embed = buildEventEmbedDetail({
        title: ev.title,
        description: ev.description,
        image_url: ev.image_url,
        unix: ev.unix,
        lanes,
        signupsByLane,
        creatorId: ev.creator_id,
      });

      await interaction.editReply({ embeds: [embed], components });
      await interaction.followUp({ content: `✅ You joined **${lane.name}**.`, flags: 64 });
      return;
    }

    if (kind === "leave") {
      // Guard: only remove if actually signed up
      const existing = await exec(
        `SELECT id FROM signups WHERE event_id=? AND user_id=?;`,
        [eventId, interaction.user.id]
      );

      if (!existing.length) {
        await interaction.editReply({});
        await interaction.followUp({ content: "❌ You’re not signed up for this party.", flags: 64 });
        return;
      }

      await exec(`DELETE FROM signups WHERE id=?;`, [existing[0].id]);

      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);
      const components = buildComponents(eventId, lanes, signupsByLane);
      const embed = buildEventEmbedDetail({
        title: ev.title,
        description: ev.description,
        image_url: ev.image_url,
        unix: ev.unix,
        lanes,
        signupsByLane,
        creatorId: ev.creator_id,
      });

      await interaction.editReply({ embeds: [embed], components });
      await interaction.followUp({ content: "🚪 You left the party.", flags: 64 });
      return;
    }

    if (kind === "mgr") {
      // Permission check: creator, admins, or configured admin_ids
      const hasAccess = isManager({ interaction, eventCreatorId: ev.creator_id });
      if (!hasAccess) {
        await interaction.editReply({});
        await interaction.followUp({ content: "⛔ You don’t have permission to manage this party.", flags: 64 });
        return;
      }

      // Build current lanes & signups
      const { lanes, signupsByLane } = await getLanesAndSignups(eventId);

      // Resolve display names once
      const allUserIds = lanes.flatMap((l) => signupsByLane.get(l.id) || []);
      const nameMap = await resolveDisplayNames(interaction.client, interaction.guild.id, allUserIds);

      // Build per-lane select menus (ephemeral)
      const rows = [];
      for (const l of lanes) {
        const users = signupsByLane.get(l.id) || [];

        if (users.length === 0) {
          // Disabled menu must still have at least one option (to avoid 50035)
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

        const options = users.map((uid, i) => ({
            label: `${i + 1}) ${nameMap.get(uid) || uid}`,
            description: `Remove <@${uid}>`,
            value: uid,
        }));
        select.addOptions(...options);

        rows.push(new ActionRowBuilder().addComponents(select));
      }

      // Show ephemeral manage panel
      await interaction.followUp({
        content: "⚙️ **Manage Party** — select players to remove. Changes update instantly.",
        components: rows,
        flags: 64, // ephemeral
      });

      // No change to the public message here
      await interaction.editReply({});
      return;
    }
  } catch (err) {
    console.error("💥 handleButton error:", err);
    try { await interaction.editReply({}); } catch {}
    await interaction.followUp({ content: "❌ Something went wrong processing your action.", flags: 64 }).catch(() => {});
  }
}
