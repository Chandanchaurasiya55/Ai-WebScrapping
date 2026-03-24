const cheerio = require("cheerio");
const robotsParser = require("robots-parser");
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default || pLimitPkg;

function normalizeUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function absolutize(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function extractEmails(text) {
  const t = String(text || "");
  const raw = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const cleaned = raw
    .map((e) => e.trim())
    .map((e) => e.replace(/^[("<]+/, "").replace(/[)">.,;:!?]+$/, "")) // strip common punctuation
    .map((e) => e.replace(/\s+/g, "")); // safety

  const domainBlock = new Set(["example.com", "domain.com", "email.com", "example.org", "example.net"]);
  const localBlock = new Set(["name", "yourname", "firstname", "lastname", "john.doe", "jane.doe", "jane.smith"]);

  const filtered = cleaned.filter((e) => {
    if (!e || !e.includes("@")) return false;
    if (/(\.png|\.jpg|\.jpeg|\.gif|\.webp)$/i.test(e)) return false;
    const [local, domain] = e.toLowerCase().split("@");
    if (!local || !domain) return false;
    if (domainBlock.has(domain)) return false;
    if (localBlock.has(local) && domainBlock.has(domain)) return false;
    if (domain.endsWith(".what")) return false; // common false-positive from "email ... . What"
    return true;
  });

  return uniq(filtered);
}

function extractPhones(text) {
  const t = String(text || "");
  const raw =
    t.match(
      /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?/gi
    ) || [];
  const normalized = raw
    .map((p) => cleanText(p))
    .filter((p) => {
      const digits = p.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 16;
    });
  return uniq(normalized).slice(0, 5);
}

function roleVariants(role) {
  const map = {
    ceo: ["ceo", "chief executive officer"],
    cfo: ["cfo", "chief financial officer"],
    cmo: ["cmo", "chief marketing officer"],
    vp: ["vp", "vice president", "v.p.", "svp", "evp"],
    president: ["president"],
  };
  return map[role] || [role];
}

function looksLikePersonName(name) {
  const n = cleanText(name);
  if (!n) return false;
  if (n.length < 3 || n.length > 80) return false;
  if (/@/.test(n)) return false;
  if (/\d/.test(n)) return false;
  // at least 2 words, mostly letters
  const parts = n.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  const alpha = n.replace(/[^A-Za-z]/g, "").length;
  return alpha >= Math.floor(n.length * 0.5);
}

function normalizeNameCandidate(s) {
  let t = cleanText(s);
  t = t.replace(/^[–—\-•|]+/g, "").trim();
  t = t.split(",")[0]; // drop ", Co-founder" etc
  return cleanText(t);
}

function pickBestName(candidates) {
  const cleaned = uniq(candidates.map(normalizeNameCandidate)).filter(looksLikePersonName);
  if (!cleaned.length) return null;
  // prefer 2-3 word names
  cleaned.sort((a, b) => Math.abs(a.split(" ").length - 3) - Math.abs(b.split(" ").length - 3));
  return cleaned[0] || null;
}

function pickEmailForName(emails, name, companyDomain) {
  if (!emails || !emails.length) return null;
  const n = cleanText(name).toLowerCase();
  const parts = n.split(" ").filter(Boolean);
  const first = parts[0] || "";
  const last = parts[parts.length - 1] || "";

  const scored = emails.map((e) => {
    const el = e.toLowerCase();
    let score = 0;
    if (companyDomain && el.endsWith("@" + companyDomain)) score += 4;
    if (first && el.includes(first)) score += 2;
    if (last && el.includes(last)) score += 2;
    if (/^(info|support|sales|hello|contact|admin|hr|careers)@/i.test(el)) score -= 2;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].e : emails[0];
}

function extractCompanyName($, fallback) {
  const og = cleanText($('meta[property="og:site_name"]').attr("content"));
  const title = cleanText($("title").first().text());
  const h1 = cleanText($("h1").first().text());
  return og || (title && title.split("|")[0].trim()) || h1 || fallback || null;
}

function candidateLinksFrom($, baseUrl) {
  const patterns = [
    "about",
    "team",
    "leadership",
    "management",
    "executive",
    "company",
    "who-we-are",
    "our-story",
    "people",
    "contact",
    "locations",
  ];
  const out = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = cleanText($(el).text()).toLowerCase();
    const abs = absolutize(baseUrl, href);
    if (!abs) return;
    if (!sameOrigin(abs, baseUrl)) return;
    const u = new URL(abs);
    const path = (u.pathname || "/").toLowerCase();
    const hay = `${path} ${text}`;
    if (patterns.some((p) => hay.includes(p))) out.push(abs);
  });
  return uniq(out)
    .filter((u) => !/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip)$/i.test(u))
    .slice(0, 12);
}

function extractRoleHitsFromPage($, baseUrl) {
  const textNodes = [];
  $("body")
    .find("*")
    .each((_, el) => {
      const tag = (el.tagName || "").toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) return;
      const t = cleanText($(el).text());
      if (t && t.length <= 200) textNodes.push({ el, t });
    });

  const mailtos = [];
  $("a[href^='mailto:']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const email = href.replace(/^mailto:/i, "").split("?")[0];
    if (email) mailtos.push(email);
  });

  const tels = [];
  $("a[href^='tel:']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const raw = href.replace(/^tel:/i, "").split(/[?#]/)[0];
    if (!raw) return;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    const cleaned = decoded.replace(/[^\d+]/g, "");
    if (cleaned) tels.push(cleaned);
  });

  const pageText = cleanText($("body").text());
  const emails = uniq([...extractEmails(pageText), ...mailtos]);
  const phones = uniq([...tels, ...extractPhones(pageText)]).slice(0, 5);

  // Try to infer a company domain for scoring.
  let companyDomain = null;
  try {
    companyDomain = new URL(baseUrl).hostname.replace(/^www\./i, "");
  } catch {}

  const roles = ["ceo", "cfo", "cmo", "vp", "president"];
  const findings = {};

  for (const role of roles) {
    const variants = roleVariants(role);
    const hits = [];
    for (const { el, t } of textNodes) {
      const low = t.toLowerCase();
      if (!variants.some((v) => low.includes(v))) continue;

      const $el = $(el);
      const block = $el.closest("section,article,li,div").first();
      const blockText = cleanText(block.text()) || t;

      const nameCandidates = [];
      // nearby headings
      nameCandidates.push(cleanText(block.find("h1,h2,h3,h4").first().text()));
      // strong/b tags often wrap names
      nameCandidates.push(cleanText(block.find("strong,b").first().text()));
      // the element text itself might contain "Name – CEO"
      const maybeSplit = blockText.split(/[-–—|•]/).map((s) => cleanText(s));
      if (maybeSplit.length >= 2) nameCandidates.push(maybeSplit[0]);
      // fallback: take first two words from block (weak)
      const firstWords = blockText.split(" ").slice(0, 4).join(" ");
      nameCandidates.push(firstWords);

      const name = pickBestName(nameCandidates);
      const localEmails = extractEmails(blockText);
      const email =
        (name && pickEmailForName([...localEmails, ...emails], name, companyDomain)) ||
        (localEmails[0] || null);

      hits.push({ role, name, email, snippet: blockText.slice(0, 220) });
    }

    // choose the best hit
    const best = hits.find((h) => h.name) || hits[0];
    if (best?.name) {
      findings[role] = { name: best.name, email: best.email || null };
    }
  }

  return { findings, emails, phones };
}

function extractLocationsFromPage($) {
  const out = [];
  $("address").each((_, el) => {
    const t = cleanText($(el).text());
    if (t && t.length >= 10) out.push(t);
  });

  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        const address = n?.address || n?.location?.address || null;
        if (!address) continue;
        if (typeof address === "string") {
          const t = cleanText(address);
          if (t && t.length >= 10) out.push(t);
          continue;
        }
        if (typeof address === "object") {
          const parts = [
            address.streetAddress,
            address.addressLocality,
            address.addressRegion,
            address.postalCode,
            address.addressCountry,
          ]
            .map(cleanText)
            .filter(Boolean);
          const t = cleanText(parts.join(", "));
          if (t && t.length >= 10) out.push(t);
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  });

  return uniq(out).slice(0, 5);
}

async function fetchRobots(baseUrl, fetchImpl) {
  try {
    const u = new URL(baseUrl);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetchImpl(robotsUrl, { headers: { "User-Agent": "BizScout/1.0" } });
    if (!res.ok) return null;
    const txt = await res.text();
    return robotsParser(robotsUrl, txt);
  } catch {
    return null;
  }
}

async function fetchHtml(url, fetchImpl, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BizScout/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) return { ok: false, status: res.status, html: "" };
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { ok: false, status: 415, html: "" };
    }
    const html = await res.text();
    return { ok: true, status: res.status, html };
  } catch {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(t);
  }
}

async function scrapeExecutivesFromWebsite(websiteUrl, fetchImpl, opts = {}) {
  const baseUrl = normalizeUrl(websiteUrl);
  if (!baseUrl) return { ok: false, error: "Invalid website URL" };

  const limit = pLimit(opts.concurrency || 3);

  const robots = opts.respectRobots ? await fetchRobots(baseUrl, fetchImpl) : null;
  const isAllowed = (url) => {
    if (!robots) return true;
    try {
      return robots.isAllowed(url, "BizScout/1.0");
    } catch {
      return true;
    }
  };

  const home = await fetchHtml(baseUrl, fetchImpl, opts.timeoutMs || 15000);
  if (!home.ok) return { ok: false, error: `Failed to fetch homepage (${home.status})` };

  const $home = cheerio.load(home.html);
  const companyName = extractCompanyName($home, null);
  const links = candidateLinksFrom($home, baseUrl);

  const targets = uniq([baseUrl, ...links]).filter(isAllowed).slice(0, opts.maxPages || 6);
  const pageResults = await Promise.all(
    targets.map((u) =>
      limit(async () => {
        const r = u === baseUrl ? home : await fetchHtml(u, fetchImpl, opts.timeoutMs || 15000);
        if (!r.ok) return null;
        const $ = cheerio.load(r.html);
        const extracted = extractRoleHitsFromPage($, u);
        const locations = extractLocationsFromPage($);
        return { url: u, locations, ...extracted };
      })
    )
  );

  const agg = {
    ceo: { name: null, email: null },
    cfo: { name: null, email: null },
    cmo: { name: null, email: null },
    vp: { name: null, email: null },
    president: { name: null, email: null },
  };

  const allEmails = [];
  const allPhones = [];
  const allLocations = [];

  for (const pr of pageResults.filter(Boolean)) {
    allEmails.push(...pr.emails);
    allPhones.push(...pr.phones);
    allLocations.push(...(pr.locations || []));
    for (const role of Object.keys(agg)) {
      if (!agg[role].name && pr.findings[role]?.name) {
        agg[role] = pr.findings[role];
      }
    }
  }

  return {
    ok: true,
    companyName,
    executives: agg,
    emails: uniq(allEmails).slice(0, 10),
    phones: uniq(allPhones).slice(0, 5),
    locations: uniq(allLocations).slice(0, 5),
    crawledPages: targets,
  };
}

module.exports = { scrapeExecutivesFromWebsite };

