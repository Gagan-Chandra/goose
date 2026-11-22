// Couple edition: pairing with a partner and exchanging notes, nudges,
// reminders and status through the relay. Runs in the main process.
import { RELAY_URL } from "./config.js";

// Check in often only while something is happening; otherwise rarely.
// Every check is a request against the server's daily free allowance.
const POLL_IDLE_MS = 60_000;
const POLL_ACTIVE_MS = 10_000;
const ACTIVE_FOR_MS = 2 * 60_000; // stay quick for 2 minutes after any activity
const STATUS_NOTE_GAP = 120_000; // don't narrate the partner's every move

let ctx = null; // { getSettings, patchSettings, getStatus, deliver }
let timer = null;
let activeUntil = 0;
let partnerWindowOpen = false;

// Something just happened (a message sent or received, or the partner window
// opened): check in quickly for a while so replies feel live.
export function markActive() {
  activeUntil = Date.now() + ACTIVE_FOR_MS;
  schedule(POLL_ACTIVE_MS);
}

export function setPartnerWindowOpen(open) {
  partnerWindowOpen = open;
  if (open) markActive();
}

function nextDelay() {
  return partnerWindowOpen || Date.now() < activeUntil ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

function schedule(ms = nextDelay()) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick();
    schedule();
  }, ms);
}
let lastStatus = null;
let lastStatusNote = 0;
let snapshot = { paired: false, partner: null, hearts: 0, error: null };

export function startPartner(context) {
  ctx = context;
  tick().then(() => schedule());
}

export function partnerSnapshot() {
  return { ...snapshot, identity: identity() };
}

// Heartbeat on demand, so a window that just opened shows current state.
export async function refresh() {
  await tick();
  return partnerSnapshot();
}

const identity = () => ctx?.getSettings().partner || null;

async function api(path, body) {
  try {
    const res = await fetch(`${RELAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return await res.json();
  } catch {
    return { error: "unreachable" };
  }
}

// --- pairing ---
export async function pairStart(name) {
  const res = await api("/pair/start", { name });
  if (res.error) return res;
  ctx.patchSettings({ partner: { deviceId: res.deviceId, pairId: res.pairId, name } });
  tick();
  return res; // includes the code to send to the partner
}

export async function pairJoin(name, code) {
  const res = await api("/pair/join", { code, name });
  if (res.error) return res;
  ctx.patchSettings({ partner: { deviceId: res.deviceId, pairId: res.pairId, name } });
  tick();
  return res;
}

export async function unlink() {
  const me = identity();
  if (me?.deviceId) await api("/pair/leave", { deviceId: me.deviceId }); // frees the slot
  ctx.patchSettings({ partner: null });
  snapshot = { paired: false, partner: null, hearts: 0, error: null };
  lastStatus = null;
  return { ok: true };
}

// --- messages and reminders ---
export async function sendTo(kind, text) {
  const me = identity();
  if (!me) return { error: "not_paired" };
  markActive();
  return api("/send", { deviceId: me.deviceId, kind, text });
}

export async function listReminders() {
  const me = identity();
  if (!me) return { error: "not_paired" };
  return api("/reminder/list", { deviceId: me.deviceId });
}

export async function addReminder({ text, due, repeat }) {
  const me = identity();
  if (!me) return { error: "not_paired" };
  return api("/reminder/add", { deviceId: me.deviceId, text, due, repeat });
}

export async function deleteReminder(id) {
  const me = identity();
  if (!me) return { error: "not_paired" };
  return api("/reminder/delete", { deviceId: me.deviceId, id });
}

// --- heartbeat ---
const STATUS_VERB = {
  focusing: (n) => `${n} is focusing now 🐾`,
  slacking: (n) => `Psst… ${n} is slacking 👀`,
  break: (n) => `${n} is on a break ☕`,
  offline: (n) => `${n} went offline 🌙`,
};

async function tick() {
  const me = identity();
  if (!me?.deviceId) return;
  const { status, focusMinutes } = ctx.getStatus();
  const res = await api("/sync", { deviceId: me.deviceId, status, focusMinutes });
  if (res.error) {
    snapshot = { ...snapshot, error: res.error };
    if (res.error === "unknown_device") { ctx.patchSettings({ partner: null }); lastStatus = null; } // pair reset on the server
    return;
  }

  snapshot = {
    paired: !!res.paired,
    partner: res.partner,
    hearts: res.me?.hearts || 0,
    error: null,
  };

  if ((res.messages || []).length || (res.reminders || []).length) markActive();
  for (const m of res.messages || []) ctx.deliver({ kind: m.kind, text: m.text, from: m.from });
  for (const r of res.reminders || []) {
    ctx.deliver({ kind: "reminder", text: r.text, from: res.partner?.name || "Your partner" });
  }

  // Narrate meaningful changes in the partner's status, sparingly.
  const now = Date.now();
  const next = res.partner?.status;
  if (next && next !== lastStatus && STATUS_VERB[next] && now - lastStatusNote > STATUS_NOTE_GAP) {
    if (lastStatus !== null) {
      ctx.deliver({ kind: "status", text: STATUS_VERB[next](res.partner.name || "Your partner") });
      lastStatusNote = now;
    }
  }
  if (next) lastStatus = next;
}
