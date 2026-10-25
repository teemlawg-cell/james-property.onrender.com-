"use strict";

const PROPERTIES_KEY = "jpm-properties-v1";
const ACTIVITY_KEY = "jpm-activity-v1";
const MIGRATION_KEY = "jpm-server-migrated-v1";
const DEFAULT_IMAGE = "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80";
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
let properties = [];
let activity = [];
let csrfToken = "";
let adminEmail = "";
let revealObserver;
let ownerAccessTapCount = 0;
let ownerAccessTapTimer;

const formatPrice = (price) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
}).format(price);

function propertySlug(property) {
  const title = `${property.name}-${property.neighborhood}-${property.city}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return `${title}-${property.id}`;
}

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && path !== "/api/admin/login" && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined || options.body instanceof Blob ? options.body : JSON.stringify(options.body)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `The request failed (${response.status}).`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function observeReveals(root = document) {
  const items = root.querySelectorAll(".reveal");
  if (!revealObserver || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  items.forEach((item) => revealObserver.observe(item));
}

function initializeReveals() {
  const revealSelectors = ".hero-copy, .hero-image, .quick-contact, .section-heading, .filters, .property-card, .about-image, .about-copy, .approach-heading, .approach-card, .contact > div";
  document.querySelectorAll(revealSelectors).forEach((item) => item.classList.add("reveal"));
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".reveal").forEach((item) => item.classList.add("is-visible"));
    return;
  }
  revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  observeReveals();
}

async function loadPublicListings() {
  properties = await api("/api/listings");
  renderPublicListings();
}

function getPropertyImages(property) {
  const gallery = Array.isArray(property.images)
    ? property.images.filter((photo) => photo && typeof photo.url === "string" && photo.url)
      .map((photo) => ({ url: photo.url, label: photo.label || "Interior" }))
    : [];
  const cover = property.image || gallery[0]?.url || DEFAULT_IMAGE;
  const coverIndex = gallery.findIndex((photo) => photo.url === cover);
  if (coverIndex < 0) gallery.unshift({ url: cover, label: "Interior" });
  else if (coverIndex > 0) gallery.unshift(...gallery.splice(coverIndex, 1));
  return gallery.slice(0, 8);
}

function renderPublicListings() {
  const listings = $("#public-listings");
  if (!listings) return;
  const search = $("#search-input").value.trim().toLowerCase();
  const type = $("#type-filter").value;
  const bedrooms = $("#bedroom-filter").value;
  const filteredProperties = properties.filter((property) => {
    const searchable = `${property.name} ${property.city} ${property.neighborhood}`.toLowerCase();
    return (!search || searchable.includes(search))
      && (type === "all" || property.type === type)
      && (bedrooms === "all" || property.beds >= Number(bedrooms));
  });
  listings.innerHTML = filteredProperties.map((property) => `
    <article class="property-card">
      <div class="property-photo">
        <img src="${escapeHTML(property.image || DEFAULT_IMAGE)}" alt="${escapeHTML(property.name)}" loading="lazy">
        <span class="property-tag">${escapeHTML(property.type)}</span>
        ${property.furnished ? '<span class="property-furnishing">Furnished</span>' : ""}
      </div>
      <div class="property-card-body">
        <p class="property-location">${escapeHTML(property.neighborhood)} · ${escapeHTML(property.city)}</p>
        <h3 title="${escapeHTML(property.name)}"><a href="/properties/${propertySlug(property)}">${escapeHTML(property.name)}</a></h3>
        <div class="property-meta"><span>${property.beds === 0 ? "Studio" : `${property.beds} ${property.beds === 1 ? "bed" : "beds"}`}</span><span>${property.baths} ${property.baths === 1 ? "bath" : "baths"}</span><span>${Number(property.size).toLocaleString()} sq ft</span></div>
        <div class="property-card-bottom">
          <span class="property-price">${formatPrice(property.price)} <small>/ month</small></span>
          <button class="card-link" type="button" data-property-details="${escapeHTML(property.id)}">View details ↗</button>
        </div>
      </div>
    </article>`).join("");
  listings.querySelectorAll(".property-card").forEach((item) => item.classList.add("reveal"));
  observeReveals(listings);
  $("#results-count").textContent = `${filteredProperties.length} ${filteredProperties.length === 1 ? "home" : "homes"} available`;
  $("#empty-listings").hidden = filteredProperties.length > 0;
  listings.hidden = filteredProperties.length === 0;
}

function openPropertyDetails(id) {
  const property = properties.find((item) => item.id === id);
  if (!property) return;
  const gallery = getPropertyImages(property);
  const cover = gallery[0];
  const features = Array.isArray(property.features) && property.features.length
    ? property.features
    : ["Contact us for additional property details"];
  const subject = encodeURIComponent(`Property enquiry: ${property.name}`);
  const body = encodeURIComponent(`Hello, I'm interested in ${property.name} in ${property.neighborhood}, ${property.city}. Please share more information.`);
  $("#property-dialog-content").innerHTML = `
    <div class="detail-gallery" data-property-id="${escapeHTML(property.id)}" role="group" aria-label="Photos of ${escapeHTML(property.name)}">
      <div class="detail-photo">
        <img id="detail-gallery-image" src="${escapeHTML(cover.url)}" alt="${escapeHTML(property.name)} - ${escapeHTML(cover.label)}">
        <span class="gallery-caption" id="detail-gallery-caption">${escapeHTML(cover.label)}</span>
      </div>
      <div class="detail-thumbnails" role="group" aria-label="Choose a property photo">
        ${gallery.map((photo, index) => `<button type="button" class="gallery-thumbnail${index === 0 ? " active" : ""}" data-gallery-index="${index}" aria-label="View ${escapeHTML(photo.label)} photo" aria-pressed="${index === 0}">
          <img src="${escapeHTML(photo.url)}" alt="" loading="lazy"><span>${escapeHTML(photo.label)}</span>
        </button>`).join("")}
      </div>
    </div>
    <div class="detail-content">
      <p class="property-location">${escapeHTML(property.neighborhood)} <span aria-hidden="true">·</span> ${escapeHTML(property.city)}</p>
      <p class="detail-kicker">${property.furnished ? "Fully furnished" : "Unfurnished"} · ${escapeHTML(property.type)} for rent</p>
      <h2 id="property-dialog-title">${escapeHTML(property.name)}</h2>
      <div class="detail-price">${formatPrice(property.price)} <span>per month</span></div>
      <div class="detail-facts">
        <div><span class="fact-icon" aria-hidden="true">⌂</span><strong>${property.beds === 0 ? "Studio" : `${property.beds} ${property.beds === 1 ? "Bedroom" : "Bedrooms"}`}</strong><small>Sleeping space</small></div>
        <div><span class="fact-icon" aria-hidden="true">◈</span><strong>${property.baths} ${property.baths === 1 ? "Bathroom" : "Bathrooms"}</strong><small>Full washrooms</small></div>
        <div><span class="fact-icon" aria-hidden="true">▧</span><strong>${Number(property.size).toLocaleString()} sq ft</strong><small>Interior space</small></div>
        <div><span class="fact-icon" aria-hidden="true">⌖</span><strong>${escapeHTML(property.neighborhood)}</strong><small>${escapeHTML(property.city)}</small></div>
      </div>
      <div class="detail-description"><h3>About this home</h3><p>${escapeHTML(property.description || "Contact us to learn more about this property.")}</p></div>
      <div class="detail-features"><h3>Home features</h3><ul>${features.map((feature) => `<li><span aria-hidden="true">✓</span>${escapeHTML(feature)}</li>`).join("")}</ul></div>
      <div class="detail-contact">
        <h3>Ask us about this home</h3>
        <p>Contact James Property MNG directly. We’ll be happy to share more information.</p>
        <div class="detail-contact-actions">
          <a class="button" href="tel:+18056747745"><span aria-hidden="true">☎</span> Call us</a>
          <a class="button button-outline" href="mailto:jamespropertymng@gmail.com?subject=${subject}&body=${body}"><span aria-hidden="true">✉</span> Email us</a>
          <a class="button button-outline" href="https://instagram.com/jamesproperty.mng432" target="_blank" rel="noreferrer"><span aria-hidden="true">◎</span> Instagram</a>
        </div>
      </div>
    </div>`;
  $("#property-dialog").showModal();
  observeReveals($("#property-dialog-content"));
}

function renderExistingGallery(property) {
  const container = $("#listing-gallery-current");
  const fieldset = $("#listing-gallery-fieldset");
  const gallery = property ? getPropertyImages(property) : [];
  fieldset.hidden = gallery.length === 0;
  container.innerHTML = gallery.map((photo, index) => `
    <div class="gallery-existing-item">
      <label class="gallery-keep"><input type="checkbox" data-gallery-keep="${index}" checked><span>Keep photo</span></label>
      <img src="${escapeHTML(photo.url)}" alt="">
      <label class="gallery-label-select">Photo view
        <select data-gallery-existing-label="${index}">
          ${renderGalleryLabelOptions(photo.label)}
        </select>
      </label>
    </div>`).join("");
}

function renderGalleryLabelOptions(selected = "Interior") {
  return ["Interior", "Bedroom", "Kitchen", "Bathroom", "Amenities", "Other"]
    .map((label) => `<option${label === selected ? " selected" : ""}>${label}</option>`).join("");
}

function renderNewGalleryLabels(files) {
  const container = $("#listing-gallery-labels");
  const defaultLabels = ["Kitchen", "Bathroom", "Bedroom", "Amenities", "Other"];
  container.innerHTML = Array.from(files).map((file, index) => `
    <label class="gallery-new-label">Photo ${index + 1} · ${escapeHTML(file.name)}
      <select data-gallery-new-label="${index}">
        ${renderGalleryLabelOptions(defaultLabels[index] || "Other")}
      </select>
    </label>`).join("");
}

function renderManagement() {
  const available = properties.filter((property) => property.available).length;
  $("#stat-total").textContent = properties.length;
  $("#stat-available").textContent = available;
  $("#stat-unavailable").textContent = properties.length - available;
  $("#stat-activity").textContent = activity.length;
  $("#management-list").innerHTML = properties.length
    ? properties.map((property) => `
      <article class="manage-row">
        <img class="manage-thumb" src="${escapeHTML(property.image || DEFAULT_IMAGE)}" alt="">
        <div class="manage-title"><strong>${escapeHTML(property.name)}</strong><small>${escapeHTML(property.neighborhood)}, ${escapeHTML(property.city)} · ${escapeHTML(property.type)}</small></div>
        <span class="manage-price">${formatPrice(property.price)} <small>/ month</small></span>
        <span class="status-pill ${property.available ? "" : "unavailable"}">${property.available ? "Available" : "Unavailable"}</span>
        <div class="manage-actions">
          <button type="button" data-action="edit" data-property-id="${escapeHTML(property.id)}">Edit</button>
          <button type="button" data-action="toggle" data-property-id="${escapeHTML(property.id)}">${property.available ? "Pause" : "Publish"}</button>
          <button class="delete-action" type="button" data-action="delete" data-property-id="${escapeHTML(property.id)}">Delete</button>
        </div>
      </article>`).join("")
    : '<p class="dashboard-empty">No homes yet. Select “Add a home” to create your first listing.</p>';
  $("#management-list").querySelectorAll(".manage-row").forEach((item) => item.classList.add("reveal"));
  observeReveals($("#management-list"));
  $("#activity-list").innerHTML = activity.length
    ? activity.map((entry) => `<li><span>${escapeHTML(entry.message)}</span><time datetime="${escapeHTML(entry.time)}">${escapeHTML(new Date(entry.time).toLocaleString())}</time></li>`).join("")
    : '<li class="activity-empty">No activity recorded yet.</li>';
}

async function refreshDashboard() {
  [properties, { activity }] = await Promise.all([
    api("/api/admin/listings"),
    api("/api/admin/summary")
  ]);
  renderManagement();
}

function setLoginMessage(message, isError = true) {
  const element = $("#login-message");
  element.textContent = message;
  element.classList.toggle("success-message", !isError && Boolean(message));
}

async function setRoute() {
  const admin = window.location.hash === "#manage";
  const robots = $('meta[name="robots"]');
  if (robots) robots.content = admin ? "noindex, nofollow" : document.documentElement.dataset.publicRobots || "noindex, nofollow";
  $("#public-view").hidden = admin;
  $("#admin-view").hidden = !admin;
  $(".site-header").hidden = admin;
  $(".site-footer").hidden = admin;
  if (!admin) {
    await loadPublicListings();
    return;
  }
  const session = await api("/api/admin/session");
  csrfToken = session.csrfToken || "";
  adminEmail = session.email || "";
  const loggedIn = session.authenticated === true;
  $("#login-panel").hidden = loggedIn;
  $("#dashboard").hidden = !loggedIn;
  $("#logout-button").hidden = !loggedIn;
  const accountStatus = await api("/api/admin/status");
  $("#account-setup-form").hidden = accountStatus.configured || !accountStatus.canSetup;
  $("#hosted-setup-notice").hidden = accountStatus.configured || accountStatus.canSetup;
  $("#login-form").hidden = !accountStatus.configured;
  if (!accountStatus.configured && accountStatus.canSetup && !$("#setup-email").value) {
    $("#setup-email").value = "jamespropertymng@gmail.com";
  }
  if (loggedIn) {
    $("#admin-account-email").textContent = adminEmail;
    await refreshDashboard();
  }
}

function openListingForm(property = null) {
  $("#listing-form").reset();
  $("#listing-id").value = property ? property.id : "";
  $("#listing-name").value = property?.name || "";
  $("#listing-type").value = property?.type || "Apartment";
  $("#listing-price").value = property?.price || "";
  $("#listing-city").value = property?.city || "";
  $("#listing-neighborhood").value = property?.neighborhood || "";
  $("#listing-beds").value = property?.beds ?? 2;
  $("#listing-baths").value = property?.baths ?? 1;
  $("#listing-size").value = property?.size || "";
  $("#listing-description").value = property?.description || "";
  $("#listing-features").value = Array.isArray(property?.features) ? property.features.join(", ") : "";
  $("#listing-image-url").value = property?.image && !property.image.startsWith("/uploads/") ? property.image : "";
  $("#listing-furnished").checked = property?.furnished === true;
  $("#listing-available").checked = property ? property.available : true;
  $("#listing-indexable").checked = property?.indexable === true;
  $("#listing-gallery-files").value = "";
  $("#listing-gallery-labels").innerHTML = "";
  renderExistingGallery(property);
  $("#listing-form-message").textContent = "";
  $("#listing-dialog-title").textContent = property ? "Update this home" : "Add a home";
  $("#listing-dialog").showModal();
}

function readAndResizeImage(file) {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Please choose an image file."));
  if (file.size > 8 * 1024 * 1024) return Promise.reject(new Error("Choose a photo smaller than 8 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The photo could not be read. Please try another file."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("This photo could not be opened. Please try another image."));
      image.onload = () => {
        const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Your browser could not prepare this photo."));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const resized = canvas.toDataURL("image/jpeg", 0.78);
        if (resized.length > 1_900_000) {
          reject(new Error("This photo is still too large after resizing. Try a smaller photo."));
          return;
        }
        resolve(resized);
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function migratePreviousListings() {
  if (localStorage.getItem(MIGRATION_KEY) === "complete") return;
  const previousData = localStorage.getItem(PROPERTIES_KEY);
  if (!previousData) {
    localStorage.setItem(MIGRATION_KEY, "complete");
    return;
  }
  let previousListings;
  try {
    previousListings = JSON.parse(previousData);
  } catch {
    throw new Error("Your earlier browser-saved listings could not be read. Keep a copy of this browser's data and contact support.");
  }
  if (!Array.isArray(previousListings)) {
    throw new Error("Your earlier browser-saved listings are in an unexpected format. They have not been changed.");
  }
  if (!window.confirm(`I found ${previousListings.length} listings saved by the earlier browser version. Import these into the secure website account? This will replace matching starter listings and keep your custom listings.`)) {
    return;
  }
  for (const listing of previousListings) {
    const item = { ...listing };
    delete item.sample;
    if (typeof item.image === "string" && item.image.startsWith("data:image/")) {
      const uploaded = await api("/api/admin/upload", { method: "POST", body: { image: item.image } });
      item.image = uploaded.image;
    }
    await api("/api/admin/listings", { method: "POST", body: item });
  }
  localStorage.setItem(MIGRATION_KEY, "complete");
  localStorage.removeItem(PROPERTIES_KEY);
  localStorage.removeItem(ACTIVITY_KEY);
  localStorage.removeItem("jpm-starter-expansion-v2");
  setLoginMessage("Your previous listings were securely imported.", false);
}

async function importBackup(file) {
  const backup = JSON.parse(await file.text());
  if (backup?.format !== "james-property-mng-backup-v1" || !Array.isArray(backup.properties)) {
    throw new Error("Choose a James Property MNG JSON backup file.");
  }
  let imported = 0;
  for (const property of backup.properties) {
    const listing = { ...property };
    delete listing.sample;
    if (typeof listing.image === "string" && listing.image.startsWith("data:image/")) {
      const uploaded = await api("/api/admin/upload", { method: "POST", body: { image: listing.image } });
      listing.image = uploaded.image;
    }
    await api("/api/admin/listings", { method: "POST", body: listing });
    imported += 1;
  }
  await refreshDashboard();
  await loadPublicListings();
  setApplicationMessage(`${imported} listing${imported === 1 ? "" : "s"} imported successfully.`);
}

async function downloadBackup() {
  const backup = await api("/api/admin/backup");
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `james-property-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function initialize() {
  $("#current-year").textContent = new Date().getFullYear();
  document.documentElement.classList.add("motion-ready");
  initializeReveals();
  await loadPublicListings();
  window.addEventListener("hashchange", () => setRoute().catch(showApplicationError));
  $("#search-input").addEventListener("input", renderPublicListings);
  $("#type-filter").addEventListener("change", renderPublicListings);
  $("#bedroom-filter").addEventListener("change", renderPublicListings);
  $("#clear-filters").addEventListener("click", () => {
    $("#search-input").value = "";
    $("#type-filter").value = "all";
    $("#bedroom-filter").value = "all";
    renderPublicListings();
  });
  $("#public-listings").addEventListener("click", (event) => {
    const button = event.target.closest("[data-property-details]");
    if (button) openPropertyDetails(button.dataset.propertyDetails);
  });
  $("#property-dialog-content").addEventListener("click", (event) => {
    const button = event.target.closest("[data-gallery-index]");
    if (!button) return;
    const dialog = $("#property-dialog-content");
    const propertyId = dialog.querySelector("[data-property-id]")?.dataset.propertyId;
    const property = properties.find((item) => item.id === propertyId);
    if (!property) return;
    const photo = getPropertyImages(property)[Number(button.dataset.galleryIndex)];
    if (!photo) return;
    const image = $("#detail-gallery-image");
    image.src = photo.url;
    image.alt = `${property.name} - ${photo.label}`;
    $("#detail-gallery-caption").textContent = photo.label;
    $$(".gallery-thumbnail", dialog).forEach((thumbnail) => {
      const selected = thumbnail === button;
      thumbnail.classList.toggle("active", selected);
      thumbnail.setAttribute("aria-pressed", String(selected));
    });
  });
  $("#owner-access-trigger").addEventListener("click", () => {
    ownerAccessTapCount += 1;
    window.clearTimeout(ownerAccessTapTimer);
    ownerAccessTapTimer = window.setTimeout(() => { ownerAccessTapCount = 0; }, 10000);
    if (ownerAccessTapCount >= 5) {
      ownerAccessTapCount = 0;
      window.clearTimeout(ownerAccessTapTimer);
      window.location.hash = "#manage";
    }
  });
  document.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement) event.target.hidden = true;
  }, true);
  $$(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $$(".property-dialog, .form-dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));
  $(".menu-toggle").addEventListener("click", () => {
    const nav = $(".main-nav");
    const open = nav.classList.toggle("open");
    $(".menu-toggle").setAttribute("aria-expanded", String(open));
    $(".menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  $$(".main-nav a").forEach((link) => link.addEventListener("click", () => {
    $(".main-nav").classList.remove("open");
    $(".menu-toggle").setAttribute("aria-expanded", "false");
  }));
  $("#account-setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#setup-submit");
    const password = $("#setup-password").value;
    if (password !== $("#setup-password-confirmation").value) {
      $("#setup-message").textContent = "The passwords do not match. Please try again.";
      return;
    }
    button.disabled = true;
    $("#setup-message").textContent = "";
    try {
      const session = await api("/api/admin/setup", {
        method: "POST",
        body: { email: $("#setup-email").value.trim(), password }
      });
      csrfToken = session.csrfToken;
      adminEmail = session.email;
      $("#setup-password").value = "";
      $("#setup-password-confirmation").value = "";
      await migratePreviousListings();
      await setRoute();
    } catch (error) {
      $("#setup-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#login-submit");
    button.disabled = true;
    setLoginMessage("");
    try {
      const session = await api("/api/admin/login", {
        method: "POST",
        body: { email: $("#login-email").value.trim(), password: $("#login-password").value }
      });
      csrfToken = session.csrfToken;
      adminEmail = session.email;
      $("#login-password").value = "";
      await migratePreviousListings();
      await setRoute();
    } catch (error) {
      setLoginMessage(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
      csrfToken = "";
      adminEmail = "";
      $("#login-password").value = "";
      await setRoute();
    } catch (error) {
      setApplicationMessage(error.message);
    }
  });
  $("#add-listing-button").addEventListener("click", () => openListingForm());
  $("#cancel-listing-button").addEventListener("click", () => $("#listing-dialog").close());
  $("#listing-gallery-files").addEventListener("change", (event) => {
    const files = event.target.files;
    if (files.length > 7) {
      event.target.value = "";
      $("#listing-gallery-labels").innerHTML = "";
      $("#listing-form-message").textContent = "Add up to 7 additional photos. Remove a few and try again.";
      return;
    }
    $("#listing-form-message").textContent = "";
    renderNewGalleryLabels(files);
  });
  $("#listing-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#listing-form-message");
    const button = $("#listing-form button[type=submit]");
    message.textContent = "";
    button.disabled = true;
    try {
      const coverFile = $("#listing-image-file").files[0];
      let image = $("#listing-image-url").value.trim();
      if (coverFile) {
        const resizedImage = await readAndResizeImage(coverFile);
        const uploaded = await api("/api/admin/upload", { method: "POST", body: { image: resizedImage } });
        image = uploaded.image;
      }
      const id = $("#listing-id").value;
      const existing = properties.find((property) => property.id === id);
      if (!image && existing) image = existing.image;
      if (!image) throw new Error("Add a photo URL or upload a photo from your device.");
      const currentGallery = existing ? getPropertyImages(existing) : [];
      const retainedGallery = currentGallery.filter((photo, index) => {
        const keep = $(`[data-gallery-keep="${index}"]`);
        return keep?.checked;
      }).map((photo, index) => ({
        url: photo.url,
        label: $(`[data-gallery-existing-label="${currentGallery.indexOf(photo)}"]`)?.value || photo.label
      }));
      const newFiles = Array.from($("#listing-gallery-files").files);
      if (retainedGallery.length + newFiles.length + (retainedGallery.some((photo) => photo.url === image) ? 0 : 1) > 8) {
        throw new Error("A property can have up to 8 photos. Remove a current photo or add fewer new photos.");
      }
      const newGallery = await Promise.all(newFiles.map(async (file, index) => {
        const resizedImage = await readAndResizeImage(file);
        const uploaded = await api("/api/admin/upload", { method: "POST", body: { image: resizedImage } });
        return {
          url: uploaded.image,
          label: $(`[data-gallery-new-label="${index}"]`)?.value || "Other"
        };
      }));
      const gallery = [
        { url: image, label: "Interior" },
        ...retainedGallery.filter((photo) => photo.url !== image),
        ...newGallery
      ];
      const property = {
        id,
        name: $("#listing-name").value.trim(),
        type: $("#listing-type").value,
        city: $("#listing-city").value.trim(),
        neighborhood: $("#listing-neighborhood").value.trim(),
        price: Number($("#listing-price").value),
        beds: Number($("#listing-beds").value),
        baths: Number($("#listing-baths").value),
        size: Number($("#listing-size").value),
        description: $("#listing-description").value.trim(),
        features: $("#listing-features").value.split(",").map((feature) => feature.trim()).filter(Boolean),
        image,
        images: gallery,
        furnished: $("#listing-furnished").checked,
        available: $("#listing-available").checked,
        indexable: $("#listing-indexable").checked
      };
      await api("/api/admin/listings", { method: "POST", body: property });
      $("#listing-dialog").close();
      await refreshDashboard();
      await loadPublicListings();
    } catch (error) {
      message.textContent = error.message || "The home could not be saved. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
  $("#management-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const property = properties.find((item) => item.id === button.dataset.propertyId);
    if (!property) return;
    button.disabled = true;
    try {
      if (button.dataset.action === "edit") {
        openListingForm(property);
      } else if (button.dataset.action === "toggle") {
        await api(`/api/admin/listings/${encodeURIComponent(property.id)}`, {
          method: "PATCH",
          body: { available: !property.available }
        });
        await refreshDashboard();
        await loadPublicListings();
      } else if (button.dataset.action === "delete" && window.confirm(`Delete "${property.name}"? This cannot be undone.`)) {
        await api(`/api/admin/listings/${encodeURIComponent(property.id)}`, { method: "DELETE" });
        await refreshDashboard();
        await loadPublicListings();
      }
    } catch (error) {
      setApplicationMessage(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#backup-button").addEventListener("click", async () => {
    try {
      await downloadBackup();
    } catch (error) {
      setApplicationMessage(error.message);
    }
  });
  $("#import-backup-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      await importBackup(file);
    } catch (error) {
      setApplicationMessage(error.message || "The backup could not be imported.");
    }
  });
  $("#clear-activity-button").addEventListener("click", async () => {
    if (!activity.length || !window.confirm("Clear the activity history?")) return;
    try {
      await api("/api/admin/activity", { method: "DELETE" });
      await refreshDashboard();
    } catch (error) {
      setApplicationMessage(error.message);
    }
  });
  await setRoute();
}

function setApplicationMessage(message) {
  $("#application-message").textContent = message;
  $("#application-message").hidden = !message;
}

function showApplicationError(error) {
  console.error(error);
  const message = error instanceof Error ? error.message : "The website could not load.";
  setApplicationMessage(`${message} Please check that the website server is running, then refresh this page.`);
  $("#public-view").hidden = true;
  $("#admin-view").hidden = false;
  $(".site-header").hidden = true;
  $(".site-footer").hidden = true;
}

initialize().catch(showApplicationError);
