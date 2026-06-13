# World ID Agent

World ID-gated Claude prompt gateway. Users verify with World, then chat with the agent. Each unique World ID nullifier gets its own private server-side conversation and a one-time $0.10 Claude credit grant.

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

The server stores SQLite state in `data/app.sqlite` by default. It stores users keyed by World nullifier, hashed sessions, derived eligibility metadata, per-user chat messages, and a credit ledger. It does not store names, document data, or raw proofs.

Credit charging uses integer USD micros. A new unique World nullifier receives `100000` micros ($0.10). Live Anthropic requests reserve the user's remaining affordable budget before generation and finalize the charge from returned token usage for `claude-haiku-4-5-20251001`.

## Test

```sh
npm test
```
