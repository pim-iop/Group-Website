# Gather group chat

A lightweight, password-protected group chat with live messages and a live activity feed for group-name changes.

## Run locally

1. Install Node.js 20 or later.
2. Keep the provided local `.env` file, or copy `.env.example` to `.env` and set `GROUP_PASSWORD`.
3. Run `npm start`.
4. Open [http://localhost:3000](http://localhost:3000) and sign in with your name and the group password.

The local `.env` is ignored by Git. Set `GROUP_PASSWORD`, `PORT`, and (if needed) `HOST` as environment variables when hosting. Share the website URL and password with your group. Use an HTTPS host for internet access; the server sets secure session cookies when it detects HTTPS.

## Notes

- Messages and group-name changes are broadcast immediately to everyone connected to the same server.
- The most recent 100 messages and 100 activity items are held in memory and are cleared when the server restarts.
- Sessions last up to 12 hours and are also cleared when the server restarts.
- Run one server instance for the shared live feed; separate instances do not share in-memory chat state.
