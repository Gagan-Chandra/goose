// Lists other apps' visible windows, front to back, in screen coordinates.
// macOS reads window bounds from CoreGraphics via JXA, which needs no
// Screen Recording permission because it never touches titles or pixels.
import { execFile } from "node:child_process";

const MAC_SCRIPT = `
ObjC.import("CoreGraphics");
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
const out = [];
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i);
  if (ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
  const b = w.objectForKey("kCGWindowBounds");
  out.push({
    pid: ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID")),
    x: ObjC.unwrap(b.objectForKey("X")), y: ObjC.unwrap(b.objectForKey("Y")),
    w: ObjC.unwrap(b.objectForKey("Width")), h: ObjC.unwrap(b.objectForKey("Height")),
  });
}
JSON.stringify(out);`;

export async function visibleWindows() {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve([]);
        try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
      });
    });
  }
  // The native helper can be missing (e.g. a build made on another OS):
  // then the cat simply doesn't perch on windows.
  let list = [];
  try {
    const { openWindows } = await import("get-windows");
    list = await openWindows();
  } catch {
    return [];
  }
  return list.map((w) => ({
    pid: w.owner?.processId, x: w.bounds.x, y: w.bounds.y, w: w.bounds.width, h: w.bounds.height,
  }));
}
