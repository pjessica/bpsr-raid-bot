import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const { D1_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN } = process.env;

/**
 * exec(sql, params) -> for both SELECT and non-SELECT
 * - For SELECT: returns array of row objects (unwrapped from { result: [{ results: [...] }] })
 * - For INSERT/UPDATE/DDL: returns the raw result (you usually don't use the return value anyway)
 */
export async function exec(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${D1_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    }
  );

  const json = await res.json();
  if (!json.success) {
    console.error("❌ D1 Error:", JSON.stringify(json.errors, null, 2));
    throw new Error("D1 query failed");
  }

  const r = json.result;

  // SELECTs: Cloudflare returns [{ results: [...], meta: {...} }]
  if (Array.isArray(r) && r.length > 0 && typeof r[0] === "object" && "results" in r[0]) {
    return r[0].results ?? [];
  }

  // Non-SELECTs (INSERT/UPDATE/DDL) – return raw in case caller wants meta
  return r;
}
