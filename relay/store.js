// Couple-edition data access. `db` is a tiny adapter ({ all, first, run })
// so the same code runs on Cloudflare D1 and on node:sqlite in dev.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusable 0/O/1/I
const CODE_TTL = 60 * 60 * 1000;
const MAX_DEVICES = 2;
// Cats check in every 60s when idle and write "last seen" at most every 4 min,
// so "offline" means nothing heard for 6 minutes.
const AWAY_AFTER = 6 * 60 * 1000;
const LAST_SEEN_EVERY = 4 * 60 * 1000;

export const newId = () => crypto.randomUUID();

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// The first computer creates a pair and gets a one-use code for the other one.
export async function startPair(db, { name }) {
  const now = Date.now();
  const pairId = newId();
  const code = newCode();
  await db.run(
    "INSERT INTO pairs (pair_id, code, code_expires, created) VALUES (?, ?, ?, ?)",
    pairId, code, now + CODE_TTL, now,
  );
  const deviceId = newId();
  await db.run(
    "INSERT INTO devices (device_id, pair_id, name, status, last_seen) VALUES (?, ?, ?, 'away', ?)",
    deviceId, pairId, name || "Someone", now,
  );
  return { deviceId, pairId, code, expiresAt: now + CODE_TTL };
}

// The other computer joins with that code.
export async function joinPair(db, { code, name }) {
  const now = Date.now();
  const clean = String(code || "").toUpperCase().trim();
  if (!clean) return { error: "bad_code" };
  const pair = await db.first("SELECT * FROM pairs WHERE code = ?", clean);
  if (!pair) return { error: "bad_code" };
  if (pair.code_expires < now) return { error: "code_expired" };

  const devices = await db.all("SELECT * FROM devices WHERE pair_id = ?", pair.pair_id);
  if (devices.length >= MAX_DEVICES) return { error: "pair_full" };

  const deviceId = newId();
  await db.run(
    "INSERT INTO devices (device_id, pair_id, name, status, last_seen) VALUES (?, ?, ?, 'away', ?)",
    deviceId, pair.pair_id, name || "Someone", now,
  );
  // One use per code.
  await db.run("UPDATE pairs SET code = NULL WHERE pair_id = ?", pair.pair_id);
  return { deviceId, pairId: pair.pair_id, partner: view(devices[0], now) };
}

export async function getDevice(db, deviceId) {
  return db.first("SELECT * FROM devices WHERE device_id = ?", deviceId);
}

async function partnerOf(db, device) {
  return db.first("SELECT * FROM devices WHERE pair_id = ? AND device_id != ?", device.pair_id, device.device_id);
}

function view(device, now) {
  if (!device) return null;
  const stale = now - (device.last_seen || 0) > AWAY_AFTER;
  return {
    name: device.name,
    status: stale ? "offline" : device.status,
    focusMinutes: device.focus_minutes || 0,
    hearts: device.hearts || 0,
    lastSeen: device.last_seen,
  };
}

// Heartbeat: report my status, collect anything waiting for me.
export async function sync(db, { deviceId, status, focusMinutes }) {
  const now = Date.now();
  const me = await getDevice(db, deviceId);
  if (!me) return { error: "unknown_device" };
  // Writes are the scarcest free resource: only write when the status or focus
  // count changed, or when "last seen" is getting old.
  const nextStatus = String(status || "away").slice(0, 20);
  const nextFocus = Number(focusMinutes) || 0;
  if (nextStatus !== me.status || nextFocus !== me.focus_minutes || now - (me.last_seen || 0) > LAST_SEEN_EVERY) {
    await db.run(
      "UPDATE devices SET status = ?, focus_minutes = ?, last_seen = ? WHERE device_id = ?",
      nextStatus, nextFocus, now, deviceId,
    );
  }

  const inbox = await db.all(
    "SELECT id, kind, text, from_device FROM messages WHERE to_device = ? AND delivered = 0 ORDER BY id LIMIT 20",
    deviceId,
  );
  if (inbox.length) {
    await db.run(
      `UPDATE messages SET delivered = 1 WHERE id IN (${inbox.map(() => "?").join(",")})`,
      ...inbox.map((m) => m.id),
    );
  }

  const due = await db.all(
    "SELECT id, text, repeat, due FROM reminders WHERE to_device = ? AND active = 1 AND due <= ? ORDER BY due LIMIT 10",
    deviceId, now,
  );
  for (const r of due) {
    if (r.repeat === "daily") {
      await db.run("UPDATE reminders SET due = ? WHERE id = ?", r.due + 86_400_000, r.id);
    } else if (r.repeat === "weekdays") {
      let next = r.due + 86_400_000;
      while ([0, 6].includes(new Date(next).getDay())) next += 86_400_000;
      await db.run("UPDATE reminders SET due = ? WHERE id = ?", next, r.id);
    } else {
      await db.run("UPDATE reminders SET active = 0 WHERE id = ?", r.id);
    }
  }

  const partner = await partnerOf(db, me);
  const fromNames = Object.fromEntries((await db.all("SELECT device_id, name FROM devices WHERE pair_id = ?", me.pair_id))
    .map((d) => [d.device_id, d.name]));
  return {
    me: { name: me.name, hearts: me.hearts || 0 },
    partner: view(partner, now),
    paired: !!partner,
    messages: inbox.map((m) => ({ id: m.id, kind: m.kind, text: m.text, from: fromNames[m.from_device] || "Someone" })),
    reminders: due.map((r) => ({ id: r.id, text: r.text })),
  };
}

const MAX_TEXT = 280;
const KINDS = ["note", "nudge", "heart", "session", "tattle"];

export async function send(db, { deviceId, kind, text }) {
  const me = await getDevice(db, deviceId);
  if (!me) return { error: "unknown_device" };
  const partner = await partnerOf(db, me);
  if (!partner) return { error: "not_paired" };
  if (!KINDS.includes(kind)) return { error: "bad_kind" };

  await db.run(
    "INSERT INTO messages (pair_id, from_device, to_device, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)",
    me.pair_id, deviceId, partner.device_id, kind, String(text || "").slice(0, MAX_TEXT), Date.now(),
  );
  if (kind === "heart") {
    await db.run("UPDATE devices SET hearts = hearts + 1 WHERE device_id IN (?, ?)", deviceId, partner.device_id);
  }
  return { ok: true };
}

export async function addReminder(db, { deviceId, text, due, repeat }) {
  const me = await getDevice(db, deviceId);
  if (!me) return { error: "unknown_device" };
  const partner = await partnerOf(db, me);
  if (!partner) return { error: "not_paired" };
  const when = Number(due);
  if (!Number.isFinite(when)) return { error: "bad_due" };

  await db.run(
    "INSERT INTO reminders (pair_id, from_device, to_device, text, due, repeat) VALUES (?, ?, ?, ?, ?, ?)",
    me.pair_id, deviceId, partner.device_id, String(text || "").slice(0, MAX_TEXT), when,
    ["daily", "weekdays"].includes(repeat) ? repeat : null,
  );
  return { ok: true };
}

// Reminders I set for my partner, so they can be reviewed and cancelled.
export async function listReminders(db, { deviceId }) {
  const me = await getDevice(db, deviceId);
  if (!me) return { error: "unknown_device" };
  const rows = await db.all(
    "SELECT id, text, due, repeat FROM reminders WHERE from_device = ? AND active = 1 ORDER BY due LIMIT 50",
    deviceId,
  );
  return { reminders: rows };
}

// Unlinking frees the slot so the pair can be set up again on a new computer.
export async function leavePair(db, { deviceId }) {
  const me = await getDevice(db, deviceId);
  if (!me) return { ok: true };
  await db.run("DELETE FROM messages WHERE from_device = ? OR to_device = ?", deviceId, deviceId);
  await db.run("DELETE FROM reminders WHERE from_device = ? OR to_device = ?", deviceId, deviceId);
  await db.run("DELETE FROM devices WHERE device_id = ?", deviceId);
  const left = await db.all("SELECT device_id FROM devices WHERE pair_id = ?", me.pair_id);
  if (!left.length) await db.run("DELETE FROM pairs WHERE pair_id = ?", me.pair_id);
  return { ok: true };
}

export async function deleteReminder(db, { deviceId, id }) {
  await db.run("UPDATE reminders SET active = 0 WHERE id = ? AND from_device = ?", Number(id), deviceId);
  return { ok: true };
}
