// Where the Couple server lives. A RELAY_URL environment variable overrides
// it, e.g. RELAY_URL=http://localhost:8787 for the local dev server.
export const RELAY_URL = process.env.RELAY_URL || "https://goose-couple.goose-relay.workers.dev";
