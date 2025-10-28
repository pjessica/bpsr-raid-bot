import fs from "fs";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const { D1_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN } = process.env;

async function exec(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${D1_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
    }
  );
  const json = await res.json();
  if (!json.success) {
    console.error("❌ SQL error:", sql.slice(0, 120), "\n→", json.errors);
    throw new Error("SQL failed");
  }
}

function splitSqlStatements(sqlText) {
  // remove line comments and block comments
  let cleaned = sqlText
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // split on semicolons that end statements
  return cleaned
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

async function init() {
  console.log("🚀 Initialising schema...");
  const schema = fs.readFileSync("./src/db/schema.sql", "utf8");
  const statements = splitSqlStatements(schema);

  for (const stmt of statements) {
    await exec(stmt);
    console.log("✅ Executed:", stmt.split("\n")[0].slice(0, 80));
  }
  console.log("🎉 Schema initialisation complete!");
}

init().catch(err => {
  console.error(err);
  process.exit(1);
});
