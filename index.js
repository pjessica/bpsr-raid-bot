import "dotenv/config";
import { Client, GatewayIntentBits, Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handleButton } from "./src/interactions/buttons.js";
import { handleSelect } from "./src/interactions/selects.js";
import { handleModalSubmit } from "./src/interactions/modals.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commandsDir = path.join(__dirname, "src", "commands");
const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"));

// Dynamically load commands (party, character, etc.)
for (const file of files) {
  const cmd = await import(`./src/commands/${file}`);
  if (cmd?.data?.name && typeof cmd.execute === "function") {
    client.commands.set(cmd.data.name, cmd);
    console.log("✅ loaded command:", cmd.data.name);
  } else {
    console.warn("⚠️ skipped command (missing exports):", file);
  }
}

// Ready
client.once("clientReady", () => console.log(`✅ Logged in as ${client.user.tag}`));

// Interactions
client.on("interactionCreate", async (interaction) => {
  try {
    // ---- Autocomplete (works for BOTH /party and /character) ----
    if (interaction.isAutocomplete?.()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction);
      return;
    }

    // ---- Route /character selects & modals BEFORE global handlers ----
    if (
      (interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()) &&
      (
        interaction.customId === "char_remove_select" ||
        interaction.customId === "char_setgs_select" ||
        interaction.customId?.startsWith?.("char_remove_") ||
        interaction.customId?.startsWith?.("char_setgs_") ||
        interaction.customId?.startsWith?.("char_setgs_modal:")
      )
    ) {
      const characterCmd = client.commands.get("character");
      if (characterCmd?.handleComponent) {
        return characterCmd.handleComponent(interaction);
      }
    }

    // ---- Global component handlers (unchanged) ----
    if (interaction.isButton?.()) return handleButton(interaction);
    if (interaction.isAnySelectMenu?.() || interaction.isStringSelectMenu?.()) return handleSelect(interaction);
    if (interaction.isModalSubmit?.()) return handleModalSubmit(interaction);

    // ---- Slash commands ----
    if (interaction.isChatInputCommand?.()) {
      const cmd = client.commands.get(interaction.commandName);
      console.log("🎯 dispatching:", interaction.commandName, Boolean(cmd));

      if (!cmd) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "⚠️ Command not loaded on bot. Restart or re-register." }).catch(() => {});
        } else {
          await interaction.editReply("⚠️ Command not loaded on bot. Restart or re-register.").catch(() => {});
        }
        return;
      }

      await cmd.execute(interaction);
      return;
    }
  } catch (err) {
    console.error("💥 interactionCreate error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("❌ Something went wrong.").catch(() => {});
      } else {
        await interaction.reply("❌ Something went wrong.").catch(() => {});
      }
    } catch (e2) {
      console.error("💥 failed to send error reply:", e2);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
