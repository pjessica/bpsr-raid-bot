import { EmbedBuilder } from "discord.js";

export function buildEventEmbedDetail(opts) {
  const {
    title,
    description,
    image_url,
    unix,
    lanes,
    signupsByLane,
    creatorId,
    status, // "open" | "closed" | "cancelled"
  } = opts;

  // 🧩 Choose prefix emoji + color based on status
  let titlePrefix = "";
  let color = 0x00b0ff; // default blue (open)

  switch (status) {
    case "closed":
      titlePrefix = "🔒 CLOSED - ";
      color = 0x6b7280; // grey
      break;
    case "cancelled":
      titlePrefix = "❌ ";
      color = 0x777777; // darker grey
      break;
    default:
      titlePrefix = "🟢 ";
      color = 0x00b0ff; // bright blue for active/open
      break;
  }

  const e = new EmbedBuilder()
    .setTitle(`${titlePrefix}${title}`)
    .setColor(color);

  // ✅ Only set description if present
  if (description && String(description).trim().length > 0) {
    e.setDescription(String(description).trim());
  }

  // 🕒 Time
  if (unix) {
    e.addFields({
      name: "Time",
      value: `<t:${unix}:F>  ( <t:${unix}:R> )`,
      inline: false,
    });
  }

  // 🧑 Host
  if (creatorId) {
    e.addFields({
      name: "Host",
      value: `<@${creatorId}>`,
      inline: false,
    });
  }

  // 🧩 Lanes (side-by-side)
  if (Array.isArray(lanes) && lanes.length) {
    for (const l of lanes) {
      const users = (signupsByLane?.get(l.id) || []).map((u) => `<@${u}>`);
      const body = users.length ? users.join("\n") : "_No players_";
      const label = `${(l.emoji ?? "").trim()} ${l.name} (${users.length}/${Number(l.capacity) || 0})`.trim();
      e.addFields({ name: label, value: body, inline: true });
    }

    // pad to multiple of 3 for alignment
    const remainder = lanes.length % 3;
    if (remainder) {
      for (let i = 0; i < 3 - remainder; i++) {
        e.addFields({ name: "\u200b", value: "\u200b", inline: true });
      }
    }
  }

  if (image_url && String(image_url).trim().length > 0) {
    e.setImage(String(image_url).trim());
  }

  return e;
}
