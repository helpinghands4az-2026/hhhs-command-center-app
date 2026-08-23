const JOBS_ONLY_ICS_URL = process.env.JOBS_ONLY_ICS_URL;
const PRIMARY_ICS_URL = process.env.PRIMARY_ICS_URL;
const GIST_WRITE_TOKEN = process.env.GIST_WRITE_TOKEN;
const GIST_FILENAME = "hhhs-live-schedule.json";
const GIST_DESCRIPTION =
  "HHHS Command Center - live calendar pull (do not delete)";

if (!JOBS_ONLY_ICS_URL || !PRIMARY_ICS_URL || !GIST_WRITE_TOKEN) {
  console.error(
    "Missing one of JOBS_ONLY_ICS_URL / PRIMARY_ICS_URL / " +
    "GIST_WRITE_TOKEN secrets."
  );
  process.exit(1);
}

function unfold(text) {
  const raw = text.replace(/\r\n/g, "\n");
  const rawLines = raw.split("\n");
  const lines = [];
  for (const line of rawLines) {
    const isCont = line.startsWith(" ") || line.startsWith("\t");
    if (isCont && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(";");
  const key = parts[0];
  const paramParts = parts.slice(1);
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq !== -1) {
      const pKey = p.slice(0, eq).toUpperCase();
      params[pKey] = p.slice(eq + 1);
    }
  }
  return { key: key.toUpperCase(), params: params, value: value };
}

function parseIcsDate(value, params) {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4);
    const mo = value.slice(4, 6);
    const d = value.slice(6, 8);
    const iso = y + "-" + mo + "-" + d + "T00:00:00-07:00";
    return { iso: iso, allDay: true };
  }
  const re = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
  const m = value.match(re);
  if (!m) return null;
  const y = m[1];
  const mo = m[2];
  const d = m[3];
  const h = m[4];
  const mi = m[5];
  const s = m[6];
  const z = m[7];
  let iso;
  if (z) {
    iso = y + "-" + mo + "-" + d + "T" + h + ":" + mi + ":" + s + "Z";
  } else {
    iso = y + "-" + mo + "-" + d + "T" + h + ":" + mi + ":" + s + "-07:00";
  }
  return { iso: iso, allDay: false };
}

function parseEvents(icsText) {
  const lines = unfold(icsText);
  const events = [];
  let current = null;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (raw === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;
    const key = parsed.key;
    const params = parsed.params;
    const value = parsed.value;
    if (key === "SUMMARY") {
      current.summary = unescapeText(value);
    } else if (key === "DESCRIPTION") {
      current.description = unescapeText(value);
    } else if (key === "LOCATION") {
      current.location = unescapeText(value);
    } else if (key === "UID") {
      current.uid = value;
    } else if (key === "STATUS") {
      current.status = value;
    } else if (key === "DTSTART") {
      current.dtstart = parseIcsDate(value, params);
    } else if (key === "DTEND") {
      current.dtend = parseIcsDate(value, params);
    }
  }
  return events;
}

function sanitizeTitle(title) {
  return title
    // [a-zA-Z]* (not [a-zA-Z]?) so a whole trailing word like "bal" is consumed, not just
    // one letter. (?:\.\d+)? so cents (e.g. "$860.50bal") don't leave a ".50bal" fragment
    // behind -- both found 2026-08-23 in real synced titles. Later segments' "$" is
    // optional since a title can drop it after the first (e.g. "$1015T/155d/860bal").
    .replace(/\$[\d,]+(?:\.\d+)?[a-zA-Z]*(?:\/\$?[\d,]+(?:\.\d+)?[a-zA-Z]*)*/g, "")
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
  // Real TaskRabbit bookings all carry this link in the description -- found 2026-08-23
  // that NOT everything on this calendar is business (a personal "Jayden party" reminder
  // was on it too), so defaulting anything unmatched to "taskrabbit" was wrong. Require the
  // actual signal instead of guessing.
  const description = ev.description || "";
  if (/taskrabbit\.tr\.co/i.test(description)) return "taskrabbit";
  return null;
}

function categorizePrimary(ev) {
  const summary = (ev.summary || "").trim();
  if (!summary || summary === "---") return null;
  if (ev.status === "CANCELLED") return null;
  if (/hhhs-/i.test(summary)) return "job";
  return null;
}

// Google's ICS export has no date-range parameter -- it returns the WHOLE calendar
// history (found 2026-08-23: events going back to 2019 came through). Schedule only cares
// about "can I book here," so bound the window: 1 day back (catches a job still in
// progress) through 90 days out.
const WINDOW_START_MS = Date.now() - 1 * 24 * 60 * 60 * 1000;
const WINDOW_END_MS = Date.now() + 90 * 24 * 60 * 60 * 1000;

function inWindow(isoString) {
  const t = new Date(isoString).getTime();
  return t >= WINDOW_START_MS && t <= WINDOW_END_MS;
}

function toItem(ev, itemType, calendarSource) {
  if (!ev.dtstart) return null;
  if (!inWindow(ev.dtstart.iso)) return null;
  const title = sanitizeTitle(ev.summary || "");
  if (!title) return null;
  return {
    externalId: ev.uid || null,
    calendarSource: calendarSource,
    itemType: itemType,
    title: title,
    startAt: ev.dtstart.iso,
    endAt: ev.dtend ? ev.dtend.iso : null,
    allDay: ev.dtstart.allDay,
    location: ev.location || null,
  };
}

async function fetchIcs(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch ICS feed: " + res.status);
  }
  return await res.text();
}

async function main() {
  const jobsOnlyText = await fetchIcs(JOBS_ONLY_ICS_URL);
  const primaryText = await fetchIcs(PRIMARY_ICS_URL);

  const jobsOnlyEvents = parseEvents(jobsOnlyText);
  const jobsOnlyItems = [];
  for (const ev of jobsOnlyEvents) {
    const type = categorizeJobsOnly(ev);
    if (type) {
      const item = toItem(ev, type, "jobs_only");
      if (item) jobsOnlyItems.push(item);
    }
  }

  const primaryEvents = parseEvents(primaryText);
  const primaryItems = [];
  for (const ev of primaryEvents) {
    const type = categorizePrimary(ev);
    if (type) {
      const item = toItem(ev, type, "primary");
      if (item) primaryItems.push(item);
    }
  }

  // Some real jobs land on BOTH calendars (confirmed 2026-08-22 -- Glenda Ramirez's job did
  // this too), which showed up as visible duplicates in the merged feed. Dedupe by
  // title+startAt (externalId differs per-calendar for the same real event, so it can't be
  // used for this) -- keep the jobs_only copy when both exist, since that's the calendar
  // that's supposed to be the canonical job list.
  const combined = jobsOnlyItems.concat(primaryItems);
  const seen = new Set();
  const items = [];
  for (const it of combined) {
    const key = it.title + "|" + it.startAt;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }
  items.sort(function (a, b) {
    return new Date(a.startAt) - new Date(b.startAt);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    items: items,
  };

  const jobsCount = jobsOnlyItems.length;
  const primCount = primaryItems.length;
  const dupCount = jobsCount + primCount - items.length;
  console.log(
    "Parsed " + items.length + " items after dedup (" + jobsCount +
    " from Jobs Only, " + primCount + " from Primary, " + dupCount +
    " duplicate(s) removed)."
  );

  await writeToGist(JSON.stringify(payload, null, 2));
}

async function ghFetch(path, init) {
  const url = "https://api.github.com" + path;
  const baseHeaders = {
    Authorization: "Bearer " + GIST_WRITE_TOKEN,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const extraHeaders = (init && init.headers) || {};
  const headers = Object.assign({}, baseHeaders, extraHeaders);
  const finalInit = Object.assign({}, init, { headers: headers });
  return fetch(url, finalInit);
}

async function writeToGist(content) {
  const listRes = await ghFetch("/gists?per_page=100");
  if (!listRes.ok) {
    throw new Error("Failed to list gists: " + listRes.status);
  }
  const gists = await listRes.json();
  let existing = null;
  for (const g of gists) {
    if (Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME)) {
      existing = g;
      break;
    }
  }

  if (existing) {
    const body = JSON.stringify({
      files: { [GIST_FILENAME]: { content: content } },
    });
    const res = await ghFetch("/gists/" + existing.id, {
      method: "PATCH",
      body: body,
    });
    if (!res.ok) {
      throw new Error("Failed to update gist: " + res.status);
    }
    console.log("Updated existing gist: " + existing.id);
  } else {
    const body = JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: content } },
    });
    const res = await ghFetch("/gists", { method: "POST", body: body });
    if (!res.ok) {
      throw new Error("Failed to create gist: " + res.status);
    }
    const created = await res.json();
    console.log(
      "Created NEW gist: " + created.id +
      " -- hardcode into the app's fetch code and redeploy."
    );
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
