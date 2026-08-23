const JOBS_ONLY_ICS_URL = process.env.JOBS_ONLY_ICS_URL;
const PRIMARY_ICS_URL = process.env.PRIMARY_ICS_URL;
const GIST_WRITE_TOKEN = process.env.GIST_WRITE_TOKEN;
const GIST_FILENAME = "hhhs-live-schedule.json";
const GIST_DESCRIPTION = "HHHS Command Center — live calendar pull (do not delete)";

if (!JOBS_ONLY_ICS_URL || !PRIMARY_ICS_URL || !GIST_WRITE_TOKEN) {
  console.error("Missing one of JOBS_ONLY_ICS_URL / PRIMARY_ICS_URL / GIST_WRITE_TOKEN secrets.");
  process.exit(1);
}

function unfold(text) {
  return text.replace(/\r\n/g, "\n").split("\n").reduce((lines, line) => {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
    return lines;
  }, []);
}

function unescapeText(value) {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [key, ...paramParts] = left.split(";");
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { key: key.toUpperCase(), params, value };
}

function parseIcsDate(value, params) {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { iso: `${y}-${m}-${d}T00:00:00-07:00`, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const iso = z ? `${y}-${mo}-${d}T${h}:${mi}:${s}Z` : `${y}-${mo}-${d}T${h}:${mi}:${s}-07:00`;
  return { iso, allDay: false };
}

function parseEvents(icsText) {
  const lines = unfold(icsText);
  const events = [];
  let current = null;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") { current = {}; continue; }
    if (raw === "END:VEVENT") { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;
    const { key, params, value } = parsed;
    if (key === "SUMMARY") current.summary = unescapeText(value);
    else if (key === "DESCRIPTION") current.description = unescapeText(value);
    else if (key === "LOCATION") current.location = unescapeText(value);
    else if (key === "UID") current.uid = value;
    else if (key === "STATUS") current.status = value;
    else if (key === "DTSTART") current.dtstart = parseIcsDate(value, params);
    else if (key === "DTEND") current.dtend = parseIcsDate(value, params);
  }
  return events;
}

function sanitizeTitle(title) {
  return title
    .replace(/\$[\d,]+[a-zA-Z]?(?:\/\$[\d,]+[a-zA-Z]?)*/g, "")
    .replace(/#\d[\d-]{6,}\d/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s-]+$/g, "")
    .trim();
}

function categorizeJobsOnly(ev) {
  const summary = (ev.summary || "").trim();
  if (!summary || summary === "---") return null;
  if (ev.status === "CANCELLED") return null;
  if (/frank/i.test(summary)) return "gig";
  if (/hhhs-/i.test(summary)) return "job";
  return "taskrabbit";
}

function categorizePrimary(ev) {
  const summary = (ev.summary || "").trim();
  if (!summary || summary === "---") return null;
  if (ev.status === "CANCELLED") return null;
  if (/hhhs-/i.test(summary)) return "job";
  return null;
}

function toItem(ev, itemType, calendarSource) {
  if (!ev.dtstart) return null;
  const title = sanitizeTitle(ev.summary || "");
  if (!title) return null;
  return {
    externalId: ev.uid || null,
    calendarSource,
    itemType,
    title,
    startAt: ev.dtstart.iso,
    endAt: ev.dtend ? ev.dtend.iso : null,
    allDay: ev.dtstart.allDay,
    location: ev.location || null,
  };
}

async function fetchIcs(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ICS feed: ${res.status}`);
  return await res.text();
}

async function main() {
  const [jobsOnlyText, primaryText] = await Promise.all([fetchIcs(JOBS_ONLY_ICS_URL), fetchIcs(PRIMARY_ICS_URL)]);

  const jobsOnlyItems = parseEvents(jobsOnlyText)
    .map((ev) => { const type = categorizeJobsOnly(ev); return type ? toItem(ev, type, "jobs_only") : null; })
    .filter(Boolean);

  const primaryItems = parseEvents(primaryText)
    .map((ev) => { const type = categorizePrimary(ev); return type ? toItem(ev, type, "primary") : null; })
    .filter(Boolean);

  const items = [...jobsOnlyItems, ...primaryItems].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  const payload = { generatedAt: new Date().toISOString(), items };

  console.log(`Parsed ${items.length} items (${jobsOnlyItems.length} from Jobs Only, ${primaryItems.length} from Primary).`);

  await writeToGist(JSON.stringify(payload, null, 2));
}

async function ghFetch(path, init) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GIST_WRITE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init && init.headers),
    },
  });
}

async function writeToGist(content) {
  const listRes = await ghFetch("/gists?per_page=100");
  if (!listRes.ok) throw new Error(`Failed to list gists: ${listRes.status}`);
  const gists = await listRes.json();
  const existing = gists.find((g) => Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME));

  if (existing) {
    const res = await ghFetch(`/gists/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content } } }),
    });
    if (!res.ok) throw new Error(`Failed to update gist: ${res.status}`);
    console.log(`Updated existing gist: ${existing.id}`);
  } else {
    const res = await ghFetch("/gists", {
      method: "POST",
      body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [GIST_FILENAME]: { content } } }),
    });
    if (!res.ok) throw new Error(`Failed to create gist: ${res.status}`);
    const created = await res.json();
    console.log(`Created NEW gist: ${created.id} — hardcode into the app's fetch code and redeploy.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
