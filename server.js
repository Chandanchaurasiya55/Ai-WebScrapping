const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const { scrapeExecutivesFromWebsite } = require("./src/execScraper");

const app = express();
app.use(cors());
app.use(express.json());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWebsite(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return "https://" + s;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function mapBizTypeToOverpass(bizType) {
  const q = String(bizType || "").toLowerCase();

  // A small pragmatic mapping. Add more as needed.
  if (q.includes("hotel")) return [{ k: "tourism", v: "hotel" }];
  if (q.includes("restaurant")) return [{ k: "amenity", v: "restaurant" }];
  if (q.includes("hospital")) return [{ k: "amenity", v: "hospital" }];
  if (q.includes("school")) return [{ k: "amenity", v: "school" }];
  if (q.includes("college") || q.includes("university")) return [{ k: "amenity", v: "university" }];
  if (q.includes("bank")) return [{ k: "amenity", v: "bank" }];
  if (q.includes("pharmacy")) return [{ k: "amenity", v: "pharmacy" }];
  if (q.includes("gym")) return [{ k: "leisure", v: "fitness_centre" }];
  if (q.includes("supermarket")) return [{ k: "shop", v: "supermarket" }];
  if (q.includes("shop")) return [{ k: "shop", v: "*" }];
  if (q.includes("company") || q.includes("office")) return [{ k: "office", v: "*" }];

  // Fallback: search any POI with a name match.
  return null;
}

async function geocodeNominatim(location) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
    location
  )}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "BizScout/1.0 (no-key; educational)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Geocode failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error("Location not found");
  const top = data[0];
  const lat = parseFloat(top.lat);
  const lon = parseFloat(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Invalid geocode result");
  return { lat, lon, display_name: top.display_name || location };
}

async function queryOverpass({ lat, lon, bizType, radiusMeters = 5000, limit = 25 }) {
  const mapped = mapBizTypeToOverpass(bizType);
  let filter = "";
  if (mapped && mapped.length) {
    const parts = mapped.map(({ k, v }) => (v === "*" ? `["${k}"]` : `["${k}"="${v}"]`));
    filter = parts.join("");
  } else {
    // fallback: name regex match
    const rx = String(bizType || "").trim().replace(/"/g, "");
    filter = rx ? `["name"~"${rx}",i]` : `["name"]`;
  }

  const overpassQuery = `
[out:json][timeout:25];
(
  node${filter}(around:${radiusMeters},${lat},${lon});
  way${filter}(around:${radiusMeters},${lat},${lon});
  relation${filter}(around:${radiusMeters},${lat},${lon});
);
out center tags ${Math.max(10, Math.min(200, limit * 3))};
`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "BizScout/1.0 (no-key; educational)",
    },
    body: `data=${encodeURIComponent(overpassQuery)}`,
  });
  if (!res.ok) throw new Error(`Overpass failed (${res.status})`);
  const data = await res.json();
  const els = Array.isArray(data.elements) ? data.elements : [];

  const results = [];
  for (const el of els) {
    const tags = el.tags || {};
    const name = cleanText(tags.name);
    if (!name) continue;

    const website = normalizeWebsite(tags.website || tags.contact?.website || tags["contact:website"]);
    const phone = cleanText(tags.phone || tags.contact?.phone || tags["contact:phone"]);
    const addr = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:suburb"],
      tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
      tags["addr:state"],
      tags["addr:postcode"],
      tags["addr:country"],
    ]
      .map(cleanText)
      .filter(Boolean)
      .join(", ");

    const loc =
      addr ||
      cleanText(tags["addr:full"]) ||
      cleanText(tags["contact:address"]) ||
      cleanText(tags["contact:city"]) ||
      "N/A";

    results.push({
      company_name: name,
      website: website || "N/A",
      phone: phone || "N/A",
      location: loc || "N/A",
      source: "openstreetmap",
    });
  }

  // de-dup by name+website
  const key = (r) => `${(r.company_name || "").toLowerCase()}|${(r.website || "").toLowerCase()}`;
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  return deduped.slice(0, limit);
}

// ── NO-API-KEY SCRAPE: website → executives + contacts ─────────
app.post("/scrape-site", async (req, res) => {
  try {
    const { website } = req.body || {};
    if (!website) return res.status(400).json({ error: "website required" });

    const ex = await scrapeExecutivesFromWebsite(website, fetch, {
      respectRobots: true,
      maxPages: 6,
      concurrency: 3,
      timeoutMs: 15000,
    });

    if (!ex.ok) return res.status(502).json({ error: ex.error || "Scrape failed" });

    res.json({
      result: {
        company_name: ex.companyName || "N/A",
        website,
        phone: ex.phones?.[0] || "N/A",
        location: ex.locations?.[0] || "N/A",
        emails: ex.emails || [],
        ceo: ex.executives?.ceo?.name || "N/A",
        ceo_email: ex.executives?.ceo?.email || "N/A",
        cfo: ex.executives?.cfo?.name || "N/A",
        cfo_email: ex.executives?.cfo?.email || "N/A",
        cmo: ex.executives?.cmo?.name || "N/A",
        cmo_email: ex.executives?.cmo?.email || "N/A",
        vp: ex.executives?.vp?.name || "N/A",
        vp_email: ex.executives?.vp?.email || "N/A",
        president: ex.executives?.president?.name || "N/A",
        president_email: ex.executives?.president?.email || "N/A",
        crawled_pages: ex.crawledPages || [],
      },
    });
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ── NO-KEY DISCOVERY: bizType + location → list of companies ───
app.post("/discover", async (req, res) => {
  try {
    const { bizType, location, maxResults, radiusKm } = req.body || {};
    if (!bizType || !location) {
      return res.status(400).json({ error: "bizType and location required" });
    }

    const geo = await geocodeNominatim(location);
    // be polite to Nominatim usage policy
    await sleep(900);

    const results = await queryOverpass({
      lat: geo.lat,
      lon: geo.lon,
      bizType,
      radiusMeters: Math.max(1000, Math.min(50000, (parseFloat(radiusKm) || 5) * 1000)),
      limit: Math.max(1, Math.min(50, parseInt(maxResults) || 10)),
    });

    res.json({ location: geo.display_name, results });
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ── NO-KEY FULL FLOW: discover + scrape executives ─────────────
app.post("/discover-scrape", async (req, res) => {
  try {
    const { bizType, location, maxResults, radiusKm, enrichExecutives } = req.body || {};
    if (!bizType || !location) {
      return res.status(400).json({ error: "bizType and location required" });
    }

    const geo = await geocodeNominatim(location);
    await sleep(900);

    const discovered = await queryOverpass({
      lat: geo.lat,
      lon: geo.lon,
      bizType,
      radiusMeters: Math.max(1000, Math.min(50000, (parseFloat(radiusKm) || 5) * 1000)),
      limit: Math.max(1, Math.min(50, parseInt(maxResults) || 10)),
    });

    if (!enrichExecutives) {
      return res.json({ location: geo.display_name, results: discovered });
    }

    const results = [];
    for (const r of discovered) {
      if (!r.website || r.website === "N/A") {
        results.push({
          ...r,
          emails: [],
          ceo: "N/A",
          ceo_email: "N/A",
          cfo: "N/A",
          cfo_email: "N/A",
          cmo: "N/A",
          cmo_email: "N/A",
          vp: "N/A",
          vp_email: "N/A",
          president: "N/A",
          president_email: "N/A",
        });
        continue;
      }

      const ex = await scrapeExecutivesFromWebsite(r.website, fetch, {
        respectRobots: true,
        maxPages: 6,
        concurrency: 3,
        timeoutMs: 15000,
      });

      results.push({
        ...r,
        emails: ex.ok ? ex.emails || [] : [],
        ceo: ex.ok ? ex.executives?.ceo?.name || "N/A" : "N/A",
        ceo_email: ex.ok ? ex.executives?.ceo?.email || "N/A" : "N/A",
        cfo: ex.ok ? ex.executives?.cfo?.name || "N/A" : "N/A",
        cfo_email: ex.ok ? ex.executives?.cfo?.email || "N/A" : "N/A",
        cmo: ex.ok ? ex.executives?.cmo?.name || "N/A" : "N/A",
        cmo_email: ex.ok ? ex.executives?.cmo?.email || "N/A" : "N/A",
        vp: ex.ok ? ex.executives?.vp?.name || "N/A" : "N/A",
        vp_email: ex.ok ? ex.executives?.vp?.email || "N/A" : "N/A",
        president: ex.ok ? ex.executives?.president?.name || "N/A" : "N/A",
        president_email: ex.ok ? ex.executives?.president?.email || "N/A" : "N/A",
      });

      // be nice to websites + OSM infra
      await sleep(400);
    }

    res.json({ location: geo.display_name, results });
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ── Batch scrape multiple websites ─────────────────────────────
app.post("/scrape-sites", async (req, res) => {
  try {
    const { websites } = req.body || {};
    if (!Array.isArray(websites) || websites.length === 0) {
      return res.status(400).json({ error: "websites[] required" });
    }

    const trimmed = websites
      .map((w) => String(w || "").trim())
      .filter(Boolean)
      .slice(0, 50);

    const results = await Promise.all(
      trimmed.map(async (website) => {
        const ex = await scrapeExecutivesFromWebsite(website, fetch, {
          respectRobots: true,
          maxPages: 6,
          concurrency: 3,
          timeoutMs: 15000,
        });

        if (!ex.ok) {
          return {
            company_name: "N/A",
            website,
            error: ex.error || "Scrape failed",
          };
        }

        return {
          company_name: ex.companyName || "N/A",
          website,
          phone: ex.phones?.[0] || "N/A",
          location: ex.locations?.[0] || "N/A",
          emails: ex.emails || [],
          ceo: ex.executives?.ceo?.name || "N/A",
          ceo_email: ex.executives?.ceo?.email || "N/A",
          cfo: ex.executives?.cfo?.name || "N/A",
          cfo_email: ex.executives?.cfo?.email || "N/A",
          cmo: ex.executives?.cmo?.name || "N/A",
          cmo_email: ex.executives?.cmo?.email || "N/A",
          vp: ex.executives?.vp?.name || "N/A",
          vp_email: ex.executives?.vp?.email || "N/A",
          president: ex.executives?.president?.name || "N/A",
          president_email: ex.executives?.president?.email || "N/A",
        };
      })
    );

    res.json({ results });
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ── SERVER ───────────────────────────────────────────────
app.listen(3000, () => {
  console.log("✅ Server running → http://localhost:3000");
  console.log("📌 POST /scrape-site  { website: \"https://example.com\" }");
  console.log("📌 POST /scrape-sites { websites: [\"https://a.com\", \"https://b.com\"] }");
  console.log("📌 POST /discover { bizType, location, maxResults?, radiusKm? }");
  console.log("📌 POST /discover-scrape { bizType, location, maxResults?, radiusKm?, enrichExecutives?: true }");
});