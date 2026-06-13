# World ID Agent

World ID-gated Claude prompt gateway. Users verify with World, then chat with the agent. Each unique World ID nullifier gets its own private server-side conversation, and the conversation closes automatically after five user messages.

## Run locally

```sh
npm start
```

Open `http://localhost:3000`.

The app runs in mock mode by default. Starting verification simulates a successful World ID result after a short delay.

## Real integrations

Set these environment variables to use live providers:

```sh
BASE_URL=http://localhost:3000
WORLD_APP_ID=app_...
WORLD_RP_ID=rp_...
WORLD_RP_SIGNING_KEY=...
WORLD_ENV=production
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
DATA_FILE=data/app.sqlite
```

Production use requires a World app with World ID 4.0 enabled. This version uses the basic proof-of-human flow and does not verify passport, nationality, or country attributes.

The server stores SQLite state in `data/app.sqlite` by default. It stores users keyed by World nullifier, hashed sessions, derived eligibility metadata, and per-user chat messages. It does not store names, document data, or raw proofs.

Prompt access is limited by persisted user-message count. The fifth user message is accepted, receives a response, and closes the conversation; later prompts are rejected.

## Deploy to production without buying a domain

Deploy the app as a Railway web service and use the generated `*.railway.app` HTTPS domain.

1. Push this repo to GitHub.
2. In Railway, create a new project from the GitHub repo.
3. Configure the service:
   - Build command: `npm ci`
   - Start command: `npm start`
   - Node version: `24`
4. Generate a public Railway domain for the service.
5. Add a Railway volume mounted at `/app/data`.
6. Set these Railway variables:

```sh
NODE_ENV=production
ALLOW_MOCK_PROVIDERS=false
BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
DATA_FILE=/app/data/app.sqlite
WORLD_APP_ID=app_...
WORLD_RP_ID=rp_...
WORLD_RP_SIGNING_KEY=...
WORLD_ENV=production
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

Use Railway sealed variables for `WORLD_RP_SIGNING_KEY` and `ANTHROPIC_API_KEY`.

In the World Developer Portal, enable World ID 4.0 for the app and configure the live app URL with the Railway domain. The app creates a unique World action for each verification attempt to avoid World replay failures, while storing users by the returned RP-scoped nullifier.

After deploy, open `/api/config/status` on the Railway URL to confirm World and Anthropic are configured, then complete a real World App scan and send a test prompt.

In production, the app will not fall back to mock Claude responses when `ALLOW_MOCK_PROVIDERS=false`. If `ANTHROPIC_API_KEY` is missing from the deployed service, chat requests fail with a configuration error instead.

## Test

```sh
npm test
```
