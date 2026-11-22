# Goose

A little cat that lives on your desktop. It wanders around your screens, climbs
the edges, naps on top of your windows, follows your cursor if you let it, and
reminds you to drink water. Pair it with someone else's cat and the two can pass
notes, nudges and reminders to each other.

Free, no account needed.

## Download

Grab the latest version from the [Releases page](../../releases/latest):

- **Windows:** `Goose-Setup-<version>.exe`
- **Mac (Apple Silicon):** `Goose-<version>-arm64.dmg`

### First launch on Windows

Goose isn't signed with a paid certificate yet, so Windows shows a blue
**"Windows protected your PC"** screen the first time. Click **More info**, then
**Run anyway**. You only have to do this once.

### First launch on Mac

Drag Goose into **Applications**. Because it isn't notarized by Apple, macOS may
say it "can't be opened" or "is damaged". Open **Terminal** and run this once:

```
xattr -dr com.apple.quarantine /Applications/Goose.app
```

Then open it normally.

## Using it

Everything lives in the menu-bar (Mac) or system-tray (Windows) cat icon:

- **Drag the cat** anywhere and drop it gently: it'll stay there. Swing it around
  and it gets dizzy.
- **Hover over it** to pet it.
- **Hang out…** picks where it lives: anywhere on screen, or a corner.
- **Follow my cursor** makes it trot after your mouse and pounce when you stop.
- **Settings** has the size, sound, reminders, and focus mode.

### Pairing with someone (the couple features)

1. One of you opens **Partner → Set up the Couple edition…**, types a name and
   presses **Start and get a code**.
2. Send that 6-letter code to the other person. It works once, for an hour.
3. They open the same window, press **I have a code**, and enter it.

Now you can send notes (their cat carries the letter across their screen),
quick nudges, and reminders that their cat delivers at the time you set.

### Focus mode (optional, off by default)

Switch it on in Settings and the cat checks whether the window in front of you
matches the goal you typed — and pesters you when it doesn't. It uses
[TypeSafe](https://typesafe.ai)'s Jev model with **your own** API key (about
$0.00002 per check). Without a key it falls back to a short built-in list of
distracting sites. On Mac it needs the Accessibility permission.

## Privacy

- With focus mode off, the cat never looks at your screen.
- With focus mode on, only the app name and window title are checked, and only
  with your own TypeSafe key. Nothing is stored.
- The couple server only ever sees your chosen name, a one-word status
  (focusing / around / break), and the messages you send.

## For developers

```
cd app && npm install && npm start      # the desktop app
cd relay && node dev-server.js          # the couple server, locally
```

Releases are built by GitHub Actions on real Windows and Mac machines when a
`v*` tag is pushed (see `.github/workflows/release.yml`).
