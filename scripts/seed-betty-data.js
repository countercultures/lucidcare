#!/usr/bin/env node
// Imports doctors/timeline/treatments/medications from a local export of forwarded
// emails into Firestore, skipping anything that already exists.
//
// Usage:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 node seed-betty-data.js --project demo-lucidcare
//   node seed-betty-data.js --dry-run                 # print planned writes, touch nothing
//   node seed-betty-data.js --confirm-production       # required to write to a real project
//
// Reads the source data from DATA_FILE (defaults to the path below). That file lives
// outside this repo and is never read into this script's source, so no patient data
// ends up in git.

const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.DATA_FILE ||
  "/Users/rogerfloyd/Documents/LUCIDCARE/lucidcare_data_june2026_emails.json";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const confirmProduction = args.includes("--confirm-production");
const projectArg = args.find(a => a.startsWith("--project="));
const projectId = projectArg ? projectArg.split("=")[1] : "lucidcare2026";

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

function parseApproxDate(text) {
  if (!text) return null;
  const full = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (full) {
    const mon = MONTHS[full[1].slice(0, 3).toLowerCase()];
    if (mon) return `${full[3]}-${mon}-${String(full[2]).padStart(2, "0")}`;
  }
  const monthYear = text.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (monthYear) {
    const mon = MONTHS[monthYear[1].slice(0, 3).toLowerCase()];
    if (mon) return `${monthYear[2]}-${mon}-01`;
  }
  return null;
}

function buildRecords(data) {
  const doctors = (data.doctors_to_add || []).map(d => ({
    name: d.name,
    specialty: d.specialty || "",
    hospital: "",
    phone: d.phone || "",
    email: d.email || "",
    notes: [d.notes, d.address ? `Address: ${d.address}` : null].filter(Boolean).join(" "),
    createdAt: new Date().toISOString()
  }));

  const timeline = (data.timeline_to_add || []).map(t => ({
    title: t.title,
    date: t.date,
    type: "alternative",
    doctor: "",
    location: "",
    notes: t.notes || "",
    createdAt: new Date().toISOString()
  }));

  const treatments = [];
  const treatmentWarnings = [];
  for (const t of data.treatments_to_add || []) {
    const date = parseApproxDate(t.date_range);
    if (!date) treatmentWarnings.push(`Could not parse a date from date_range "${t.date_range}" for treatment "${t.name}" — leaving date blank.`);
    treatments.push({
      name: t.name,
      date: date || "",
      type: "alternative",
      provider: t.provider || "",
      notes: [t.notes, t.date_range ? `Date range: ${t.date_range}` : null].filter(Boolean).join(" "),
      createdAt: new Date().toISOString()
    });
  }

  const medications = [];
  const currentBlock = data["medications_current_as_of_2026-06-15"] || {};
  const asOfDate = "2026-06-15";
  for (const [group, items] of Object.entries(currentBlock)) {
    if (group === "_note" || !Array.isArray(items)) continue;
    for (const m of items) {
      medications.push({
        name: m.name,
        dosage: m.dose || "",
        frequency: group,
        startDate: asOfDate,
        endDate: "",
        status: "active",
        notes: "",
        createdAt: new Date().toISOString()
      });
    }
  }
  for (const m of data.medications_discontinued_or_unclear || []) {
    medications.push({
      name: m.name,
      dosage: "",
      frequency: "",
      startDate: "",
      endDate: "",
      status: "past",
      notes: [m.status, m.notes].filter(Boolean).join(" — "),
      createdAt: new Date().toISOString()
    });
  }

  return { doctors, timeline, treatments, medications, treatmentWarnings };
}

function buildKey(record, keyFields) {
  return keyFields.map(f => (record[f] || "").trim().toLowerCase()).join("|");
}

async function getExistingKeys(db, collectionName, keyFields) {
  const snap = await db.collection(collectionName).get();
  return new Set(snap.docs.map(d => buildKey(d.data(), keyFields)));
}

async function seedCollection(db, collectionName, keyFieldOrFields, records, { dryRun }) {
  const keyFields = Array.isArray(keyFieldOrFields) ? keyFieldOrFields : [keyFieldOrFields];
  const existing = dryRun ? new Set() : await getExistingKeys(db, collectionName, keyFields);
  let added = 0, skipped = 0;
  for (const record of records) {
    const key = buildKey(record, keyFields);
    if (existing.has(key)) { skipped++; continue; }
    if (dryRun) {
      console.log(`[dry-run] would add to ${collectionName}:`, JSON.stringify(record));
    } else {
      await db.collection(collectionName).add(record);
    }
    existing.add(key);
    added++;
  }
  console.log(`${collectionName}: ${added} added, ${skipped} skipped (already existed)`);
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Data file not found: ${DATA_FILE}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const { doctors, timeline, treatments, medications, treatmentWarnings } = buildRecords(data);

  treatmentWarnings.forEach(w => console.warn(`Warning: ${w}`));

  if (!dryRun && !process.env.FIRESTORE_EMULATOR_HOST && !confirmProduction) {
    console.error(
      "Refusing to run: FIRESTORE_EMULATOR_HOST is not set, so this would write to " +
      "the real production database. Re-run against the emulator, use --dry-run, or " +
      "pass --confirm-production if you have explicitly decided to write to production."
    );
    process.exit(1);
  }

  let db = null;
  if (!dryRun) {
    const admin = require("firebase-admin");
    admin.initializeApp({ projectId });
    db = admin.firestore();
  }

  await seedCollection(db, "doctors", "name", doctors, { dryRun });
  await seedCollection(db, "timeline", ["title", "date"], timeline, { dryRun });
  await seedCollection(db, "treatments", "name", treatments, { dryRun });
  await seedCollection(db, "medications", ["name", "frequency"], medications, { dryRun });

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
