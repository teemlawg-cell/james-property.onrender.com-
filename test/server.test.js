"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const starterListings = require("../data/properties.seed.json");
const { after, before, test } = require("node:test");

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-auth-test-"));
let serverProcess;
let baseUrl;
let cookie;
let csrfToken;

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(port) {
  let serverOutput = "";
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATA_DIR: temporaryData, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited: ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/admin/status`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Test server did not start: ${serverOutput}`);
}

async function api(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Origin", baseUrl);
  if (cookie) headers.set("Cookie", cookie);
  if (csrfToken && options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  if (options.body) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : options.body
  });
}

before(async () => {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  await startServer(port);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  fs.rmSync(temporaryData, { recursive: true, force: true });
});

test("public listings are readable but private changes require an owner session", async () => {
  assert.equal(new Set(starterListings.map((listing) => listing.image)).size, starterListings.length);
  const availableStarterListings = starterListings.filter((listing) => listing.available);
  assert.equal(new Set(availableStarterListings.map((listing) => listing.image)).size, availableStarterListings.length);
  assert.equal(starterListings.every((listing) => listing.images.every((photo) =>
    !["Exterior", "Surroundings"].includes(photo.label))), true);
  const listingsResponse = await api("/api/listings");
  assert.equal(listingsResponse.status, 200);
  const listings = await listingsResponse.json();
  assert.equal(listings.length, 10);
  assert.equal(listings.some((listing) => listing.available === false), false);
  assert.deepEqual(
    [...new Set(listings.map((listing) => listing.city))].sort(),
    ["Ceres", "Hawthorne", "Long Beach", "Los Angeles", "Oak Park", "Riverside", "Sacramento", "San Pedro"].sort()
  );
  assert.equal(listings.filter((listing) => listing.furnished).length, 1);
  const furnishedListing = listings.find((listing) => listing.furnished);
  assert.equal(furnishedListing.beds, 2);
  assert.equal(furnishedListing.price, 1750);
  assert.equal(new Set(listings.map((listing) => listing.image)).size, listings.length);
  const townhouse = listings.find((listing) => listing.id === "juniper-row-townhouse");
  assert.equal(townhouse.image, "/assets/townhouse-cover.jpg");
  assert.equal(townhouse.images[0].url, townhouse.image);
  const townhouseImageResponse = await fetch(`${baseUrl}${townhouse.image}`);
  assert.equal(townhouseImageResponse.status, 200);
  assert.match(townhouseImageResponse.headers.get("content-type"), /image\/jpeg/);
  assert.equal((await api("/healthz")).status, 200);
  for (const listing of listings) {
    assert.ok(listing.beds >= 1 && listing.beds <= 3);
    assert.equal(typeof listing.furnished, "boolean");
    assert.equal(listing.images.length, 3);
    assert.equal(listing.images[0].url, listing.image);
    assert.deepEqual(listing.images.map((photo) => photo.label), ["Interior", "Kitchen", "Bathroom"]);
    assert.equal(listing.images.some((photo) => ["Exterior", "Surroundings"].includes(photo.label)), false);
    assert.equal(new Set(listing.images.map((photo) => photo.url)).size, listing.images.length);
    if (listing.beds === 1) assert.ok(listing.price >= 800 && listing.price <= 1000);
    if (listing.beds === 2) {
      assert.ok(listing.price >= 1150);
      assert.ok(listing.price <= (listing.furnished ? 1750 : 1700));
    }
    if (listing.beds === 3) assert.ok(listing.price >= 2000 && listing.price <= 3000);
  }
  assert.equal((await api("/api/admin/listings")).status, 401);
  assert.equal((await api("/api/admin/backup")).status, 401);
});

test("first admin signup is localhost-only, one time, and requires a strong password", async () => {
  assert.equal((await api("/api/admin/status")).status, 200);
  const weak = await api("/api/admin/setup", {
    method: "POST",
    body: { email: "jamespropertymng@gmail.com", password: "short" }
  });
  assert.equal(weak.status, 400);

  const created = await api("/api/admin/setup", {
    method: "POST",
    body: { email: "jamespropertymng@gmail.com", password: "correct horse battery staple" }
  });
  assert.equal(created.status, 201);
  const credentials = await created.json();
  csrfToken = credentials.csrfToken;
  cookie = created.headers.get("set-cookie").match(/jpm_owner_session=[^;]+/)[0];

  const second = await api("/api/admin/setup", {
    method: "POST",
    body: { email: "attacker@example.com", password: "correct horse battery staple" }
  });
  assert.equal(second.status, 409);
  assert.equal((await api("/api/admin/listings")).status, 200);
});

test("a valid owner session can update listings, while missing CSRF protection is rejected", async () => {
  const savedToken = csrfToken;
  csrfToken = "";
  const unprotected = await api("/api/admin/listings", {
    method: "POST",
    headers: { "X-CSRF-Token": "" },
    body: {}
  });
  csrfToken = savedToken;
  assert.equal(unprotected.status, 403);

  const create = await api("/api/admin/listings", {
    method: "POST",
    body: {
      name: "Secure Test Home",
      type: "Apartment",
      city: "Ventura",
      neighborhood: "Test Area",
      price: 2100,
      beds: 2,
      baths: 1,
      size: 900,
      description: "A test property with secure server-side persistence.",
      features: ["Parking", "Laundry"],
      image: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0",
      images: [
        { url: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0", label: "Interior" },
        { url: "https://images.unsplash.com/photo-1515263487990-61b07816b324", label: "Bedroom" }
      ],
      furnished: false,
      available: true,
      indexable: true
    }
  });
  assert.equal(create.status, 200);
  const property = await create.json();
  assert.equal(property.name, "Secure Test Home");
  assert.equal(property.indexable, true);
  assert.deepEqual(property.images.map((photo) => photo.label), ["Interior", "Bedroom"]);

  const invalidGallery = await api("/api/admin/listings", {
    method: "POST",
    body: { ...property, id: "invalid-gallery", images: [{ url: "http://unsafe.example/photo.jpg", label: "Interior" }] }
  });
  assert.equal(invalidGallery.status, 400);

  const exteriorGallery = await api("/api/admin/listings", {
    method: "POST",
    body: { ...property, id: "exterior-gallery", images: [{ url: property.image, label: "Exterior" }] }
  });
  assert.equal(exteriorGallery.status, 400);

  const paused = await api(`/api/admin/listings/${property.id}`, {
    method: "PATCH",
    body: { available: false }
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).available, false);

  const publicListings = await (await api("/api/listings")).json();
  assert.equal(publicListings.some((listing) => listing.id === property.id), false);
  assert.equal((await api("/api/admin/backup")).status, 200);
});

test("password login returns an HTTP-only session cookie and wrong origins are rejected", async () => {
  const wrongOrigin = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { Origin: "http://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jamespropertymng@gmail.com", password: "correct horse battery staple" })
  });
  assert.equal(wrongOrigin.status, 403);

  const incorrectPassword = await api("/api/admin/login", {
    method: "POST",
    body: { email: "jamespropertymng@gmail.com", password: "incorrect password" }
  });
  assert.equal(incorrectPassword.status, 401);

  const logout = await api("/api/admin/logout", { method: "POST" });
  assert.equal(logout.status, 200);
  cookie = "";
  csrfToken = "";
  const login = await api("/api/admin/login", {
    method: "POST",
    body: { email: "jamespropertymng@gmail.com", password: "correct horse battery staple" }
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  assert.equal(auth.email, "jamespropertymng@gmail.com");
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  csrfToken = auth.csrfToken;
  cookie = login.headers.get("set-cookie").match(/jpm_owner_session=[^;]+/)[0];
});

test("deleting every listing stays deleted after a server restart", async () => {
  const listings = await (await api("/api/admin/listings")).json();
  assert.equal(listings.length, 12);
  for (const property of listings) {
    const response = await api(`/api/admin/listings/${property.id}`, { method: "DELETE" });
    assert.equal(response.status, 200);
  }
  serverProcess.kill();
  await new Promise((resolve) => serverProcess.once("exit", resolve));
  const port = Number(new URL(baseUrl).port);
  await startServer(port);
  assert.equal((await (await api("/api/listings")).json()).length, 0);
  assert.equal((await (await api("/api/admin/status")).json()).configured, true);
});
