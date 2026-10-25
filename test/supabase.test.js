"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const starterListings = require("../data/properties.seed.json");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const socket = net.createServer();
  const port = await listen(socket);
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

test("Supabase mode seeds listings and persists uploaded photos remotely", async () => {
  const properties = [];
  let administrator = null;
  const photos = new Map();
  const supabaseMock = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/storage/v1/bucket/property-photos" && request.method === "GET") {
      return send(200, { id: "property-photos", name: "property-photos", public: true });
    }
    if (url.pathname.startsWith("/storage/v1/object/property-photos/") && request.method === "POST") {
      const filename = url.pathname.split("/").pop();
      photos.set(filename, await readBody(request));
      return send(200, { Key: `property-photos/${filename}` });
    }
    if (url.pathname === "/rest/v1/properties" && request.method === "GET") {
      return send(200, url.searchParams.get("select") === "id"
        ? properties.slice(0, 1).map(({ id }) => ({ id }))
        : properties);
    }
    if (url.pathname === "/rest/v1/properties" && request.method === "POST") {
      properties.push(...JSON.parse((await readBody(request)).toString("utf8")));
      response.writeHead(201);
      return response.end();
    }
    if (url.pathname === "/rest/v1/administrators" && request.method === "GET") {
      return send(200, administrator ? [administrator] : []);
    }
    if (url.pathname === "/rest/v1/administrators" && request.method === "POST") {
      administrator = JSON.parse((await readBody(request)).toString("utf8"));
      response.writeHead(201);
      return response.end();
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: `Unexpected mock request: ${request.method} ${url.pathname}` }));
  });

  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-supabase-test-"));
  const projectRoot = path.resolve(__dirname, "..");
  let server;
  let appPort;
  let supabasePort;
  try {
    supabasePort = await listen(supabaseMock);
    appPort = await unusedPort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    server = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATA_DIR: temporaryData,
        HOST: "127.0.0.1",
        PORT: String(appPort),
        SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

    let health;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Supabase test server exited: ${serverOutput}`);
      try {
        health = await fetch(`${baseUrl}/healthz`);
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(health?.status, 200, `Supabase test server did not start: ${serverOutput}`);

    const listings = await (await fetch(`${baseUrl}/api/listings`)).json();
    assert.deepEqual(listings, starterListings.filter((property) => property.available));

    const status = await (await fetch(`${baseUrl}/api/admin/status`)).json();
    assert.deepEqual(status, { configured: false, canSetup: true });
    const setup = await fetch(`${baseUrl}/api/admin/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "correct horse battery staple"
      })
    });
    assert.equal(setup.status, 201);
    assert.ok(administrator?.password_hash);

    const session = await setup.json();
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]).toString("base64");
    const upload = await fetch(`${baseUrl}/api/admin/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "X-CSRF-Token": session.csrfToken
      },
      body: JSON.stringify({ image: `data:image/jpeg;base64,${photo}` })
    });
    assert.equal(upload.status, 201, serverOutput);
    const uploadedImage = await upload.json();
    assert.match(uploadedImage.image, new RegExp(`^http://127\\.0\\.0\\.1:${supabasePort}/storage/v1/object/public/property-photos/`));
    assert.equal(photos.size, 1);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await new Promise((resolve) => supabaseMock.close(resolve));
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
});

test("initial Supabase migration preserves local listings, owner credentials, and uploaded photo URLs", async () => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-supabase-migration-test-"));
  const filename = "11111111-1111-4111-8111-111111111111.jpg";
  const localPhoto = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const property = {
    id: "owner-home",
    image: `/uploads/${filename}`,
    images: [{ url: `/uploads/${filename}`, label: "Living room" }],
    available: true
  };
  const database = new DatabaseSync(path.join(temporaryData, "james-property.sqlite"));
  database.exec(`
    CREATE TABLE properties (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE administrators (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE activity (id INTEGER PRIMARY KEY, message TEXT NOT NULL, time TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO properties VALUES (?, ?, ?)").run(
    property.id,
    JSON.stringify(property),
    "2026-01-01T00:00:00.000Z"
  );
  database.prepare("INSERT INTO administrators VALUES (1, ?, ?, ?, ?)").run(
    "owner@example.com",
    "local-salt",
    "local-password-hash",
    "2026-01-01T00:00:00.000Z"
  );
  database.close();
  fs.mkdirSync(path.join(temporaryData, "uploads"));
  fs.writeFileSync(path.join(temporaryData, "uploads", filename), localPhoto);

  let imported;
  let uploadedPhoto;
  const supabaseMock = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/storage/v1/bucket/property-photos" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ id: "property-photos", public: true }));
    }
    if (url.pathname === `/storage/v1/object/property-photos/${filename}` && request.method === "POST") {
      uploadedPhoto = await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ Key: `property-photos/${filename}` }));
    }
    if (url.pathname === "/rest/v1/rpc/import_initial_site_data" && request.method === "POST") {
      imported = JSON.parse((await readBody(request)).toString("utf8"));
      response.writeHead(204);
      return response.end();
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const port = await listen(supabaseMock);
    const migration = spawn(process.execPath, ["scripts/migrate-to-supabase.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        DATA_DIR: temporaryData,
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    migration.stdout.on("data", (chunk) => { output += chunk.toString(); });
    migration.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        migration.kill();
        reject(new Error(`Supabase data migration timed out: ${output}`));
      }, 15_000);
      migration.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      migration.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, output);
    assert.deepEqual(uploadedPhoto, localPhoto);
    assert.equal(imported.p_properties[0].data.image, `http://127.0.0.1:${port}/storage/v1/object/public/property-photos/${filename}`);
    assert.equal(imported.p_properties[0].data.images[0].url, imported.p_properties[0].data.image);
    assert.equal(imported.p_administrator.email, "owner@example.com");
    assert.equal(imported.p_administrator.password_hash, "local-password-hash");
    assert.equal(fs.existsSync(path.join(temporaryData, "uploads", filename)), true);
    const unchanged = new DatabaseSync(path.join(temporaryData, "james-property.sqlite"), { readOnly: true });
    assert.equal(JSON.parse(unchanged.prepare("SELECT data FROM properties WHERE id = ?").get(property.id).data).image, property.image);
    unchanged.close();
  } finally {
    await new Promise((resolve) => supabaseMock.close(resolve));
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
});
