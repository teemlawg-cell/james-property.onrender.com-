"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

test("starter refresh updates untouched listings without restoring deletions or overwriting edits", async () => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-seed-migration-test-"));
  const projectRoot = path.resolve(__dirname, "..");
  const seed = JSON.parse(fs.readFileSync(path.join(projectRoot, "data", "properties.seed.json"), "utf8"));
  const database = new DatabaseSync(path.join(temporaryData, "james-property.sqlite"));
  const legacyTimestamp = "2025-01-01T00:00:00.000Z";
  const editedTimestamp = "2025-02-01T00:00:00.000Z";
  const legacyPhoto = "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c";
  const deletedId = "casa-verde";
  const editedId = "oak-street-flat";
  const portSocket = net.createServer();
  let server;
  let baseUrl;

  try {
    database.exec(`
      CREATE TABLE properties (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('initial-seed-applied', 'true');
      INSERT INTO settings VALUES ('starter-listings-refresh-v1', 'true');
      INSERT INTO settings VALUES ('starter-listings-refresh-v2', 'true');
      INSERT INTO settings VALUES ('starter-listings-refresh-v3', 'true');
    `);
    const insert = database.prepare("INSERT INTO properties (id, data, updated_at) VALUES (?, ?, ?)");
    for (const property of seed) {
      if (property.id === deletedId) continue;
      const legacy = {
        ...property,
        price: property.id === editedId ? 1999 : property.price === 1750 ? 1600 : property.price,
        image: legacyPhoto,
        images: [{ url: legacyPhoto, label: "Interior" }]
      };
      insert.run(property.id, JSON.stringify(legacy), property.id === editedId ? editedTimestamp : legacyTimestamp);
    }
    insert.run("owner-custom-home", JSON.stringify({
      ...seed[0],
      id: "owner-custom-home",
      name: "Owner's custom home",
      image: legacyPhoto,
      images: [{ url: legacyPhoto, label: "Interior" }]
    }), legacyTimestamp);
    database.close();

    await new Promise((resolve, reject) => {
      portSocket.once("error", reject);
      portSocket.listen(0, "127.0.0.1", resolve);
    });
    const { port } = portSocket.address();
    await new Promise((resolve, reject) => portSocket.close((error) => error ? reject(error) : resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: { ...process.env, DATA_DIR: temporaryData, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

    let response;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Migration test server exited: ${serverOutput}`);
      try {
        response = await fetch(`${baseUrl}/api/listings`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(response?.status, 200, `Migration test server did not start: ${serverOutput}`);

    const listings = await response.json();
    assert.equal(listings.some((property) => property.id === deletedId), false);
    assert.equal(listings.find((property) => property.id === editedId).price, 1999);
    assert.equal(listings.find((property) => property.id === "willow-cottage").price, 1750);
    assert.equal(listings.find((property) => property.id === "willow-cottage").image, seed[0].image);
    assert.deepEqual(
      listings.find((property) => property.id === "willow-cottage").images,
      seed[0].images
    );
    const townhouse = listings.find((property) => property.id === "juniper-row-townhouse");
    assert.equal(townhouse.image, "/assets/townhouse-cover.jpg");
    assert.equal(townhouse.images[0].url, townhouse.image);
    assert.equal(listings.find((property) => property.id === "willow-cottage").images.some((photo) =>
      ["Exterior", "Surroundings"].includes(photo.label)), false);
    assert.equal(listings.find((property) => property.id === "owner-custom-home").image, legacyPhoto);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
});
