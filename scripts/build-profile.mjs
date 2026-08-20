#!/usr/bin/env node
/**
 * Regenerates the marked sections of profile/README.md:
 *
 *   <!-- streams:start --> ... <!-- streams:end -->     live YouTube streams
 *   <!-- articles:start --> ... <!-- articles:end -->   latest NASASpaceflight.com posts
 *   <!-- launches:start --> ... <!-- launches:end -->   next launches from the Next Spaceflight API
 *   <!-- updated:start --> ... <!-- updated:end -->     footer timestamp
 *
 * Every section fails soft: if a source is unreachable the previously generated
 * markup is left in place rather than replaced with an error, so the profile
 * never degrades because of one bad fetch.
 *
 * Env:
 *   NEXTSPACEFLIGHT_API_URL         (required for the launches section; store as a repo secret)
 *   NEXTSPACEFLIGHT_STATUS_API_URL  (optional; the launch status list that names and
 *                                    colours the badges — falls back to the built-in
 *                                    colours below when unset or unreachable)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "profile", "README.md");
const config = JSON.parse(await readFile(join(ROOT, "scripts", "config.json"), "utf8"));

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn(`::warning::${msg}`);
};

/* ------------------------------------------------------------------ utils */

async function fetchText(url, { headers = {}, tries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastErr?.message ?? lastErr}`);
}

/**
 * GitHub proxies every README image through camo, which serves a broken image
 * for anything that is not returned with an `image/*` content type — the Next
 * Spaceflight vehicle renders, for instance, are valid WebP but come off Google
 * Cloud Storage as `application/octet-stream`. Check before linking so a bad
 * source degrades to a placeholder instead of a broken image icon.
 */
async function isUsableImage(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Decode the entity + \uXXXX escapes that show up in RSS and YouTube payloads. */
function decode(s = "") {
  return String(s)
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["'\\/])/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([\dA-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#8230;|&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .trim();
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return decode(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1"));
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

const dateUTC = (d) => `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const timeUTC = (d) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;

/* ---------------------------------------------------------------- streams */

/**
 * The 24/7 streams are long-running broadcasts, so they never appear in the
 * channel RSS feed. Read the video IDs off the channel page's "Live now" shelf
 * instead, and fall back to the pinned IDs in config.json if the page shape
 * changes.
 */
async function fetchStreams() {
  const streams = config.youtube.streams;
  let lockups = [];

  try {
    const html = await fetchText(`${config.youtube.channelUrl}?hl=en`, { headers: { cookie: "SOCS=CAI;" } });
    lockups = html
      .split('"lockupViewModel"')
      .slice(1)
      .map((chunk) => {
        const c = chunk.slice(0, 8000);
        const videoId = c.match(/i\.ytimg\.com\/vi\/([\w-]{11})\//)?.[1];
        const title = c.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/)?.[1];
        if (!videoId || !title) return null;
        return { videoId, title: decode(title), live: c.includes("THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE") };
      })
      .filter(Boolean);
    if (!lockups.length) warn("YouTube channel page returned no parsable videos; using fallback video IDs.");
  } catch (err) {
    warn(`Could not read the YouTube channel page (${err.message}); using fallback video IDs.`);
  }

  return Promise.all(
    streams.map(async (stream) => {
      const re = new RegExp(stream.match, "i");
      const hit =
        lockups.find((l) => l.live && re.test(l.title)) ?? lockups.find((l) => re.test(l.title)) ?? null;
      const videoId = hit?.videoId ?? stream.fallbackVideoId;
      const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
      return {
        ...stream,
        videoId,
        live: hit?.live ?? false,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: (await isUsableImage(maxres)) ? maxres : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    })
  );
}

function renderStreams(streams) {
  const cells = streams
    .map((s) => {
      const status = s.live
        ? '<img src="https://img.shields.io/badge/%E2%97%8F%20LIVE-e5484d?style=flat-square" alt="Live" height="20">'
        : '<img src="https://img.shields.io/badge/%E2%97%8F%20OFFLINE-6e7681?style=flat-square" alt="Offline" height="20">';
      return [
        `<td width="33.3%" align="center" valign="top">`,
        `  <a href="${esc(s.url)}"><img src="${esc(s.thumbnail)}" alt="${esc(s.title)}" width="100%"></a>`,
        `  <br><br>`,
        `  ${status}`,
        `  <br>`,
        `  <a href="${esc(s.url)}"><b>${esc(s.title)}</b></a>`,
        `  <br>`,
        `  <sub>${s.blurb}</sub>`,
        `</td>`,
      ].join("\n");
    })
    .join("\n");

  return `<table>\n<tr>\n${cells}\n</tr>\n</table>`;
}

/* --------------------------------------------------------------- articles */

async function fetchArticles() {
  const xml = await fetchText(config.articles.feedUrl);
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  if (!items.length) throw new Error("no <item> elements in feed");

  const articles = items.slice(0, config.articles.count).map((item) => {
    const content = item.match(/<content:encoded>[\s\S]*?<\/content:encoded>/)?.[0] ?? "";
    const published = new Date(tag(item, "pubDate"));

    // Prefer the smallest srcset variant that is still sharp at card size over
    // the multi-megabyte original.
    const srcset = content.match(/srcset="([^"]+)"/)?.[1] ?? "";
    const candidates = srcset
      .split(",")
      .map((part) => part.trim().match(/^(\S+)\s+(\d+)w$/))
      .filter(Boolean)
      .map((m) => ({ url: decode(m[1]), width: Number(m[2]) }))
      .sort((a, b) => a.width - b.width);
    const image =
      candidates.find((c) => c.width >= 400)?.url ??
      candidates.at(-1)?.url ??
      decode(content.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? "");

    // The feed's description is a teaser paragraph followed by a boilerplate
    // "The post ... appeared first on ..." line; keep only the teaser.
    const excerpt = decode(tag(item, "description"))
      .split(/<\/p>/)[0]
      .replace(/<[^>]+>/g, "")
      .trim();

    return {
      title: tag(item, "title"),
      link: tag(item, "link"),
      author: tag(item, "dc:creator"),
      published,
      image,
      excerpt,
    };
  });

  return Promise.all(
    articles.map(async (a) => ({ ...a, image: (await isUsableImage(a.image)) ? a.image : "" }))
  );
}

function renderArticles(articles) {
  const rows = articles
    .map((a) => {
      const meta = [dateUTC(a.published), a.author].filter(Boolean).map(esc).join(" &middot; ");
      const thumb = a.image
        ? `<a href="${esc(a.link)}"><img src="${esc(a.image)}" alt="" width="200"></a>`
        : "&nbsp;";
      return [
        `<tr>`,
        `<td width="220" align="center" valign="middle">${thumb}</td>`,
        `<td valign="middle">`,
        `  <b><a href="${esc(a.link)}">${esc(a.title)}</a></b>`,
        `  <br>`,
        `  <sub>${meta}</sub>`,
        a.excerpt ? `  <br><br>\n  <sub>${esc(a.excerpt)}</sub>` : "",
        `</td>`,
        `</tr>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `<table>\n${rows}\n</table>`;
}

/* --------------------------------------------------------------- launches */

async function fetchLaunches() {
  const apiUrl = process.env.NEXTSPACEFLIGHT_API_URL;
  if (!apiUrl) throw new Error("NEXTSPACEFLIGHT_API_URL is not set");

  const [body, statuses] = await Promise.all([
    fetchText(apiUrl, { headers: { accept: "application/json" } }),
    fetchStatuses(),
  ]);
  const data = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error("expected a JSON array of launches");

  const upcoming = data
    .filter((l) => l && l.net)
    .sort((a, b) => new Date(a.net) - new Date(b.net))
    .slice(0, config.launches.count);

  const placeholder = `${config.assetsBaseUrl}/nxf_default.jpg`;
  return Promise.all(
    upcoming.map(async (l) => ({
      ...l,
      resolvedStatus: resolveStatus(l.status, statuses),
      image: (await isUsableImage(l.vehicle_config_image)) ? l.vehicle_config_image : placeholder,
    }))
  );
}

/**
 * Last-resort badge colours, keyed the same way as the live status list. They
 * only come into play when the status endpoint is unset or unreachable, so they
 * cover both the names the launch feed has historically used (tbc, scrubbed)
 * and the ones the endpoint publishes.
 */
const FALLBACK_STATUS_COLORS = {
  tbddatetime: "6e7681",
  tbdtime: "6e7681",
  tbd: "6e7681",
  tbc: "d29922",
  go: "2ea043",
  hold: "d29922",
  scrub: "e5484d",
  scrubbed: "e5484d",
  inflight: "58a6ff",
  success: "2ea043",
  partialfailure: "d29922",
  failure: "e5484d",
  prelaunchfailure: "e5484d",
  outcomepending: "6e7681",
};

/** Status ids and names are matched case- and punctuation-insensitively. */
const statusKey = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

/** shields.io takes a bare hex triplet, the endpoint publishes `#RRGGBB`. */
const hexColor = (value) => /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(value ?? "").trim())?.[1].toLowerCase() ?? "";

/**
 * The launch statuses live behind their own endpoint — id, display name and the
 * colour Next Spaceflight uses for each state. Fail soft down to the built-in
 * colours: a bad fetch should cost the badges their brand colour, not take the
 * whole launches section down with it.
 */
async function fetchStatuses() {
  const url = process.env.NEXTSPACEFLIGHT_STATUS_API_URL;
  if (!url) {
    warn("NEXTSPACEFLIGHT_STATUS_API_URL is not set; using the built-in status colours.");
    return new Map();
  }

  try {
    const { list } = JSON.parse(await fetchText(url, { headers: { accept: "application/json" } }));
    if (!Array.isArray(list) || !list.length) throw new Error("expected a non-empty `list` array");

    const statuses = new Map();
    for (const status of list) {
      if (!status?.name) continue;
      const entry = { label: String(status.name), color: hexColor(status.color) };
      statuses.set(statusKey(status.name), entry);
      if (status.id != null) statuses.set(statusKey(status.id), entry);
    }
    if (!statuses.size) throw new Error("no usable entries in `list`");
    return statuses;
  } catch (err) {
    warn(`Could not read the launch status list (${err.message}); using the built-in status colours.`);
    return new Map();
  }
}

/** A launch carries either the status id or its name; both key the same entry. */
function resolveStatus(status, statuses) {
  if (status == null || status === "") return null;
  const key = statusKey(status);
  const hit = statuses.get(key);
  // An id only means something once the endpoint has named it; drop the badge
  // rather than label a launch "7" when the status list could not be read.
  if (!hit && /^\d+$/.test(key)) return null;
  return {
    label: hit?.label ?? String(status),
    color: hit?.color || FALLBACK_STATUS_COLORS[key] || "58a6ff",
  };
}

function statusBadge(status) {
  if (!status) return "";
  const label = encodeURIComponent(status.label.replace(/-/g, "--").replace(/_/g, "__"));
  return `<img src="https://img.shields.io/badge/${label}-${status.color}?style=flat-square" alt="${esc(status.label)}" height="20">`;
}

function renderLaunches(launches) {
  const rows = launches
    .map((l) => {
      const net = new Date(l.net);
      const site = [l.pad, l.location].filter(Boolean).join(", ");
      const name = esc(l.name || "Untitled mission");
      const title = l.info_url ? `<a href="https://nextspaceflight.com/launches/details/7797/${l.id}">${name}</a>` : name;

      const timeParts = [`<b>${dateUTC(net)}</b> &middot; ${timeUTC(net)} UTC`];
      if (l.window_open && l.window_close) {
        const open = new Date(l.window_open);
        const close = new Date(l.window_close);
        timeParts.push(`window ${timeUTC(open)}&ndash;${timeUTC(close)} UTC`);
      }

      const links = [];
      if (l.vid_url) links.push(`<a href="${esc(l.vid_url)}">Watch</a>`);
      if (l.info_url) links.push(`<a href="${esc(l.info_url)}">Preview</a>`);

      const image = `<img src="${esc(l.image)}" alt="${esc(l.vehicle || "Launch vehicle")}" width="88">`;
      const placeholder = `${config.assetsBaseUrl}/nxf_default.jpg`;
      return [
        `<tr>`,
        `<td width="110" align="center" valign="middle">${image || placeholder}</td>`,
        `<td valign="middle">`,
        `  <b>${title}</b>`,
        `  <br>`,
        `  <sub>${[l.provider, l.vehicle].filter(Boolean).map(esc).join(" &middot; ")}</sub>`,
        site ? `  <br>\n  <sub>${esc(site)}</sub>` : "",
        `  <br>`,
        `  <sub>${timeParts.join(" &middot; ")}</sub>`,
        `</td>`,
        `<td width="130" align="center" valign="middle">`,
        `  ${statusBadge(l.resolvedStatus)}`,
        links.length ? `  <br>\n  <sub>${links.join(" &middot; ")}</sub>` : "",
        `</td>`,
        `</tr>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  // Apple's badge is 119.664x40 with no padding; Google's is 646x250 with a
  // uniform 41px transparent margin, so its artwork is only 67.2% of the canvas.
  // The different heights below make the two visible badges the same size
  // (44 vs 65 * 0.672 = 43.7), and align="middle" centres them on each other --
  // inline images sit on the text baseline by default, which left the Google
  // badge floating ~11px high on the empty part of its own canvas.
  const { siteUrl, appStoreUrl, playStoreUrl } = config.launches;

  return [
    `<table align="center">`,
    rows,
    `</table>`,
    ``,
    `<p align="center">`,
    `  <a href="${esc(appStoreUrl)}"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download Next Spaceflight on the App Store" align="middle" height="44"></a>`,
    `  &nbsp;`,
    `  <a href="${esc(playStoreUrl)}"><img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get Next Spaceflight on Google Play" align="middle" height="65"></a>`,
    `</p>`,
    ``,
    `<p align="center"><sub>Full schedule, launch history and mission details at <a href="${esc(siteUrl)}">nextspaceflight.com</a></sub></p>`,
  ].join("\n");
}

/* ----------------------------------------------------------------- splice */

function replaceBlock(md, name, content) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(md)) throw new Error(`marker <!-- ${name}:start --> not found in profile/README.md`);
  return md.replace(re, `$1\n${content}\n$2`);
}

async function section(md, name, load, render) {
  try {
    return replaceBlock(md, name, render(await load()));
  } catch (err) {
    warn(`${name}: ${err.message} — keeping the previously generated section.`);
    return md;
  }
}

/* ------------------------------------------------------------------- main */

let md = await readFile(README, "utf8");
const before = md;

md = await section(md, "streams", fetchStreams, renderStreams);
md = await section(md, "articles", fetchArticles, renderArticles);
md = await section(md, "launches", fetchLaunches, renderLaunches);

// Only stamp the footer when something above it actually changed, so a quiet
// hour doesn't produce a stream of empty commits. (An empty footer block — a
// freshly edited template — always gets stamped.)
const footerEmpty = /<!-- updated:start -->\s*<!-- updated:end -->/.test(md);

if (md === before && !footerEmpty) {
  console.log("profile/README.md is already up to date.");
} else {
  const now = new Date();
  md = replaceBlock(
    md,
    "updated",
    `<p align="center"><sub>Last Updated: ${dateUTC(now)} at ${timeUTC(now)} UTC</sub></p>`
  );
  await writeFile(README, md);
  console.log("profile/README.md updated.");
}

if (warnings.length) console.log(`Completed with ${warnings.length} warning(s).`);
