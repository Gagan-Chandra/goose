import {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, systemPreferences, nativeImage,
} from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeWindow } from "./active-window.js";
import { judge } from "./judge.js";
import { visibleWindows } from "./windows.js";
import * as partner from "./partner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

const POLL_MS = 2000;
const SETTLE_MS = 1500; // wait for a window to stay put before judging it
const SNOOZE_MS = 60_000; // after dismissing the note, no note for a minute
// Seconds of slacking before each step: stare, meow, sticky note.
const STRICTNESS = { chill: [3, 30, 90], normal: [1, 10, 30], strict: [1, 5, 15] };
const levels = () => STRICTNESS[settings.strictness] || STRICTNESS.normal;

const DEFAULTS = {
  focusMode: false,         // off = pure desktop pet: no screen reading, no AI, no relay
  goal: "",
  typesafeKey: "",          // the user's own TypeSafe key, used only by focus mode
  followCursor: false,
  home: { mode: "roam" },
  reminders: true,          // reminders and random chatter
  chat: "normal",           // chatty | normal | quiet
  water: 45, eyes: 25, stretch: 60, // reminder intervals in minutes, 0 = off
  strictness: "normal",     // how fast the cat escalates when you slack
  volume: 60,               // 0-100
  size: 100,                // 70-150 %
  startAtLogin: false,
  partner: null,            // { deviceId, pairId, name } once paired
};
let settings = { ...DEFAULTS };
// One transparent window per screen; the cat lives on one at a time and is
// handed over when it walks off an edge onto a neighbouring screen.
const overlays = new Map(); // display id -> BrowserWindow
let activeDisplayId = null;
let settingsWin, partnerWin, tray;

const activeOverlay = () => overlays.get(activeDisplayId);
const eachOverlay = (fn) => overlays.forEach((win, id) => { if (!win.isDestroyed()) fn(win, id); });
const displayList = () => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));

const verdicts = new Map(); // `${goal}|${app}|${title}` -> judge result
let current = null; // { key, app, title, since, result }
let slackSeconds = 0;
let focusSeconds = 0;
let pausedUntil = 0; // break or pause; Infinity when paused indefinitely
let snoozeUntil = 0;
let lastError = null;
let permissionOk = true;      // can we read the frontmost window?
let windowFailures = 0;
let inMeeting = false;
let greeted = false;        // the hello only happens once per run, on one screen
let session = null;           // { until, with } shared focus session

// Apps where the cat should shut up and nap.
const MEETING_APPS = ["zoom.us", "Zoom", "Microsoft Teams", "Webex", "FaceTime", "Google Meet", "Discord"];
const MEETING_TITLES = [/\bzoom meeting\b/i, /\bmeet\.google\.com\b/i, /\bhuddle\b/i, /\bteams meeting\b/i];

const ACCESSIBILITY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(readFileSync(settingsPath(), "utf8")) };
  } catch {}
}

function saveSettings(next) {
  if ("goal" in next && next.goal !== settings.goal) verdicts.clear();
  settings = { ...settings, ...next };
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function createOverlayFor(display) {
  const overlay = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(here, "overlay.html"), { query: { displayId: String(display.id) } });
  overlays.set(display.id, overlay);
}

// Screens come and go: keep one overlay per display, sized to it.
function syncOverlays() {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => d.id));
  for (const [id, win] of overlays) {
    if (!ids.has(id)) { if (!win.isDestroyed()) win.destroy(); overlays.delete(id); }
  }
  for (const d of displays) {
    const win = overlays.get(d.id);
    if (win && !win.isDestroyed()) win.setBounds(d.bounds);
    else createOverlayFor(d);
  }
  if (!overlays.has(activeDisplayId)) activeDisplayId = screen.getPrimaryDisplay().id;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 470,
    height: 700,
    resizable: false,
    title: "Cat settings",
    webPreferences: { preload: path.join(here, "preload.cjs") },
  });
  settingsWin.loadFile(path.join(here, "settings.html"));
}

function openPartner() {
  if (partnerWin && !partnerWin.isDestroyed()) return partnerWin.focus();
  partnerWin = new BrowserWindow({
    width: 430,
    height: 720,
    resizable: false,
    title: "Your partner",
    webPreferences: { preload: path.join(here, "preload.cjs") },
  });
  partnerWin.loadFile(path.join(here, "partner.html"));
  partner.setPartnerWindowOpen(true);
  partnerWin.on("closed", () => partner.setPartnerWindowOpen(false));
}

// What the partner's app shows about me: a coarse status, never window titles.
function myStatus() {
  const now = Date.now();
  if (now < pausedUntil) return { status: "break", focusMinutes: Math.floor(focusSeconds / 60) };
  const verdict = current?.result?.verdict;
  const status = !settings.focusMode || !settings.goal ? "around"
    : verdict === "slacking" ? "slacking" : verdict === "on_task" ? "focusing" : "around";
  return { status, focusMinutes: Math.floor(focusSeconds / 60) };
}

function partnerMenu() {
  const { partner: me } = settings;
  const snap = partner.partnerSnapshot();
  if (!me) return [{ label: "Set up the Couple edition…", click: openPartner }];
  const p = snap.partner;
  const label = p
    ? `${p.name} is ${{ focusing: "focusing", slacking: "slacking off", break: "on a break", offline: "offline" }[p.status] || "around"}`
    : "Waiting for your partner to join…";
  const nudge = (text) => ({ label: text, enabled: !!p, click: () => partner.sendTo("nudge", text) });
  return [
    { label, enabled: false },
    { type: "separator" },
    { label: "Send a note…", click: openPartner },
    nudge("thinking of you ❤️"),
    nudge("coffee? ☕"),
    nudge("call me 📞"),
    { type: "separator" },
    { label: "Remind them…", click: openPartner },
    { label: "Partner window…", click: openPartner },
  ];
}

function createTray() {
  // macOS shows an emoji in the menu bar; Windows and Linux need a real icon.
  if (process.platform === "darwin") {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("🐱");
  } else {
    tray = new Tray(nativeImage.createFromPath(path.join(here, "assets", "tray32.png")));
    tray.setToolTip("Goose: click for the menu");
    // Windows opens a tray menu only on right-click; make a left-click work too.
    tray.on("click", () => tray.popUpContextMenu());
  }
  refreshTray();
}

function refreshTray() {
  const now = Date.now();
  const status = !settings.focusMode
    ? "Just hanging out"
    : !settings.goal
    ? "Focus mode on — no goal set"
    : now < pausedUntil
    ? pausedUntil === Infinity ? "Paused" : `On break for ${Math.ceil((pausedUntil - now) / 60000)} min`
    : current?.result
      ? `${labelFor(current.result.verdict)}${current.result.source === "offline" ? " (offline)" : ""}`
      : "Watching…";
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(permissionOk || !settings.focusMode ? [] : [
      { label: "⚠️  Allow Accessibility access…", click: () => shell.openExternal(ACCESSIBILITY_URL) },
      { type: "separator" },
    ]),
    { label: status, enabled: false },
    ...(session ? [{ label: `Focus session with ${session.with}: ${Math.ceil((session.until - now) / 60000)} min left`, enabled: false }] : []),
    { label: `Focused ${Math.floor(focusSeconds / 60)} min this session`, enabled: false },
    { type: "separator" },
    {
      label: "Focus mode (watch my screen)",
      type: "checkbox",
      checked: !!settings.focusMode,
      click: (item) => {
        saveSettings({ focusMode: item.checked });
        current = null; slackSeconds = 0; permissionOk = true; windowFailures = 0;
        if (item.checked) {
          if (process.platform === "darwin") systemPreferences.isTrustedAccessibilityClient(true);
          if (!settings.goal) openSettings();
        }
        refreshTray();
      },
    },
    { label: "Break for 5 min", click: () => startBreak(5) },
    { label: "Break for 15 min", click: () => startBreak(15) },
    now < pausedUntil
      ? { label: "Resume", click: () => { pausedUntil = 0; refreshTray(); } }
      : { label: "Pause", click: () => { pausedUntil = Infinity; refreshTray(); } },
    { type: "separator" },
    {
      label: "Follow my cursor",
      type: "checkbox",
      checked: settings.followCursor,
      click: (item) => { saveSettings({ followCursor: item.checked }); refreshTray(); },
    },
    {
      label: settings.followCursor ? "Hang out… (while not following)" : "Hang out…",
      submenu: homeMenu(),
    },
    {
      label: "Friendly reminders",
      type: "checkbox",
      checked: settings.reminders,
      click: (item) => { saveSettings({ reminders: item.checked }); refreshTray(); },
    },
    { label: "Partner", submenu: partnerMenu() },
    { label: "Settings…", click: openSettings },
    { label: "Quit", role: "quit" },
  ]));
}

const CORNERS = [
  ["bottom-right", "Bottom-right corner"], ["bottom-left", "Bottom-left corner"],
  ["top-right", "Top-right corner"], ["top-left", "Top-left corner"],
];

function homeMenu() {
  const home = settings.home || { mode: "roam" };
  const set = (h) => { saveSettings({ home: h }); refreshTray(); };
  return [
    { label: "Roam the whole screen", type: "radio", checked: home.mode === "roam", click: () => set({ mode: "roam" }) },
    ...CORNERS.map(([corner, label]) => ({
      label, type: "radio", checked: home.mode === "corner" && home.corner === corner,
      click: () => set({ mode: "corner", corner }),
    })),
    { label: "Where I dropped it", type: "radio", checked: home.mode === "spot", enabled: home.mode === "spot" },
    { type: "separator" },
    { label: "Tip: drag the cat anywhere to make it stay there", enabled: false },
    ...(settings.followCursor ? [{ label: "Paused: the cat is following your cursor", enabled: false }] : []),
  ];
}

// Unsigned dev builds can't register a login item; a packaged app can.
function setLoginItem(openAtLogin) {
  try {
    app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
  } catch (err) {
    console.log("[login item]", err.message);
  }
}

function labelFor(verdict) {
  return { on_task: "On task", neutral: "Neutral", slacking: "Slacking!" }[verdict] || "Watching…";
}

// A shared focus session: both cats count down, then both get the wrap-up.
function startSession(minutes, withWhom) {
  const mins = Math.min(120, Math.max(5, Number(minutes) || 25));
  session = { until: Date.now() + mins * 60_000, with: withWhom, minutes: mins, startedFocus: Math.floor(focusSeconds / 60) };
  console.log(`[session] ${mins} min with ${withWhom}`);
  refreshTray();
}

function checkSession() {
  if (!session || Date.now() < session.until) return;
  const mine = Math.floor(focusSeconds / 60) - session.startedFocus;
  const withWhom = session.with;
  session = null;
  console.log("[session] done");
  activeOverlay()?.webContents.send("partner-message", {
    kind: "note", from: "Focus session",
    text: `Done! ${session_line(mine)} ${withWhom} was right there with you ❤️`,
  });
  refreshTray();
}
const session_line = (mine) => (mine > 0 ? `You focused ${mine} min.` : "Session over.");

function startBreak(minutes) {
  pausedUntil = Date.now() + minutes * 60_000;
  slackSeconds = 0;
  refreshTray();
}

async function poll() {
  if (!settings.focusMode || !settings.goal || Date.now() < pausedUntil) return;
  // Our own windows (settings) shouldn't count as slacking or working.
  if (BrowserWindow.getFocusedWindow()) return;
  const w = await activeWindow();
  if (!w || !w.app) {
    // On macOS this means the Accessibility permission was denied or revoked.
    if (++windowFailures === 4 && permissionOk) { permissionOk = false; refreshTray(); }
    return;
  }
  windowFailures = 0;
  if (!permissionOk) { permissionOk = true; refreshTray(); }
  const meeting = MEETING_APPS.includes(w.app) || MEETING_TITLES.some((re) => re.test(w.title || ""));
  if (meeting !== inMeeting) console.log(`[meeting] ${meeting ? "quiet mode on" : "back to normal"}`);
  inMeeting = meeting;
  if (["loginwindow", "ScreenSaverEngine"].includes(w.app)) return;

  const key = `${settings.goal}|${w.app}|${w.title}`;
  if (current?.key !== key) {
    current = { key, app: w.app, title: w.title, since: Date.now(), result: verdicts.get(key) || null };
    return;
  }
  if (current.result || current.pending || Date.now() - current.since < SETTLE_MS) return;

  current.pending = true;
  const judged = current;
  const result = await judge({ goal: settings.goal, app: w.app, title: w.title, key: settings.typesafeKey });
  judged.pending = false;
  lastError = result.error || null;
  // Offline guesses aren't cached so Jev gets asked once the relay is back.
  if (result.source === "jev") {
    if (verdicts.size > 500) verdicts.delete(verdicts.keys().next().value);
    verdicts.set(key, result);
  }
  judged.result = result;
  console.log(`[judge] ${w.app} — ${w.title} → ${result.verdict} sev=${result.severity?.toFixed?.(2)} (${result.source}${result.error ? `, ${result.error}` : ""})`);
  refreshTray();
}

// The overlay ignores the mouse, so feed it the cursor position directly.
let lastCursor = "";
function sendCursor() {
  const pt = screen.getCursorScreenPoint();
  const pos = [pt.x, pt.y];
  if (pos.join() === lastCursor) return;
  lastCursor = pos.join();
  eachOverlay((win) => win.webContents.send("cursor", pos));
}

// Other apps' windows, so the cat can sit on their top edges and ride along.
let lastWindows = "";
async function sendWindows() {
  if (!overlays.size) return;
  const list = (await visibleWindows())
    .filter((w) => w.pid !== process.pid && w.w >= 200 && w.h >= 80)
    .map((w) => ({ pid: w.pid, x: w.x, y: w.y, w: w.w, h: w.h }));
  const json = JSON.stringify(list);
  if (json === lastWindows) return;
  lastWindows = json;
  eachOverlay((win) => win.webContents.send("windows", list));
}

// Once a second: advance the slack/focus timers and tell the goose how to behave.
function tick() {
  const now = Date.now();
  let mood = "calm";
  let level = 0;

  if (!settings.focusMode || !settings.goal) {
    mood = "calm";
  } else if (now < pausedUntil || inMeeting) {
    // In a meeting the cat naps: no nagging, no noise.
    mood = "sleep";
    slackSeconds = 0;
  } else {
    const r = current?.result;
    // Low-confidence slacking gets the benefit of the doubt.
    const slacking = r?.verdict === "slacking" && r.probability >= 0.6;
    if (slacking) {
      slackSeconds += r.severity >= 2.5 ? 1.5 : 1;
    } else {
      slackSeconds = Math.max(0, slackSeconds - 3);
      if (r?.verdict === "on_task") focusSeconds += 1;
    }
    level = levels().filter((s) => slackSeconds >= s).length;
    if (level === 3 && now < snoozeUntil) level = 2;
    mood = ["calm", "alert", "honk", "chase"][level];
    // A long, unbroken focus streak puts the goose to sleep.
    if (level === 0 && r?.verdict === "on_task" && now - current.since > 5 * 60_000) mood = "sleep";
  }

  const payload = {
    mood,
    goal: settings.goal,
    quiet: inMeeting,
    follow: settings.followCursor,
    reminders: settings.reminders,
    chat: settings.chat,
    intervals: { water: settings.water, eyes: settings.eyes, stretch: settings.stretch },
    volume: settings.volume,
    size: settings.size,
    home: settings.home,
    displays: displayList(),
    greeted,
    activeDisplay: activeDisplayId,
    app: current?.app,
    title: current?.title,
    focusMinutes: Math.floor(focusSeconds / 60),
  };
  eachOverlay((win) => win.webContents.send("goose-state", payload));
}

ipcMain.handle("get-settings", () => ({ ...settings, lastError, permissionOk }));
const NUMERIC = { water: [0, 600], eyes: [0, 600], stretch: [0, 600], volume: [0, 100], size: [70, 150] };

ipcMain.handle("save-settings", (_e, next) => {
  const clean = { goal: String(next.goal || "").trim(), typesafeKey: String(next.typesafeKey || "").trim() };
  for (const [key, [lo, hi]] of Object.entries(NUMERIC)) {
    if (next[key] !== undefined) clean[key] = Math.round(Math.min(hi, Math.max(lo, Number(next[key]) || 0)));
  }
  if (["chill", "normal", "strict"].includes(next.strictness)) clean.strictness = next.strictness;
  if (["chatty", "normal", "quiet"].includes(next.chat)) clean.chat = next.chat;
  if (typeof next.reminders === "boolean") clean.reminders = next.reminders;
  if (typeof next.followCursor === "boolean") clean.followCursor = next.followCursor;
  if (typeof next.focusMode === "boolean") {
    clean.focusMode = next.focusMode;
    if (next.focusMode && process.platform === "darwin") systemPreferences.isTrustedAccessibilityClient(true);
    permissionOk = true; windowFailures = 0;
  }
  if (typeof next.startAtLogin === "boolean") {
    clean.startAtLogin = next.startAtLogin;
    setLoginItem(next.startAtLogin);
  }
  if (next.home?.mode === "roam" || CORNERS.some(([c]) => c === next.home?.corner)) clean.home = next.home;
  saveSettings(clean);
  current = null;
  slackSeconds = 0;
  refreshTray();
  return true;
});
ipcMain.on("set-interactive", (e, on) => BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!on, { forward: true }));
// The cat walked off the edge of one screen: continue it on the next one.
ipcMain.on("handoff", (_e, catState) => {
  const point = { x: Math.round(catState.x + 80), y: Math.round(catState.y + 60) };
  const target = screen.getDisplayNearestPoint(point);
  activeDisplayId = target.id;
  overlays.get(target.id)?.webContents.send("resume", catState);
});
ipcMain.on("dismiss-note", () => {
  snoozeUntil = Date.now() + SNOOZE_MS;
  slackSeconds = levels()[1];
});
ipcMain.on("open-settings", openSettings);
ipcMain.on("open-partner", openPartner);
ipcMain.handle("partner-state", () => partner.refresh());
ipcMain.handle("pair-start", (_e, name) => partner.pairStart(String(name || "").slice(0, 24)));
ipcMain.handle("pair-join", (_e, name, code) => partner.pairJoin(String(name || "").slice(0, 24), String(code || "").slice(0, 8)));
ipcMain.handle("pair-unlink", () => partner.unlink());
ipcMain.handle("partner-send", (_e, kind, text) => {
  if (kind === "session") startSession(text, partner.partnerSnapshot().partner?.name || "Your partner");
  return partner.sendTo(kind, String(text || "").slice(0, 280));
});
ipcMain.on("open-accessibility", () => shell.openExternal(ACCESSIBILITY_URL));
ipcMain.handle("partner-reminders", () => partner.listReminders());
ipcMain.handle("partner-add-reminder", (_e, r) => partner.addReminder(r));
ipcMain.handle("partner-delete-reminder", (_e, id) => partner.deleteReminder(id));
// The cat pets its partner back: petting sends a heart across.
ipcMain.on("greeted", () => { greeted = true; });
ipcMain.on("petted", () => { if (settings.partner) partner.sendTo("heart", ""); });
ipcMain.on("set-home", (_e, home) => {
  if (home?.mode === "spot" && Number.isFinite(home.x) && Number.isFinite(home.y)) {
    saveSettings({ home: { mode: "spot", x: Math.round(home.x), y: Math.round(home.y) } });
  } else if (home?.mode === "roam") {
    saveSettings({ home: { mode: "roam" } });
  }
  refreshTray();
});

// Only one cat at a time: a second launch hands over to the running copy,
// which opens Settings so the user sees something happen.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on("second-instance", () => openSettings());

app.whenReady().then(() => {
  if (!isPrimary) return;
  if (process.platform === "darwin") {
    app.dock.hide();
    // Only ask for Accessibility when focus mode needs it.
    if (settings.focusMode) systemPreferences.isTrustedAccessibilityClient(true);
  }
  loadSettings();
  if (settings.startAtLogin) setLoginItem(true);
  activeDisplayId = screen.getPrimaryDisplay().id;
  syncOverlays();
  createTray();
  if (!settings.goal && !existsSync(settingsPath())) openSettings(); // first run only
  setInterval(poll, POLL_MS);
  setInterval(tick, 1000);
  setInterval(sendCursor, 33);
  setInterval(sendWindows, 1000);
  partner.startPartner({
    getSettings: () => settings,
    patchSettings: (patch) => { saveSettings(patch); refreshTray(); },
    getStatus: myStatus,
    deliver: (item) => {
      if (item.kind === "session") startSession(item.text, item.from);
      activeOverlay()?.webContents.send("partner-message", item);
      refreshTray();
    },
  });
  setInterval(checkSession, 5000);

  // Screens plugged in, unplugged or resized: rebuild the set of overlays.
  screen.on("display-metrics-changed", syncOverlays);
  screen.on("display-added", syncOverlays);
  screen.on("display-removed", syncOverlays);
  setInterval(refreshTray, 30_000);
});

// Closing the settings window shouldn't quit; the goose lives in the tray.
app.on("window-all-closed", (e) => e.preventDefault());
