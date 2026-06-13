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
WORLD_ENV=staging
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
DATA_FILE=data/app.sqlite
```

Production use requires a World app with World ID 4.0 enabled. This version uses the basic proof-of-human flow and does not verify passport, nationality, or country attributes.

The server stores SQLite state in `data/app.sqlite` by default. It stores users keyed by World nullifier, hashed sessions, derived eligibility metadata, and per-user chat messages. It does not store names, document data, or raw proofs.

Prompt access is limited by persisted user-message count. The fifth user message is accepted, receives a response, and closes the conversation; later prompts are rejected.

## Test

```sh
npm test
```
