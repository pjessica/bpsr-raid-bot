import "dotenv/config";
import { Client, GatewayIntentBits, Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handleButton } from "./src/interactions/buttons.js";
import { handleSelect } from "./src/interactions/selects.js";
import { handleModalSubmit } from "./src/interactions/modals.js"; // safe to keep

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates]
});

client.commands = new Collection();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commandsDir = path.join(__dirname, "src", "commands");
const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"));

// Load /party command
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
    // console.log("🚦 interaction:", {
    //   type: interaction.type,
    //   commandName: interaction.commandName || null,
    //   customId: interaction.customId || null,
    //   isAutocomplete: interaction.isAutocomplete?.() || false,
    //   isChatInput: interaction.isChatInputCommand?.() || false,
    //   isButton: interaction.isButton?.() || false,
    //   isStringSelectMenu: interaction.isStringSelectMenu?.() || false,
    //   isModal: interaction.isModalSubmit?.() || false,
    // });

    if (interaction.isAutocomplete?.()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction);
      return;
    }

    if (interaction.isButton?.()) return handleButton(interaction);
    if (interaction.isAnySelectMenu?.() || interaction.isStringSelectMenu?.()) return handleSelect(interaction);
    if (interaction.isModalSubmit?.()) return handleModalSubmit(interaction);

    if (interaction.isChatInputCommand?.()) {
      const cmd = client.commands.get(interaction.commandName);
      console.log("🎯 dispatching:", interaction.commandName, Boolean(cmd));

      if (!cmd) {
        // Avoid timeout: tell us the command wasn’t loaded
        await interaction.reply({ content: "⚠️ Command not loaded on bot. Restart or re-register.", flags: 64 }).catch(() => {});
        return;
      }

      await cmd.execute(interaction);
      return;
    }
  } catch (err) {
    console.error("💥 interactionCreate error:", err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "❌ Something went wrong.", flags: 64 }).catch(() => {});
    } else {
      await interaction.reply({ content: "❌ Something went wrong.", flags: 64 }).catch(() => {});
    }
  }
});


client.login(process.env.DISCORD_TOKEN);
