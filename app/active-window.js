// Returns { app, title } for the frontmost window, or null.
// macOS uses the Accessibility API through osascript, which avoids the
// Screen Recording permission that get-windows needs for titles.
import { execFile } from "node:child_process";

const MAC_SCRIPT = `tell application "System Events" to tell (first application process whose frontmost is true)
set t to ""
try
set t to value of attribute "AXTitle" of (value of attribute "AXFocusedWindow")
end try
return name & "|||" & t
end tell`;

export async function activeWindow() {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("osascript", ["-e", MAC_SCRIPT], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        const [app, title = ""] = stdout.trim().split("|||");
        resolve({ app, title });
      });
    });
  }
  let w = null;
  try {
    const { activeWindow: getWindow } = await import("get-windows");
    w = await getWindow();
  } catch {
    return null; // native helper unavailable: focus mode can't see windows
  }
  return w ? { app: w.owner?.name || "", title: w.title || "" } : null;
}
