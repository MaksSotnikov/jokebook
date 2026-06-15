# Deploying to Render

The whole app ships as **one** Render web service (the Fastify server, which
also serves the built web client) plus a **managed Postgres** database. Once
deployed you get a public HTTPS URL that works from any phone or browser.

Everything is described in [`render.yaml`](./render.yaml); Render reads it and
provisions both pieces automatically.

## 1. Put the code on GitHub

`gh` isn't installed here, so create the repo on github.com and push manually:

1. Go to <https://github.com/new>, create an **empty** repo named e.g.
   `notes-app` (no README/.gitignore — the repo already has them).
2. From the project folder (`C:\Users\maksymso\notes-app`):

   ```powershell
   git remote add origin https://github.com/<your-username>/notes-app.git
   git push -u origin main
   ```

   (The first commit is already made for you.)

## 2. Deploy on Render

1. Sign up / log in at <https://render.com> (you can sign in with GitHub).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account and pick the `notes-app` repo.
4. Render detects `render.yaml` and shows two resources: the **notes-app** web
   service and the **notes-db** Postgres. Click **Apply**.
5. Wait for the first build (a few minutes — it builds the Docker image and runs
   the database migrations on boot). When the service is **Live**, copy its URL,
   e.g. `https://notes-app-xxxx.onrender.com`.

No env vars to set by hand: `DATABASE_URL` is wired from the database and
`JWT_SECRET` is generated, both by `render.yaml`.

## 3. Use it from your phone

1. Open the Render URL in the phone's browser.
2. On the login screen leave **Server URL empty** (the app and API share the
   same origin) and tap **Register** with an email + password (≥ 8 chars).
3. Create notes — they're stored in Postgres and reachable from any device that
   logs into the same account.

The desktop (Tauri) app can sync against the same backend: in its sync panel set
**Server URL** to the Render URL and log in with the same account.

## Free-tier caveats

- The free web service **sleeps after ~15 min idle**; the next request cold-starts
  in ~1 minute. Bump the service `plan` in `render.yaml` to avoid this.
- A **free Postgres is deleted 30 days** after creation. Upgrade the database
  `plan` (or back up and recreate) to keep data long-term.

## Updating

Push to `main` → Render auto-deploys (`autoDeploy: true`). Database schema
changes go through Drizzle migrations in `server/drizzle/`, which run on boot.
