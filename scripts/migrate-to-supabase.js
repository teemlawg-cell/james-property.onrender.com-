"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createClient } = require("@supabase/supabase-js");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DATABASE_PATH = path.join(DATA_DIR, "james-property.sqlite");
const BUCKET = process.env.SUPABASE_PHOTO_BUCKET || "property-photos";

function requireSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in this PowerShell session.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function rewritePhotoUrls(property, getPublicUrl) {
  const rewrite = (url) => {
    if (typeof url !== "string") return url;
    const match = url.match(/^\/uploads\/([a-f0-9-]{36}\.jpg)$/);
    return match ? getPublicUrl(match[1]) : url;
  };
  property.image = rewrite(property.image);
  if (Array.isArray(property.images)) {
    property.images = property.images.map((photo) => (
      photo && typeof photo === "object" ? { ...photo, url: rewrite(photo.url) } : photo
    ));
  }
  return property;
}

async function main() {
  if (!fs.existsSync(DATABASE_PATH)) {
    throw new Error(`The local SQLite database was not found at ${DATABASE_PATH}.`);
  }
  const supabase = requireSupabaseConfig();
  const bucketResult = await supabase.storage.getBucket(BUCKET);
  if (bucketResult.error) throw new Error(`Could not verify Supabase photo bucket: ${bucketResult.error.message}`);
  if (!bucketResult.data.public) throw new Error(`Supabase storage bucket "${BUCKET}" must be public.`);

  const local = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const properties = local.prepare("SELECT id, data, updated_at FROM properties ORDER BY id").all()
      .map((row) => ({ id: row.id, data: JSON.parse(row.data), updated_at: row.updated_at }));
    const administrator = local.prepare(
      "SELECT id, email, password_salt, password_hash, created_at FROM administrators WHERE id = 1"
    ).get() || null;
    const activity = local.prepare(`
      SELECT message, time FROM activity
      WHERE id IN (SELECT id FROM activity ORDER BY id DESC LIMIT 30)
      ORDER BY id ASC
    `).all();
    const photoNames = new Set();
    const uploadDirectory = path.join(DATA_DIR, "uploads");
    if (fs.existsSync(uploadDirectory)) {
      for (const filename of fs.readdirSync(uploadDirectory)) {
        if (/^[a-f0-9-]{36}\.jpg$/.test(filename)) photoNames.add(filename);
      }
    }
    for (const row of properties) {
      const property = row.data;
      for (const photo of [{ url: property.image }, ...(Array.isArray(property.images) ? property.images : [])]) {
        if (!photo || typeof photo.url !== "string" || !photo.url.startsWith("/uploads/")) continue;
        const match = photo.url.match(/^\/uploads\/([a-f0-9-]{36}\.jpg)$/);
        if (!match) throw new Error(`A local photo URL is not a supported upload: ${photo.url}`);
        photoNames.add(match[1]);
      }
    }

    const getPublicUrl = (filename) => supabase.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
    for (const filename of photoNames) {
      const filePath = path.join(DATA_DIR, "uploads", filename);
      if (!fs.existsSync(filePath)) throw new Error(`A listing photo is missing from the local uploads folder: ${filename}`);
      const upload = await supabase.storage.from(BUCKET).upload(filename, fs.readFileSync(filePath), {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true
      });
      if (upload.error) throw new Error(`Could not migrate a property photo: ${upload.error.message}`);
    }
    for (const row of properties) rewritePhotoUrls(row.data, getPublicUrl);

    const result = await supabase.rpc("import_initial_site_data", {
      p_properties: properties,
      p_administrator: administrator,
      p_activity: activity
    });
    if (result.error) throw new Error(`Could not import the local website data: ${result.error.message}`);

    process.stdout.write(
      `Migrated ${properties.length} listings, ${photoNames.size} uploaded photos, `
      + `${administrator ? "the existing owner account" : "no owner account"}, and ${activity.length} activity records.\n`
    );
    process.stdout.write("The local SQLite database and photo files were left unchanged.\n");
  } finally {
    local.close();
  }
}

main().catch((error) => {
  console.error(`Supabase migration failed: ${error.message}`);
  process.exitCode = 1;
});
