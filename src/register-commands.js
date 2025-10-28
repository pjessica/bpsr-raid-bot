import "dotenv/config";
import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all command definitions
const commands = [];
const commandFiles = fs.readdirSync(path.join(__dirname, "commands")).filter(f => f.endsWith(".js"));

for (const file of commandFiles) {
  const cmd = await import(`./commands/${file}`);
  if (cmd?.data) {
    commands.push(cmd.data.toJSON());
    console.log("📦 registering:", cmd.data.name);
  }
}

console.log(`📝 Loaded ${commands.length} commands.`);

// === CONFIG ===
// Use your own guild ID for fast local testing
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.TEST_GUILD_ID; // add this to .env
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log("🔄 Refreshing application (guild) commands...");

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );

  console.log("✅ Successfully registered guild commands.");
} catch (error) {
  console.error(error);
}
