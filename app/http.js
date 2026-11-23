// Network requests go through Chromium's network stack inside the app, so they
// use the system proxy and the OS certificate store (antivirus web shields on
// Windows rely on that), exactly like the user's browser does. Outside
// Electron (tests, scripts) it falls back to Node's fetch.
let impl = globalThis.fetch;
if (process.versions.electron) {
  try { impl = (await import("electron")).net.fetch; } catch {}
}
export const httpFetch = (url, init) => impl(url, init);
