import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PermissionsBitField } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ADMIN_IDS = [];
try {
  const p = path.join(__dirname, "..", "config", "admins.json");
  ADMIN_IDS = JSON.parse(fs.readFileSync(p, "utf8")).admin_ids || [];
} catch { /* optional file */ }

export function isManager({ interaction, eventCreatorId }) {
  const userId = interaction.user.id;

  // Event creator is always manager
  if (userId === eventCreatorId) return true;

  // Server admins (Administrator permission)
  const member = interaction.member;
  if (member?.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;

  // Extra configured admins
  if (ADMIN_IDS.includes(userId)) return true;

  return false;
}
