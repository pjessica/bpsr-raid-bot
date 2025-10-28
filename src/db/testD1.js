import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const { D1_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN } = process.env;

async function testConnection() {
  const query = "SELECT datetime('now') as current_time;";

  console.log("🔍 Testing Cloudflare D1 connection...");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${D1_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: query }),
    }
  );

  const json = await res.json();
  if (!json.success) {
    console.error("❌ Failed:", json.errors);
    return;
  }

  console.log("✅ Success! D1 responded with:", json.result);
}

testConnection().catch(console.error);
