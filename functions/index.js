const functions = require("firebase-functions");
const https = require("https");

exports.scanProxy = functions.https.onRequest((req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { base64, mediaType } = req.body;
  if (!base64 || !mediaType) { res.status(400).json({ error: "Missing base64 or mediaType" }); return; }

  const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_KEY || "").trim();
  console.log("Key length:", ANTHROPIC_API_KEY.length);
  console.log("Key prefix:", ANTHROPIC_API_KEY.substring(0, 20));

  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: "You are a medical record assistant. Look at this document and extract the key medical information. Return ONLY a JSON object with these fields (use null for anything not found): { \"recordType\": \"timeline|medication|treatment|lab|doctor\", \"title\": \"...\", \"date\": \"YYYY-MM-DD\", \"name\": \"...\", \"doctor\": \"...\", \"location\": \"...\", \"notes\": \"...\", \"dosage\": \"...\", \"frequency\": \"...\", \"testName\": \"...\", \"value\": \"...\", \"unit\": \"...\", \"specialty\": \"...\", \"hospital\": \"...\", \"phone\": \"...\" }. No explanation, just the JSON." }
    ]}]
  });

  const options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = "";
    apiRes.on("data", chunk => { data += chunk; });
    apiRes.on("end", () => {
      console.log("Anthropic status:", apiRes.statusCode);
      console.log("Anthropic response:", data.substring(0, 200));
      try { res.status(apiRes.statusCode).json(JSON.parse(data)); }
      catch { res.status(500).json({ error: "Failed to parse response", raw: data.substring(0, 200) }); }
    });
  });

  apiReq.on("error", (e) => { res.status(500).json({ error: e.message }); });
  apiReq.write(payload);
  apiReq.end();
});
