# World ID Agent

World ID-gated Claude prompt gateway. Users verify with World, then chat with the agent.

## Run locally

```sh
npm start
```

Open `http://localhost:3000`.

The app runs in mock mode by default. Use **Complete mock World check** in the UI to simulate a successful World ID result.

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
```

Production use requires a World app with World ID 4.0 enabled. This version uses the basic proof-of-human flow and does not verify passport, nationality, or country attributes.

The server stores only derived eligibility metadata in `data/store.json`; it does not store names, document data, raw proofs, prompts, or model responses.

## Test

```sh
npm test
```
