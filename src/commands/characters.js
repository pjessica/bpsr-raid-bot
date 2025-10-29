import { SlashCommandBuilder } from "discord.js";
import { exec } from "../db/d1Client.js";

/**
 * /character
 *   add    -> class (autocomplete from classes), gs (int), main (bool)
 *   list   -> list only the caller's characters (private + dismissible)
 *   remove -> character (autocomplete: caller’s chars)   (private + dismissible)
 *   setgs  -> character (autocomplete) + gs (int)        (private + dismissible)
 *   main   -> character (autocomplete)                   (private + dismissible)
 *   help   -> show quick guide for character commands    (private + dismissible) [NEW]
 */
export const data = new SlashCommandBuilder()
  .setName("character")
  .setDescription("Manage your characters")
  .addSubcommand(sc =>
    sc
      .setName("add")
      .setDescription("Add a character")
      .addStringOption(o =>
        o
          .setName("class")
          .setDescription("Pick a class (autocomplete)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addIntegerOption(o =>
        o
          .setName("gs")
          .setDescription("Gear Score")
          .setRequired(true)
          .setMinValue(0)
      )
      .addBooleanOption(o =>
        o
          .setName("main")
          .setDescription("Mark as main")
          .setRequired(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("list")
      .setDescription("List your characters")
  )
  .addSubcommand(sc =>
    sc
      .setName("remove")
      .setDescription("Remove one of your characters")
      .addStringOption(o =>
        o
          .setName("character")
          .setDescription("Select your character")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("setgs")
      .setDescription("Update a character's GS")
      .addStringOption(o =>
        o
          .setName("character")
          .setDescription("Select your character")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addIntegerOption(o =>
        o
          .setName("gs")
          .setDescription("New Gear Score")
          .setRequired(true)
          .setMinValue(0)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("main")
      .setDescription("Set one of your characters as main")
      .addStringOption(o =>
        o
          .setName("character")
          .setDescription("Select your character")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand(sc =>
    sc
      .setName("help")
      .setDescription("Show help for character commands")
  )
  .setDMPermission(false);

// ---------- Autocomplete for: add.class and remove/setgs/main.character ----------
export async function autocomplete(interaction) {
  if (interaction.commandName !== "character") return;

  const sub = interaction.options.getSubcommand(false);
  const focused = interaction.options.getFocused(true);

  // /character add -> class from classes table
  if (sub === "add" && focused?.name === "class") {
    const q = (focused.value || "").trim();
    const rows = await exec(
      `
      SELECT id, name, sub_class, role
      FROM classes
      WHERE name LIKE ? OR sub_class LIKE ?
      ORDER BY role, name, sub_class
      LIMIT 25;
      `,
      [`%${q}%`, `%${q}%`]
    );

    return interaction.respond(
      rows.map(r => ({
        name: `${r.name} | ${r.sub_class} — ${r.role}`,
        value: String(r.id),
      }))
    );
  }

  // /character remove|setgs|main -> character (only caller's characters)
  if ((sub === "remove" || sub === "setgs" || sub === "main") && focused?.name === "character") {
    const q = (focused.value || "").toLowerCase();

    const rows = await exec(
      `SELECT c.id, cl.name, cl.sub_class, cl.role, c.gear_score, c.is_main
         FROM characters c
         JOIN classes cl ON cl.id = c.class_id
        WHERE c.user_id=? AND c.guild_id=?
        ORDER BY c.is_main DESC, cl.role, cl.name
        LIMIT 50;`,
      [interaction.user.id, interaction.guildId]
    );

    const choices = rows
      .map(r => ({
        name: `${r.is_main ? "⭐ " : ""}${r.name} | ${r.sub_class} — ${r.role} — GS ${r.gear_score}`,
        value: String(r.id),
        _search: `${r.name} ${r.sub_class} ${r.role} ${r.gear_score}`.toLowerCase(),
      }))
      .filter(c => !q || c._search.includes(q))
      .slice(0, 25)
      .map(({ _search, ...rest }) => rest);

    return interaction.respond(choices);
  }
}

// ---------- Execute ----------
export async function execute(interaction) {
  const allowed = process.env.DISCORD_PARTY_CHANNEL_ID;
  if (!allowed || interaction.channelId !== allowed) {
    return interaction.reply({
      content: `⛔ This command can only be used in <#${allowed || "SET_DISCORD_PARTY_CHANNEL_ID"}>.`,
      ephemeral: true,
    });
  }
  
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const userNickname = interaction.member?.displayName;

  // Make list/remove/setgs/main/help private & dismissible; add remains public by default
  const ephemeralSubs = new Set(["add", "list", "remove", "setgs", "main", "help"]);
  const makeEphemeral = ephemeralSubs.has(sub);

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: makeEphemeral });
  }

  // ----- /character add -----
  if (sub === "add") {
    const classId = Number(interaction.options.getString("class"));
    const gs = interaction.options.getInteger("gs");
    const isMain = interaction.options.getBoolean("main") ? 1 : 0;

    // Validate class exists
    const cls = (await exec(
      `SELECT id, name, sub_class, role FROM classes WHERE id=? LIMIT 1;`,
      [classId]
    ))[0];
    if (!cls) return interaction.editReply("❌ Unknown class selection. Please pick from the autocomplete list.");

    // check duplicate (same user, guild, class)
    const exists = await exec(
      `SELECT 1 FROM characters WHERE user_id=? AND guild_id=? AND class_id=? LIMIT 1;`,
      [userId, guildId, cls.id]
    );

    if (exists.length) {
      return interaction.editReply(
        `⚠️ You already have **${cls.name} | ${cls.sub_class}** registered. Use **/character setgs** to update GS or **/character main** to change your main.`
      );
    }

    if (isMain) {
      await exec(`UPDATE characters SET is_main=0 WHERE user_id=? AND guild_id=?;`, [userId, guildId]);
    }

    await exec(
      `INSERT INTO characters(user_id, guild_id, class_id, nickname, gear_score, is_main, updated_at_utc)
       VALUES(?,?,?,?,?,?,?);`,
      [userId, guildId, cls.id, userNickname, gs, isMain, new Date().toISOString()]
    );

    return interaction.editReply(
      `✅ Added **${cls.name} | ${cls.sub_class}** (${cls.role}) — GS **${gs}**${isMain ? " • marked as main" : ""}.`
    );
  }

  // ----- /character list -----
  if (sub === "list") {
    const rows = await exec(
      `SELECT c.id, cl.name, cl.sub_class, cl.role, c.gear_score, c.is_main
         FROM characters c
         JOIN classes cl ON cl.id = c.class_id
        WHERE c.user_id=? AND c.guild_id=?
        ORDER BY c.is_main DESC, cl.role, cl.name;`,
      [userId, guildId]
    );
    if (!rows.length) return interaction.editReply(`ℹ️ You have no characters yet.`);

    // 1..n numbering (no DB ids)
    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.is_main ? "⭐ " : ""}**${r.name} | ${r.sub_class}** (${r.role}) — GS **${r.gear_score}**`
    );
    return interaction.editReply(lines.join("\n"));
  }

  // ----- /character remove (autocomplete -> immediate action) -----
  if (sub === "remove") {
    const charId = Number(interaction.options.getString("character"));

    // Ownership check
    const owned = await exec(
      `SELECT id FROM characters WHERE id=? AND user_id=? AND guild_id=? LIMIT 1;`,
      [charId, userId, guildId]
    );
    if (!owned.length) {
      return interaction.editReply("❌ Character not found or not yours.");
    }

    await exec(`DELETE FROM characters WHERE id=? AND user_id=? AND guild_id=?;`, [charId, userId, guildId]);
    return interaction.editReply("🗑️ Removed.");
  }

  // ----- /character setgs (autocomplete -> immediate action) -----
  if (sub === "setgs") {
    const charId = Number(interaction.options.getString("character"));
    const gs = interaction.options.getInteger("gs");

    if (!Number.isInteger(gs) || gs < 0) {
      return interaction.editReply("❌ Please enter a valid non-negative integer.");
    }

    // Ownership check
    const owned = await exec(
      `SELECT id FROM characters WHERE id=? AND user_id=? AND guild_id=? LIMIT 1;`,
      [charId, userId, guildId]
    );
    if (!owned.length) {
      return interaction.editReply("❌ Character not found or not yours.");
    }

    await exec(
      `UPDATE characters SET gear_score=?, updated_at_utc=? WHERE id=? AND user_id=? AND guild_id=?;`,
      [gs, new Date().toISOString(), charId, userId, guildId]
    );
    return interaction.editReply(`✅ Updated GS to **${gs}**.`);
  }

  // ----- /character main (autocomplete -> immediate action) -----
  if (sub === "main") {
    const charId = Number(interaction.options.getString("character"));

    // Verify ownership and fetch class info for message
    const row = (await exec(
      `SELECT c.id, cl.name, cl.sub_class
         FROM characters c
         JOIN classes cl ON cl.id = c.class_id
        WHERE c.id=? AND c.user_id=? AND c.guild_id=?
        LIMIT 1;`,
      [charId, userId, guildId]
    ))[0];

    if (!row) {
      return interaction.editReply("❌ Character not found or not yours.");
    }

    // Clear previous mains, then set selected as main
    await exec(`UPDATE characters SET is_main=0 WHERE user_id=? AND guild_id=?;`, [userId, guildId]);
    await exec(`UPDATE characters SET is_main=1, updated_at_utc=? WHERE id=? AND user_id=? AND guild_id=?;`, [
      new Date().toISOString(),
      charId,
      userId,
      guildId,
    ]);

    return interaction.editReply(`✅ Set **${row.name} | ${row.sub_class}** as your main.`);
  }

  // ----- /character help (private) [NEW] -----
  if (sub === "help") {
    const help = [
      "**/character add** — Add a character",
      "• `class` *(list of classes)*",
      "• `gs` *(number, must be more than 0)*",
      "• `main` *(true/false, if true, sets as your main)*",
      "",
      "**/character list** — Show only *your* characters",
      "",
      "**/character remove** — Delete one of your characters",
      "• `character` *(choose one)*",
      "",
      "**/character setgs** — Update gear score",
      "• `character` *(choose one)*",
      "• `gs` *(number, must be more than 0)*",
      "",
      "**/character main** — Set your main character",
      "• `character` *(choose one)*",
    ].join("\n");

    return interaction.editReply(help);
  }
}
