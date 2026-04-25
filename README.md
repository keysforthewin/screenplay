# screenplay

Discord bot that turns channel `322822813549461535` into an agentic screenplay-writing workspace. The bot uses Anthropic tool use to develop characters and plot in MongoDB, and exports a PDF on demand.

## Run

1. `cp .env.example .env` and fill in `DISCORD_BOT_TOKEN` + `ANTHROPIC_API_KEY`.
2. `docker compose up --build -d`
3. Talk to the bot in the configured channel.

## Dev

`npm install && npm run dev` (requires a Mongo on `localhost:27017` or update `MONGO_URI`).

## Test

`npm test`

## How it works

Every non-bot message in the movie channel triggers an agentic loop:

1. Loads the channel's last 60 messages from Mongo.
2. Builds a fresh system prompt from current state (character names, character template fields, plot status).
3. Calls Anthropic with the full toolset.
4. Loops on `tool_use` blocks (CRUD on `characters`/`plots`/`prompts` collections).
5. Posts the final assistant text back to Discord and persists the turn.

The character schema (template) lives in Mongo and the agent can mutate it via `update_character_template`. When the user says "all characters should have a favorite color," that field is added to the template and the agent will start asking for it on existing and new characters.

## Collections

- `characters` — one doc per character (name, plays_self, hollywood_actor, own_voice, fields.{...})
- `plots` — singleton `{ _id: 'main' }` (synopsis, beats[], notes)
- `prompts` — `character_template` and `plot_template` docs
- `conversations` — per-channel rolling history (last 60 messages, SDK format)
