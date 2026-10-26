"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { createClient } = require("@supabase/supabase-js");

const scryptAsync = promisify(scrypt);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_PHOTO_BUCKET = process.env.SUPABASE_PHOTO_BUCKET || "property-photos";
const USE_SUPABASE = Boolean(SUPABASE_URL || SUPABASE_SERVICE_ROLE_KEY);
if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}
const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  : null;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PRODUCTION = process.env.NODE_ENV === "production";
const SEO_INDEXING_ENABLED = PRODUCTION && process.env.SEO_INDEXING_ENABLED === "true";
const PUBLIC_URL = new URL(process.env.PUBLIC_URL || "https://jamespropertymng.com").origin;
if (PRODUCTION && !PUBLIC_URL.startsWith("https://")) {
  throw new Error("PUBLIC_URL must use HTTPS in production.");
}
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const PHOTO_BODY_LIMIT = 2 * 1024 * 1024;
const SESSION_COOKIE = "jpm_owner_session";
const sessions = new Map();
const loginAttempts = new Map();

let database = null;
if (!USE_SUPABASE) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(DATA_DIR, "james-property.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS administrators (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    time TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

if (!database.prepare("SELECT value FROM settings WHERE key = 'initial-seed-applied'").get()) {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT COUNT(*) AS count FROM properties").get().count === 0) {
      const seedPath = path.join(ROOT, "data", "properties.seed.json");
      const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      const insert = database.prepare("INSERT INTO properties (id, data, updated_at) VALUES (?, ?, ?)");
      const now = new Date().toISOString();
      for (const property of seed) insert.run(property.id, JSON.stringify(property), now);
      database.prepare("INSERT INTO settings (key, value) VALUES ('initial-seed-timestamp', ?)").run(now);
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('initial-seed-applied', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'starter-listings-refresh-v1'").get()) {
  const seedPath = path.join(ROOT, "data", "properties.seed.json");
  const starterListings = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const starterIds = new Set(starterListings.map((property) => property.id));
  const existingListings = database.prepare("SELECT id, data, updated_at FROM properties").all()
    .filter((row) => starterIds.has(row.id));
  const updateCounts = new Map();
  for (const row of existingListings) {
    updateCounts.set(row.updated_at, (updateCounts.get(row.updated_at) || 0) + 1);
  }
  const seedTimestamp = database.prepare("SELECT value FROM settings WHERE key = 'initial-seed-timestamp'").get()?.value;
  const initialTimestamp = seedTimestamp || [...updateCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  database.exec("BEGIN IMMEDIATE");
  try {
    const update = database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const property of starterListings) {
      const existing = existingListings.find((row) => row.id === property.id);
      if (existing && existing.updated_at === initialTimestamp) {
        update.run(JSON.stringify(property), now, property.id);
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('starter-listings-refresh-v1', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'starter-listings-refresh-v2'").get()) {
  const seedPath = path.join(ROOT, "data", "properties.seed.json");
  const starterListings = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const starterIds = new Set(starterListings.map((property) => property.id));
  const existingListings = database.prepare("SELECT id, updated_at FROM properties").all()
    .filter((row) => starterIds.has(row.id));
  const updateCounts = new Map();
  for (const row of existingListings) {
    updateCounts.set(row.updated_at, (updateCounts.get(row.updated_at) || 0) + 1);
  }
  const starterCohortTimestamp = [...updateCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (starterCohortTimestamp) {
      const update = database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ? AND updated_at = ?");
      const now = new Date().toISOString();
      for (const property of starterListings) {
        const existing = existingListings.find((row) => row.id === property.id);
        if (existing && existing.updated_at === starterCohortTimestamp) {
          update.run(JSON.stringify(property), now, property.id, starterCohortTimestamp);
        }
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('starter-listings-refresh-v2', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'starter-listings-refresh-v3'").get()) {
  const seedPath = path.join(ROOT, "data", "properties.seed.json");
  const starterListings = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const starterIds = new Set(starterListings.map((property) => property.id));
  const existingListings = database.prepare("SELECT id, updated_at FROM properties").all()
    .filter((row) => starterIds.has(row.id));
  const updateCounts = new Map();
  for (const row of existingListings) {
    updateCounts.set(row.updated_at, (updateCounts.get(row.updated_at) || 0) + 1);
  }
  const starterCohortTimestamp = [...updateCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (starterCohortTimestamp) {
      const update = database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ? AND updated_at = ?");
      const now = new Date().toISOString();
      for (const property of starterListings) {
        const existing = existingListings.find((row) => row.id === property.id);
        if (existing && existing.updated_at === starterCohortTimestamp) {
          update.run(JSON.stringify(property), now, property.id, starterCohortTimestamp);
        }
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('starter-listings-refresh-v3', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'starter-listings-refresh-v4'").get()) {
  const seedPath = path.join(ROOT, "data", "properties.seed.json");
  const starterListings = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const starterIds = new Set(starterListings.map((property) => property.id));
  const existingListings = database.prepare("SELECT id, updated_at FROM properties").all()
    .filter((row) => starterIds.has(row.id));
  const updateCounts = new Map();
  for (const row of existingListings) {
    updateCounts.set(row.updated_at, (updateCounts.get(row.updated_at) || 0) + 1);
  }
  const starterCohortTimestamp = [...updateCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (starterCohortTimestamp) {
      const update = database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ? AND updated_at = ?");
      const now = new Date().toISOString();
      for (const property of starterListings) {
        const existing = existingListings.find((row) => row.id === property.id);
        if (existing && existing.updated_at === starterCohortTimestamp) {
          update.run(JSON.stringify(property), now, property.id, starterCohortTimestamp);
        }
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('starter-listings-refresh-v4', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'townhouse-cover-refresh-v1'").get()) {
  const seedPath = path.join(ROOT, "data", "properties.seed.json");
  const starterListings = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const townhouseSeed = starterListings.find((property) => property.id === "juniper-row-townhouse");
  const previousImage = "https://plus.unsplash.com/premium_photo-1705342249387-9463fddd39a3?auto=format&fit=crop&w=1200&q=80";
  const existingRow = database.prepare("SELECT data, updated_at FROM properties WHERE id = ?")
    .get("juniper-row-townhouse");
  const starterIds = new Set(starterListings.map((property) => property.id));
  const updateCounts = new Map();
  for (const row of database.prepare("SELECT id, updated_at FROM properties").all()) {
    if (!starterIds.has(row.id)) continue;
    updateCounts.set(row.updated_at, (updateCounts.get(row.updated_at) || 0) + 1);
  }
  const starterCohortTimestamp = [...updateCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  database.exec("BEGIN IMMEDIATE");
  try {
    if (existingRow && existingRow.updated_at === starterCohortTimestamp) {
      const property = JSON.parse(existingRow.data);
      if (property.image === previousImage) {
        property.image = townhouseSeed.image;
        const cover = property.images?.find((photo) => photo.url === previousImage);
        if (cover) {
          cover.url = townhouseSeed.image;
        } else {
          property.images = [{ url: townhouseSeed.image, label: "Interior" }, ...(property.images || [])].slice(0, 8);
        }
        database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
          .run(JSON.stringify(property), new Date().toISOString(), "juniper-row-townhouse", starterCohortTimestamp);
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('townhouse-cover-refresh-v1', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT value FROM settings WHERE key = 'townhouse-cover-refresh-v2'").get()) {
  const previousImage = "/uploads/f234a612-4b76-482c-9e5b-dce6e02c2e05.jpg";
  const replacementImage = "/assets/townhouse-cover.jpg";
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT data FROM properties WHERE id = ?").get("juniper-row-townhouse");
    if (row) {
      const property = JSON.parse(row.data);
      if (property.image === previousImage) {
        property.image = replacementImage;
        const cover = property.images?.find((photo) => photo.url === previousImage);
        if (cover) cover.url = replacementImage;
        database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(property), new Date().toISOString(), "juniper-row-townhouse");
      }
    }
    database.prepare("INSERT INTO settings (key, value) VALUES ('townhouse-cover-refresh-v2', 'true')").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
}

function respond(response, status, data, headers = {}) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(body);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(request, limit = JSON_BODY_LIMIT) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw fail(415, "Send the request as JSON.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail(413, "The request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "The request contains invalid JSON.");
  }
}

function getCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(cookieHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function getSession(request) {
  const sessionId = getCookies(request)[SESSION_COOKIE];
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
  return session;
}

function requireSession(request) {
  const session = getSession(request);
  if (!session) throw fail(401, "Please sign in to manage properties.");
  return session;
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) throw fail(403, "The request origin could not be verified.");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw fail(403, "The request origin could not be verified.");
  }
  if (parsedOrigin.host !== request.headers.host || parsedOrigin.origin === "null") {
    throw fail(403, "Requests must come from this website.");
  }
}

function requireCsrf(request, session) {
  assertSameOrigin(request);
  const token = request.headers["x-csrf-token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || token.length !== session.csrfToken.length
    || !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) {
    throw fail(403, "Your secure session expired. Sign in again.");
  }
}

function addSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "));
  if (PRODUCTION) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function checkLoginRateLimit(address) {
  const now = Date.now();
  const attempts = (loginAttempts.get(address) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 5) {
    const waitSeconds = Math.max(1, Math.ceil((15 * 60 * 1000 - (now - attempts[0])) / 1000));
    throw fail(429, `Too many sign-in attempts. Try again in ${waitSeconds} seconds.`);
  }
  attempts.push(now);
  loginAttempts.set(address, attempts);
}

function validEmail(email) {
  return typeof email === "string" && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function checkSupabaseResult(result, operation) {
  if (result.error) throw new Error(`Supabase ${operation} failed: ${result.error.message}`);
  return result.data;
}

async function initializeSupabase() {
  const bucketResult = await supabase.storage.getBucket(SUPABASE_PHOTO_BUCKET);
  const bucket = checkSupabaseResult(bucketResult, "photo bucket check");
  if (!bucket.public) {
    throw new Error(`Supabase storage bucket "${SUPABASE_PHOTO_BUCKET}" must be public for property photos.`);
  }

  const properties = checkSupabaseResult(
    await supabase.from("properties").select("id").limit(1),
    "property table check"
  );
  if (properties.length > 0) return;

  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "properties.seed.json"), "utf8"));
  const timestamp = new Date().toISOString();
  checkSupabaseResult(
    await supabase.from("properties").insert(seed.map((property) => ({
      id: property.id,
      data: property,
      updated_at: timestamp
    }))),
    "starter listings initialization"
  );
}

async function getAdministrator() {
  if (!USE_SUPABASE) return database.prepare("SELECT id, email, password_salt, password_hash, created_at FROM administrators WHERE id = 1").get() || null;
  return checkSupabaseResult(
    await supabase.from("administrators").select("id, email, password_salt, password_hash, created_at").eq("id", 1).maybeSingle(),
    "administrator lookup"
  );
}

async function getAdministratorByEmail(email) {
  if (!USE_SUPABASE) {
    return database.prepare("SELECT id, email, password_salt, password_hash FROM administrators WHERE email = ? COLLATE NOCASE").get(email) || null;
  }
  return checkSupabaseResult(
    await supabase.from("administrators").select("id, email, password_salt, password_hash").eq("email", email).maybeSingle(),
    "administrator lookup"
  );
}

async function createAdministrator(email, credentials) {
  const administrator = {
    id: 1,
    email,
    password_salt: credentials.salt,
    password_hash: credentials.hash,
    created_at: new Date().toISOString()
  };
  if (!USE_SUPABASE) {
    database.prepare("INSERT INTO administrators (id, email, password_salt, password_hash, created_at) VALUES (1, ?, ?, ?, ?)")
      .run(administrator.email, administrator.password_salt, administrator.password_hash, administrator.created_at);
    return;
  }
  const result = await supabase.from("administrators").insert(administrator);
  if (result.error?.code === "23505") throw fail(409, "An admin account already exists. Sign in instead.");
  checkSupabaseResult(result, "administrator creation");
}

async function updateAdministrator(credentials) {
  if (!USE_SUPABASE) {
    database.prepare("UPDATE administrators SET password_salt = ?, password_hash = ? WHERE id = 1")
      .run(credentials.salt, credentials.hash);
    return;
  }
  checkSupabaseResult(
    await supabase.from("administrators")
      .update({ password_salt: credentials.salt, password_hash: credentials.hash })
      .eq("id", 1),
    "administrator password update"
  );
}

async function getProperty(id) {
  if (!USE_SUPABASE) return database.prepare("SELECT data FROM properties WHERE id = ?").get(id) || null;
  return checkSupabaseResult(
    await supabase.from("properties").select("data").eq("id", id).maybeSingle(),
    "property lookup"
  );
}

async function deleteProperty(id) {
  if (!USE_SUPABASE) {
    database.prepare("DELETE FROM properties WHERE id = ?").run(id);
    return;
  }
  checkSupabaseResult(await supabase.from("properties").delete().eq("id", id), "property deletion");
}

async function getActivity() {
  if (!USE_SUPABASE) return database.prepare("SELECT message, time FROM activity ORDER BY id DESC LIMIT 30").all();
  return checkSupabaseResult(
    await supabase.from("activity").select("message, time").order("id", { ascending: false }).limit(30),
    "activity lookup"
  );
}

async function clearActivity() {
  if (!USE_SUPABASE) {
    database.prepare("DELETE FROM activity").run();
    return;
  }
  checkSupabaseResult(await supabase.from("activity").delete().neq("id", 0), "activity clearing");
}

async function checkDatabaseHealth() {
  if (!USE_SUPABASE) {
    database.prepare("SELECT 1").get();
    return;
  }
  checkSupabaseResult(await supabase.from("properties").select("id").limit(1), "health check");
}

function isValidPhotoUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return false;
  let photoUrl;
  try {
    photoUrl = new URL(value, "http://localhost");
  } catch {
    return false;
  }
  return photoUrl.protocol === "https:"
    || (photoUrl.origin === "http://localhost" && photoUrl.pathname === "/assets/townhouse-cover.jpg")
    || (photoUrl.origin === "http://localhost" && /^\/uploads\/[a-f0-9-]+\.jpg$/.test(photoUrl.pathname));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, PASSWORD_SCRYPT_OPTIONS);
  return { salt: salt.toString("base64url"), hash: Buffer.from(derived).toString("hex") };
}

function normalizeProperty(input, id) {
  const allowedTypes = ["Apartment", "House", "Condo", "Townhouse", "Duplex", "Studio"];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Enter valid property details.");
  if (input.id && (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id))) {
    throw fail(400, "The property identifier is invalid.");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const type = typeof input.type === "string" ? input.type : "";
  const city = typeof input.city === "string" ? input.city.trim() : "";
  const neighborhood = typeof input.neighborhood === "string" ? input.neighborhood.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const image = typeof input.image === "string" ? input.image.trim() : "";
  const price = Number(input.price);
  const beds = Number(input.beds);
  const baths = Number(input.baths);
  const size = Number(input.size);
  const features = input.features === undefined ? [] : input.features;
  const images = input.images === undefined ? [{ url: image, label: "Interior" }] : input.images;
  const validImageLabels = ["Interior", "Bedroom", "Kitchen", "Bathroom", "Amenities", "Other"];

  if (!name || name.length > 80 || !allowedTypes.includes(type) || !city || city.length > 60
    || !neighborhood || neighborhood.length > 60 || !description || description.length > 600
    || !Number.isSafeInteger(price) || price < 1 || price > 1_000_000
    || !Number.isInteger(beds) || beds < 0 || beds > 30
    || !Number.isFinite(baths) || baths < 0 || baths > 30 || baths * 2 % 1 !== 0
    || !Number.isSafeInteger(size) || size < 1 || size > 100_000
    || !image || image.length > 2048 || !Array.isArray(features) || features.length > 20
    || features.some((feature) => typeof feature !== "string" || feature.trim().length > 80)
    || !Array.isArray(images) || images.length < 1 || images.length > 8
    || images.some((photo) => !photo || typeof photo !== "object" || Array.isArray(photo)
      || !isValidPhotoUrl(photo.url) || !validImageLabels.includes(photo.label))
    || (input.furnished !== undefined && typeof input.furnished !== "boolean")
    || (input.indexable !== undefined && typeof input.indexable !== "boolean")
    || typeof input.available !== "boolean") {
    throw fail(400, "Check the property name, type, rent, location, size, description, photo gallery, and features.");
  }
  const normalizedFeatures = features.map((feature) => feature.trim()).filter(Boolean);
  if (!isValidPhotoUrl(image)) {
    throw fail(400, "Photos must use a secure https:// link or an uploaded photo.");
  }
  const normalizedImages = images.map((photo) => ({ url: photo.url.trim(), label: photo.label }));
  const primaryImage = normalizedImages.find((photo) => photo.url === image) || { url: image, label: "Interior" };

  return {
    id,
    name,
    type,
    city,
    neighborhood,
    price,
    beds,
    baths,
    size,
    description,
    features: normalizedFeatures,
    image,
    images: [primaryImage, ...normalizedImages.filter((photo) => photo.url !== image)],
    furnished: input.furnished === true,
    available: Boolean(input.available),
    indexable: input.indexable === true
  };
}

async function getPublicProperties() {
  const properties = await getAllProperties();
  return properties.filter((property) => property.available === true);
}

async function getAllProperties() {
  if (!USE_SUPABASE) {
    return database.prepare("SELECT data FROM properties ORDER BY updated_at DESC")
      .all().map((row) => JSON.parse(row.data));
  }
  return checkSupabaseResult(
    await supabase.from("properties").select("data").order("updated_at", { ascending: false }),
    "property list"
  ).map((row) => row.data);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function propertySlug(property) {
  const title = `${property.name}-${property.neighborhood}-${property.city}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${title.slice(0, 120).replace(/-+$/g, "")}-${property.id}`;
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029"
  })[character]);
}

function propertyPage(property) {
  const canonical = `${PUBLIC_URL}/properties/${propertySlug(property)}`;
  const title = `${property.beds === 0 ? "Studio" : `${property.beds}-Bedroom`} ${property.type} for Rent in ${property.city} | James Property MNG`;
  const description = `${property.name} in ${property.neighborhood}, ${property.city}. ${property.beds === 0 ? "Studio" : `${property.beds}-bedroom`} ${property.type.toLowerCase()} for $${property.price.toLocaleString("en-US")} per month. ${property.description}`.slice(0, 160);
  const images = (Array.isArray(property.images) ? property.images : [{ url: property.image, label: "Interior" }])
    .filter((photo) => photo && typeof photo.url === "string" && photo.url)
    .slice(0, 8);
  const hero = images.find((photo) => photo.url === property.image) || images[0];
  const indexable = SEO_INDEXING_ENABLED && property.indexable === true && property.available;
  const imageMarkup = images.map((photo, index) => `
      <figure class="seo-property-photo">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(`${property.name} ${photo.label.toLowerCase()} photo`)}" width="1200" height="800" ${index === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
        <figcaption>${escapeHtml(photo.label)}</figcaption>
      </figure>`).join("");
  const structuredData = indexable ? jsonForHtml({
    "@context": "https://schema.org",
    "@type": property.type === "House" ? "House" : "Apartment",
    name: property.name,
    description: property.description,
    image: images.map((photo) => new URL(photo.url, PUBLIC_URL).href),
    numberOfBedrooms: property.beds,
    numberOfBathroomsTotal: property.baths,
    floorSize: { "@type": "QuantitativeValue", value: property.size, unitCode: "FTK" },
    address: {
      "@type": "PostalAddress",
      addressLocality: property.city,
      addressRegion: "California",
      addressCountry: "US"
    },
    offers: {
      "@type": "Offer",
      price: property.price,
      priceCurrency: "USD",
      availability: property.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: canonical,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: property.price,
        priceCurrency: "USD",
        unitText: "MONTH"
      },
      businessFunction: "http://purl.org/goodrelations/v1#LeaseOut"
    }
  }) : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${indexable ? "index,follow" : "noindex,nofollow"}">
  <meta name="theme-color" content="#f7f6f1">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="James Property MNG">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  ${hero ? `<meta property="og:image" content="${escapeHtml(new URL(hero.url, PUBLIC_URL).href)}">` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  ${structuredData ? `<script type="application/ld+json">${structuredData}</script>` : ""}
</head>
<body>
  <header class="site-header seo-property-header">
    <a class="brand" href="/" aria-label="James Property MNG home"><span class="brand-mark" aria-hidden="true"><span>J</span></span><span class="brand-name">JAMES PROPERTY <span>MNG</span></span></a>
    <nav class="main-nav" aria-label="Main navigation"><a href="/#homes">Homes</a><a href="/#about">About us</a><a href="/#approach">Our approach</a><a href="/#contact">Contact</a></nav>
    <a class="button button-small header-cta" href="/#homes">Explore homes <span aria-hidden="true">↗</span></a>
  </header>
  <main class="seo-property-page">
    <nav class="seo-breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/#homes">Homes</a><span aria-hidden="true">/</span><span>${escapeHtml(property.name)}</span></nav>
    <header class="seo-property-intro">
      <p class="eyebrow"><span class="eyebrow-line"></span> ${escapeHtml(property.neighborhood)} · ${escapeHtml(property.city)}, California</p>
      <h1>${escapeHtml(property.name)}</h1>
      <p>${property.beds === 0 ? "Studio" : `${property.beds} ${property.beds === 1 ? "bedroom" : "bedrooms"}`} · ${property.baths} ${property.baths === 1 ? "bathroom" : "bathrooms"} · ${Number(property.size).toLocaleString("en-US")} sq ft · ${escapeHtml(property.type)}</p>
      <div class="seo-property-price">$${property.price.toLocaleString("en-US")} <span>/ month</span></div>
      <p class="seo-availability">${property.available ? "Currently listed as available" : "This home is currently unavailable"}</p>
    </header>
    ${hero ? `<div class="seo-property-gallery">${imageMarkup}</div>` : ""}
    <div class="seo-property-columns">
      <section><h2>About this home</h2><p>${escapeHtml(property.description)}</p></section>
      <section><h2>Home features</h2><ul>${property.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul></section>
      <aside class="seo-property-contact"><h2>${property.available ? "Ask about this home" : "Find another home"}</h2><p>${property.available ? "Contact James Property MNG to ask about availability and arrange a conversation." : "This listing is not currently available. Browse the collection for other homes."}</p>${property.available ? `<a class="button" href="mailto:jamespropertymng@gmail.com?subject=${encodeURIComponent(`Property enquiry: ${property.name}`)}">Email us about this home <span aria-hidden="true">↗</span></a><a class="property-phone" href="tel:+18056747745">+1 (805) 674-7745</a>` : '<a class="button" href="/#homes">Explore available homes <span aria-hidden="true">↗</span></a>'}</aside>
    </div>
  </main>
  <footer class="site-footer"><a class="brand footer-brand" href="/" aria-label="James Property MNG home"><span class="brand-mark" aria-hidden="true"><span>J</span></span><span class="brand-name">JAMES PROPERTY <span>MNG</span></span></a><span>© ${new Date().getFullYear()} James Property MNG</span><a href="/#contact">Contact</a></footer>
</body>
</html>`;
}

async function sitemapXml() {
  if (!SEO_INDEXING_ENABLED) {
    return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
  }
  const entries = [{ loc: `${PUBLIC_URL}/`, lastmod: new Date().toISOString().slice(0, 10) }];
  const rows = USE_SUPABASE
    ? checkSupabaseResult(
      await supabase.from("properties").select("data, updated_at").order("id"),
      "sitemap listing lookup"
    )
    : database.prepare("SELECT data, updated_at FROM properties ORDER BY id").all();
  for (const row of rows) {
    const property = USE_SUPABASE ? row.data : JSON.parse(row.data);
    if (property.indexable !== true || property.available !== true) continue;
    entries.push({
      loc: `${PUBLIC_URL}/properties/${propertySlug(property)}`,
      lastmod: row.updated_at.slice(0, 10)
    });
  }
  const urls = entries.map((entry) => `  <url><loc>${escapeHtml(entry.loc)}</loc><lastmod>${entry.lastmod}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function renderHomepage(request, response) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const canonical = `${PUBLIC_URL}/`;
  const indexPolicy = SEO_INDEXING_ENABLED ? "index,follow" : "noindex,nofollow";
  html = html.replaceAll("__SEO_CANONICAL__", escapeHtml(canonical))
    .replaceAll("__SEO_ROBOTS__", indexPolicy)
    .replaceAll("__SEO_PUBLIC_URL__", escapeHtml(canonical))
    .replace("<html lang=\"en\">", `<html lang="en" data-public-robots="${indexPolicy}">`);
  const structuredData = SEO_INDEXING_ENABLED ? `<script type="application/ld+json">${jsonForHtml([
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "James Property MNG",
      url: canonical,
      email: "jamespropertymng@gmail.com",
      telephone: "+1-805-674-7745",
      sameAs: ["https://instagram.com/jamesproperty.mng432"]
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "James Property MNG",
      url: canonical,
      inLanguage: "en-US"
    }
  ])}</script>` : "";
  html = html.replace("</head>", `${structuredData}\n</head>`);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Robots-Tag": indexPolicy
  });
  response.end(request.method === "HEAD" ? undefined : html);
}

async function saveProperty(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw fail(400, "Enter valid property details.");
  }
  const id = typeof input.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(input.id)
    ? input.id
    : randomUUID();
  const property = normalizeProperty(input, id);
  const updatedAt = new Date().toISOString();
  if (!USE_SUPABASE) {
    database.prepare(`
      INSERT INTO properties (id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(property), updatedAt);
  } else {
    checkSupabaseResult(
      await supabase.from("properties").upsert({ id, data: property, updated_at: updatedAt }),
      "property save"
    );
  }
  return property;
}

async function recordActivity(message) {
  if (!USE_SUPABASE) {
    database.prepare("INSERT INTO activity (message, time) VALUES (?, ?)").run(message.slice(0, 300), new Date().toISOString());
    database.prepare("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 30)").run();
    return;
  }
  checkSupabaseResult(
    await supabase.from("activity").insert({ message: message.slice(0, 300), time: new Date().toISOString() }),
    "activity write"
  );
  const older = checkSupabaseResult(
    await supabase.from("activity").select("id").order("id", { ascending: false }).range(30, 9999),
    "activity retention lookup"
  );
  if (older.length > 0) {
    checkSupabaseResult(
      await supabase.from("activity").delete().in("id", older.map((entry) => entry.id)),
      "activity retention cleanup"
    );
  }
}

function sendFile(request, response, filePath, contentType) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": contentType.startsWith("image/") ? "public, max-age=31536000, immutable" : "no-cache"
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/api/listings") {
    return respond(response, 200, await getPublicProperties());
  }
  if (method === "GET" && pathname === "/api/admin/status") {
    const admin = await getAdministrator();
    return respond(response, 200, {
      configured: Boolean(admin),
      canSetup: !PRODUCTION && isLoopbackAddress(request.socket.remoteAddress)
    });
  }
  if (pathname === "/api/admin/setup" && method === "POST") {
    assertSameOrigin(request);
    const originHost = new URL(request.headers.origin).hostname;
    if (PRODUCTION || !isLoopbackAddress(request.socket.remoteAddress)
      || !["127.0.0.1", "localhost", "::1"].includes(originHost)) {
      throw fail(403, "First-time account creation is available only from this computer.");
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw fail(400, "Enter a valid email address and password.");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!validEmail(email) || password.length < 14 || password.length > 128) {
      throw fail(400, "Use a valid email address and a password between 14 and 128 characters.");
    }
    const credentials = await hashPassword(password);
    if (await getAdministrator()) throw fail(409, "An admin account already exists. Sign in instead.");
    await createAdministrator(email, credentials);
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    sessions.set(sessionId, { email, csrfToken, expiresAt: Date.now() + SESSION_LIFETIME_MS });
    const secure = PRODUCTION ? "; Secure" : "";
    return respond(response, 201, { email, csrfToken }, {
      "Set-Cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`
    });
  }
  if (pathname === "/api/admin/login" && method === "POST") {
    assertSameOrigin(request);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw fail(400, "Enter your admin email and password.");
    }
    const address = request.socket.remoteAddress || "unknown";
    checkLoginRateLimit(address);
    const admin = await getAdministratorByEmail(typeof body.email === "string" ? body.email.trim().toLowerCase() : "");
    const salt = admin ? Buffer.from(admin.password_salt, "base64url") : Buffer.alloc(16);
    const expected = admin ? Buffer.from(admin.password_hash, "hex") : Buffer.alloc(PASSWORD_KEY_LENGTH);
    const actual = await scryptAsync(typeof body.password === "string" ? body.password : "", salt, PASSWORD_KEY_LENGTH, PASSWORD_SCRYPT_OPTIONS);
    const matches = timingSafeEqual(Buffer.from(actual), expected);
    if (!admin || !matches) throw fail(401, "The email or password is incorrect.");
    loginAttempts.delete(address);
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    sessions.set(sessionId, { email: admin.email, csrfToken, expiresAt: Date.now() + SESSION_LIFETIME_MS });
    const secure = PRODUCTION ? "; Secure" : "";
    return respond(response, 200, { email: admin.email, csrfToken }, {
      "Set-Cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`
    });
  }
  if (method === "GET" && pathname === "/api/admin/session") {
    const session = getSession(request);
    return respond(response, 200, session ? { authenticated: true, email: session.email, csrfToken: session.csrfToken } : { authenticated: false });
  }
  if (pathname.startsWith("/api/admin/")) {
    const session = requireSession(request);
    if (method !== "GET") requireCsrf(request, session);
    if (pathname === "/api/admin/logout" && method === "POST") {
      const cookie = getCookies(request)[SESSION_COOKIE];
      sessions.delete(cookie);
      return respond(response, 200, { ok: true }, {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${PRODUCTION ? "; Secure" : ""}`
      });
    }
    if (pathname === "/api/admin/listings" && method === "GET") {
      return respond(response, 200, await getAllProperties());
    }
    if (pathname === "/api/admin/listings" && method === "POST") {
      const input = await readJson(request);
      const property = await saveProperty(input);
      await recordActivity(`${input.id ? "Updated" : "Added"} ${property.name} · ${property.price}/month`);
      return respond(response, 200, property);
    }
    const listingMatch = pathname.match(/^\/api\/admin\/listings\/([a-zA-Z0-9_-]{1,100})$/);
    if (listingMatch && method === "PATCH") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || typeof body.available !== "boolean") {
        throw fail(400, "Choose whether the home is available.");
      }
      const row = await getProperty(listingMatch[1]);
      if (!row) throw fail(404, "That property could not be found.");
      const property = { ...(typeof row.data === "string" ? JSON.parse(row.data) : row.data), available: body.available };
      await saveProperty(property);
      await recordActivity(`${property.available ? "Published" : "Paused"} ${property.name}`);
      return respond(response, 200, property);
    }
    if (listingMatch && method === "DELETE") {
      const row = await getProperty(listingMatch[1]);
      if (!row) throw fail(404, "That property could not be found.");
      const property = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      await deleteProperty(listingMatch[1]);
      await recordActivity(`Deleted ${property.name}`);
      return respond(response, 200, { ok: true });
    }
    if (pathname === "/api/admin/upload" && method === "POST") {
      const body = await readJson(request, PHOTO_BODY_LIMIT);
      if (!body || typeof body !== "object" || typeof body.image !== "string" || body.image.length > 1_900_000) {
        throw fail(400, "Choose a photo smaller than 1.5 MB after resizing.");
      }
      const match = body.image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw fail(400, "Choose a valid JPEG photo from your device.");
      const image = Buffer.from(match[1], "base64");
      if (image.length > 1_500_000 || image.length < 4
        || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
        throw fail(400, "The selected photo is invalid or too large.");
      }
      const filename = `${randomUUID()}.jpg`;
      if (!USE_SUPABASE) {
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), image, { flag: "wx", mode: 0o600 });
        return respond(response, 201, { image: `/uploads/${filename}` });
      }
      const upload = await supabase.storage.from(SUPABASE_PHOTO_BUCKET).upload(filename, image, {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: false
      });
      checkSupabaseResult(upload, "photo upload");
      return respond(response, 201, {
        image: supabase.storage.from(SUPABASE_PHOTO_BUCKET).getPublicUrl(filename).data.publicUrl
      });
    }
    if (pathname === "/api/admin/summary" && method === "GET") {
      const properties = await getAllProperties();
      const activity = await getActivity();
      const available = properties.filter((property) => property.available).length;
      return respond(response, 200, {
        total: properties.length,
        available,
        unavailable: properties.length - available,
        activityCount: activity.length,
        activity
      });
    }
    if (pathname === "/api/admin/backup" && method === "GET") {
      const backup = {
        format: "james-property-mng-backup-v1",
        exportedAt: new Date().toISOString(),
        properties: await getAllProperties(),
        activity: await getActivity()
      };
      return respond(response, 200, backup, {
        "Content-Disposition": `attachment; filename="james-property-backup-${new Date().toISOString().slice(0, 10)}.json"`
      });
    }
    if (pathname === "/api/admin/activity" && method === "DELETE") {
      await clearActivity();
      return respond(response, 200, { ok: true });
    }
    throw fail(404, "This request is not available.");
  }
  return respond(response, 404, { error: "This request is not available." });
}

async function staticFile(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  if (url.pathname === "/healthz") {
    try {
      await checkDatabaseHealth();
      return respond(response, 200, { status: "ok" });
    } catch (error) {
      console.error("Health check failed:", error);
      return respond(response, 503, { error: "The service is temporarily unavailable." });
    }
  }
  if (url.pathname === "/sitemap.xml") {
    response.writeHead(200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex"
    });
    response.end(request.method === "HEAD" ? undefined : await sitemapXml());
    return;
  }
  if (url.pathname === "/robots.txt") {
    const body = PRODUCTION
      ? `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n";
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex"
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  if (url.pathname === "/index.html") {
    response.writeHead(301, { Location: `${PUBLIC_URL}/`, "Cache-Control": "no-cache" });
    response.end();
    return;
  }
  if (url.pathname.startsWith("/properties/")) {
    const slug = url.pathname.slice("/properties/".length);
    const property = (await getAllProperties()).find((item) => propertySlug(item) === slug);
    if (!property) {
      response.writeHead(404, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow"
      });
      response.end(request.method === "HEAD" ? undefined : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>Home not found | James Property MNG</title><link rel="stylesheet" href="/styles.css"></head><body><main class="seo-not-found"><p class="eyebrow">James Property MNG</p><h1>This home could not be found.</h1><p>The listing may have been removed or its address may have changed.</p><a class="button" href="/#homes">Browse available homes</a></main></body></html>`);
      return;
    }
    const indexable = SEO_INDEXING_ENABLED && property.indexable === true && property.available;
    const html = propertyPage(property);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Robots-Tag": indexable ? "index, follow" : "noindex, nofollow"
    });
    response.end(request.method === "HEAD" ? undefined : html);
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (pathname.startsWith("/uploads/")) {
    const filename = pathname.slice("/uploads/".length);
    if (!/^[a-f0-9-]{36}\.jpg$/.test(filename)) {
      response.writeHead(404);
      response.end();
      return;
    }
    sendFile(request, response, path.join(UPLOAD_DIR, filename), "image/jpeg");
    return;
  }
  const assets = new Map([
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/assets/townhouse-cover.jpg", ["assets/townhouse-cover.jpg", "image/jpeg"]],
    ["/START-HERE.md", ["START-HERE.md", "text/plain; charset=utf-8"]],
    ["/google3dbfeb8e4af44aae.html", ["google3dbfeb8e4af44aae.html", "text/html; charset=utf-8"]],
    ["/googled05da430302d6668.html", ["googled05da430302d6668.html", "text/html; charset=utf-8"]]
  ]);
  const asset = assets.get(pathname);
  if (pathname === "/") {
    renderHomepage(request, response);
    return;
  }
  if (!asset) {
    response.writeHead(404, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow"
    });
    response.end(request.method === "HEAD" ? undefined : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Page not found | James Property MNG</title></head><body><main><h1>Page not found</h1><a href="/">Return to James Property MNG</a></main></body></html>`);
    return;
  }
  sendFile(request, response, path.join(ROOT, asset[0]), asset[1]);
}

const server = http.createServer((request, response) => {
  addSecurityHeaders(response);
  if (PRODUCTION && request.url !== "/healthz" && !request.socket.encrypted
    && request.headers["x-forwarded-proto"] !== "https") {
    response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("HTTPS is required. Configure the hosting provider's trusted HTTPS proxy.");
    return;
  }
  if (request.method === "GET" && request.url === "/healthz") {
    checkDatabaseHealth().then(() => {
      respond(response, 200, { status: "ok" });
    }).catch((error) => {
      console.error("Health check failed:", error);
      respond(response, 503, { error: "The service is temporarily unavailable." });
    });
    return;
  }
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    respond(response, 400, { error: "The request URL is invalid." });
    return;
  }
  if (url.pathname.startsWith("/api/")) response.setHeader("X-Robots-Tag", "noindex, nofollow");
  const operation = url.pathname.startsWith("/api/")
    ? handleApi(request, response, url)
    : staticFile(request, response, url);
  operation.catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error.status >= 500 || !error.status) console.error(error);
    respond(response, error.status || 500, {
      error: error.status ? error.message : "The server could not complete the request."
    });
  });
});

function promptLine(prompt) {
  return new Promise((resolve) => {
    const readline = require("node:readline");
    const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
    interface_.question(prompt, (answer) => {
      interface_.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptLine(`${prompt} (hidden input requires a terminal): `);
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = "";
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (answer) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(Boolean(previousRaw));
      process.stdout.write(os.EOL);
      resolve(answer);
    };
    const onData = (data) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") {
          process.stdin.setRawMode(Boolean(previousRaw));
          process.exit(130);
        } else if (character === "\r" || character === "\n") {
          finish(value);
          return;
        } else if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function setupAdministrator(reset = false) {
  const existing = await getAdministrator();
  if (existing && !reset) throw new Error(`An admin account already exists (${existing.email}). Use the reset-admin command to change its password.`);
  const email = (process.argv[3] || await promptLine("Admin email address: ")).toLowerCase();
  if (!validEmail(email)) throw new Error("Enter a valid admin email address.");
  if (existing && email !== existing.email.toLowerCase()) {
    throw new Error("The email must match the existing admin account.");
  }
  let password;
  let confirmation;
  do {
    password = await promptHidden("Create a private password (at least 14 characters): ");
    if (password.length < 14 || password.length > 128) {
      process.stderr.write("Choose a password between 14 and 128 characters.\n");
      password = "";
      continue;
    }
    confirmation = await promptHidden("Confirm the password: ");
    if (password !== confirmation) process.stderr.write("Those passwords did not match. Try again.\n");
  } while (!password || password !== confirmation);

  const credentials = await hashPassword(password);
  if (existing) await updateAdministrator(credentials);
  else await createAdministrator(email, credentials);
  sessions.clear();
  process.stdout.write(existing
    ? `Admin password updated for ${email}.\n`
    : `Secure admin account created for ${email}.\n`);
  process.stdout.write("Your password is stored as a salted scrypt hash and was not saved in the website files.\n");
}

async function main() {
  const command = process.argv[2];
  if (USE_SUPABASE) await initializeSupabase();
  if (command === "setup-admin" || command === "reset-admin") {
    await setupAdministrator(command === "reset-admin");
    if (database) database.close();
    return;
  }
  const admin = await getAdministrator();
  server.listen(PORT, HOST, () => {
    const protocol = PRODUCTION ? "https" : "http";
    process.stdout.write(`James Property MNG is running behind ${protocol} at ${HOST}:${PORT}\n`);
    process.stdout.write(`Website: ${process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`}\n`);
    if (!PRODUCTION) process.stdout.write(`Admin sign-in: http://localhost:${PORT}/#manage\n`);
    if (!admin) {
      if (PRODUCTION) {
        process.stdout.write(`No admin account is configured. Create it in the private host shell with: npm run setup:admin -- ${process.env.ADMIN_EMAIL || "jamespropertymng@gmail.com"}\n`);
      } else {
        process.stdout.write("Create your admin account from this computer at the secure setup screen.\n");
      }
    }
    if (PRODUCTION && !USE_SUPABASE && !process.env.DATA_DIR) {
      console.warn("DATA_DIR is not set. Configure a persistent volume before deployment.");
    }
  });
}

main().catch((error) => {
  console.error(`Admin setup failed: ${error.message}`);
  process.exitCode = 1;
});
