// Where the Couple server lives. Set once the server is deployed; a
// RELAY_URL environment variable overrides it for local testing.
export const RELAY_URL = process.env.RELAY_URL || "http://localhost:8787";
