// Focus mode: asks Jev whether the window in front of you serves your goal.
// The key belongs to the person using the app (Settings → Focus mode), so the
// call goes straight to TypeSafe with no server in between.
// Falls back to a small built-in list when there's no key or no connection.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

const OFFLINE_DISTRACTIONS = [
  "tiktok", "instagram", "facebook", "twitter", " x.com", "reddit", "netflix",
  "twitch", "hulu", "disney+", "prime video", "9gag", "tumblr", "snapchat",
  "steam", "epic games", "roblox", "#shorts", "youtube shorts",
];

export async function judge({ goal, app, title, key }) {
  if (!key) return { ...offline(app, title), error: "no_key" };
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildJudgment({ goal, app, title })),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { ...offline(app, title), error: res.status === 401 || res.status === 403 ? "bad_key" : `http_${res.status}` };
    }
    const { answers } = await res.json();
    const v = answers.verdict;
    return {
      verdict: v.choice,
      probability: v.probabilities[v.choice],
      confidence: v.confidence,
      severity: answers.severity.score, // 0 = not a time sink .. 3 = bottomless
      source: "jev",
    };
  } catch {
    return { ...offline(app, title), error: "unreachable" };
  }
}

export function buildJudgment({ goal, app, title }) {
  return {
    model: "jev-latest",
    state: { user_goal: goal, active_app: app, active_window_title: title },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "Given `user_goal`, is the person working toward it right now, judging by what is on screen (`active_app`, `active_window_title`)?",
        criteria: {
          on_task: "The content directly serves the stated goal",
          neutral: "Unclear, or a harmless utility (settings, file manager, music player, calendar)",
          slacking: "Entertainment or a distraction unrelated to the stated goal",
        },
      },
      severity: {
        type: "score",
        instructions:
          "Setting `user_goal` aside, how much of a time sink is what is on screen (`active_app`, `active_window_title`)?",
        criteria: [
          "Not a time sink: work tools, documents, reference material",
          "Mild detour: checking messages, email, a quick news article",
          "Serious distraction: social feeds, entertainment videos, games",
          "Bottomless time sink: infinite scroll, short-form video, binge watching",
        ],
      },
    },
  };
}

function offline(app, title) {
  const hay = ` ${app} ${title}`.toLowerCase();
  const hit = OFFLINE_DISTRACTIONS.some((w) => hay.includes(w));
  return {
    verdict: hit ? "slacking" : "neutral",
    probability: 1,
    confidence: 1,
    severity: hit ? 2 : 0,
    source: "offline",
  };
}

