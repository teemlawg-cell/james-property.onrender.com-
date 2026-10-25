"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

test("production mode requires HTTPS except for health checks and disables web setup", async () => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-production-test-"));
  const projectRoot = path.resolve(__dirname, "..");
  const portSocket = net.createServer();
  let server;
  let baseUrl;

  try {
    await new Promise((resolve, reject) => {
      portSocket.once("error", reject);
      portSocket.listen(0, "127.0.0.1", resolve);
    });
    const { port } = portSocket.address();
    await new Promise((resolve, reject) => portSocket.close((error) => error ? reject(error) : resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATA_DIR: temporaryData,
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

    let health;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Production test server exited: ${serverOutput}`);
      try {
        health = await fetch(`${baseUrl}/healthz`);
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(health?.status, 200, `Production test server did not start: ${serverOutput}`);
    assert.deepEqual(await health.json(), { status: "ok" });

    const plainHttp = await fetch(baseUrl);
    assert.equal(plainHttp.status, 426);
    assert.match(plainHttp.headers.get("strict-transport-security"), /max-age=31536000/);

    const secureProxyHeaders = { "X-Forwarded-Proto": "https" };
    const home = await fetch(baseUrl, { headers: secureProxyHeaders });
    assert.equal(home.status, 200);
    assert.match(home.headers.get("x-robots-tag"), /noindex/);
    assert.match(await home.text(), /name="robots" content="noindex,nofollow"/);
    const defaultRobots = await (await fetch(`${baseUrl}/robots.txt`, { headers: secureProxyHeaders })).text();
    assert.match(defaultRobots, /Allow: \//);
    assert.match(defaultRobots, /Disallow: \/api\//);
    assert.doesNotMatch(await (await fetch(`${baseUrl}/sitemap.xml`, { headers: secureProxyHeaders })).text(), /<loc>/);
    const townhouseImage = await fetch(`${baseUrl}/assets/townhouse-cover.jpg`, {
      headers: secureProxyHeaders
    });
    assert.equal(townhouseImage.status, 200);
    assert.match(townhouseImage.headers.get("content-type"), /image\/jpeg/);

    const adminStatus = await fetch(`${baseUrl}/api/admin/status`, { headers: secureProxyHeaders });
    assert.deepEqual(await adminStatus.json(), { configured: false, canSetup: false });
    assert.match(adminStatus.headers.get("x-robots-tag"), /noindex/);
    const missingProperty = await fetch(`${baseUrl}/properties/not-a-real-home`, { headers: secureProxyHeaders });
    assert.equal(missingProperty.status, 404);
    assert.match(missingProperty.headers.get("x-robots-tag"), /noindex/);

    const setup = await fetch(`${baseUrl}/api/admin/setup`, {
      method: "POST",
      headers: {
        ...secureProxyHeaders,
        "Content-Type": "application/json",
        Origin: baseUrl
      },
      body: JSON.stringify({ email: "jamespropertymng@gmail.com", password: "correct horse battery staple" })
    });
    assert.equal(setup.status, 403);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
});

test("verified production listings receive canonical detail pages and sitemap entries", async () => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "jpm-seo-test-"));
  const projectRoot = path.resolve(__dirname, "..");
  const portSocket = net.createServer();
  let server;
  let baseUrl;

  try {
    await new Promise((resolve, reject) => {
      portSocket.once("error", reject);
      portSocket.listen(0, "127.0.0.1", resolve);
    });
    const { port } = portSocket.address();
    await new Promise((resolve, reject) => portSocket.close((error) => error ? reject(error) : resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATA_DIR: temporaryData,
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        SEO_INDEXING_ENABLED: "true",
        PUBLIC_URL: "https://jamespropertymng.com",
        PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

    let health;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`SEO test server exited: ${serverOutput}`);
      try {
        health = await fetch(`${baseUrl}/healthz`);
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(health?.status, 200, `SEO test server did not start: ${serverOutput}`);

    const database = new DatabaseSync(path.join(temporaryData, "james-property.sqlite"));
    const seeded = database.prepare("SELECT id, data FROM properties ORDER BY id LIMIT 2").all();
    const verified = JSON.parse(seeded[0].data);
    verified.indexable = true;
    verified.available = true;
    database.prepare("UPDATE properties SET data = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(verified), new Date().toISOString(), seeded[0].id);
    const unverified = JSON.parse(seeded[1].data);
    unverified.indexable = true;
    unverified.available = false;
    database.prepare("UPDATE properties SET data = ? WHERE id = ?").run(JSON.stringify(unverified), seeded[1].id);
    database.close();

    const secureProxyHeaders = { "X-Forwarded-Proto": "https" };
    const slug = (property) => {
      const title = `${property.name}-${property.neighborhood}-${property.city}`
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120)
        .replace(/-+$/g, "");
      return `${title}-${property.id}`;
    };
    const detailPath = `/properties/${slug(verified)}`;
    const detail = await fetch(`${baseUrl}${detailPath}`, { headers: secureProxyHeaders });
    assert.equal(detail.status, 200);
    assert.match(detail.headers.get("x-robots-tag"), /index, follow/);
    const html = await detail.text();
    assert.match(html, /<link rel="canonical" href="https:\/\/jamespropertymng\.com\/properties\//);
    assert.match(html, new RegExp(`<title>[^<]*${verified.city}[^<]*<\\/title>`));
    assert.match(html, new RegExp(`content="[^"]*${verified.price.toLocaleString("en-US")}[^"]*"[^>]*name="description"|name="description" content="[^"]*${verified.price.toLocaleString("en-US")}`));
    const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(structuredData);
    const propertySchema = JSON.parse(structuredData[1]);
    assert.equal(propertySchema.name, verified.name);
    assert.equal(propertySchema.offers.price, verified.price);
    assert.equal(propertySchema.offers.priceCurrency, "USD");
    const pausedDetail = await fetch(`${baseUrl}/properties/${slug(unverified)}`, { headers: secureProxyHeaders });
    assert.equal(pausedDetail.status, 200);
    assert.match(pausedDetail.headers.get("x-robots-tag"), /noindex/);
    const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`, { headers: secureProxyHeaders })).text();
    assert.match(sitemap, new RegExp(detailPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(sitemap, new RegExp(slug(unverified).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const robots = await (await fetch(`${baseUrl}/robots.txt`, { headers: secureProxyHeaders })).text();
    assert.match(robots, /Allow: \//);
    assert.match(robots, /Disallow: \/api\//);
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(temporaryData, { recursive: true, force: true });
  }
});
