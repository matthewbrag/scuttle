# Scuttle

<img src="web/public/mascot.png" width="200" alt="Scuttle mascot — a lobster with a banana tail" />

*to scuttle* — to move quickly and purposefully, on its own.

A **Docker-native, model-agnostic autonomous coding-agent harness**. Each session runs
in its own container, so agents can be left to work unsupervised without risking the
host. A long-lived server keeps awareness of every running session and lets you jump
between them — from a terminal UI, or from a phone/desktop PWA over your tailnet.

The agent loop runs **server-side**, talking to any OpenAI-compatible `/v1/chat/completions`
endpoint — local (llama.cpp, Ollama, vLLM, ...) by default, cloud if you point it at one.
Scuttle isn't tied to any one model provider or vendor SDK; the server is a thin, plain
HTTP+SSE control plane, and both clients (TUI, PWA) are thin too.

---

## Why it exists

Most agent tools are one process managing many projects, which forces them to key all
state by absolute filesystem path. That couples session history to *where* the project
lives and makes sandboxing awkward (share the real path = lose isolation; isolate =
lose your sessions).

Scuttle inverts it: **the container is the session.** Inside a container there is exactly
one project, at one fixed path, with its own state. The whole class of path-keying bugs
simply cannot occur.

---

## Design principles

1. **The container is the session.** One session = one container = one project. Scoped
   mounts + a resource budget mean a session can be handed broad autonomy safely.
   Containers are **kept, not destroyed** on park/stop — `docker stop`/`start`, never
   `rm` until you explicitly delete a session — so anything the agent installed persists.
2. **The filesystem is the database.** No SQLite, no server-owned DB. State lives in
   plain files under a single well-known root (`$SCUTTLE_HOME`). Visible, greppable,
   diffable, trivially backed up.
3. **Docker is the source of truth for what's running.** Containers self-describe via
   labels; the server reconstructs its worldview from `docker ps` on boot. Nothing to
   corrupt, nothing to get out of sync.
4. **The server is the authority, clients are thin.** Turns run server-side and survive
   a client disconnecting — the whole point of being able to leave something running and
   check back later, from anywhere. The TUI and the PWA are just two different windows
   onto the same plain HTTP+SSE API.

---

## Features

- **Streaming TUI** (Ink) — live token-by-token output, collapsible tool output and
  reasoning, markdown (bold/code), scrollback, a live PERFORMANCE/RESOURCES/INDICATORS
  sidebar, Ctrl+C cancels the current turn without dropping anything already queued.
- **PWA** — the same session API in a browser, installable, responsive down to phone
  width. Served by the same process as the API (no CORS to configure).
- **Background tasks** — `run_bash` can run detached (`background:true`): starts a
  command, returns immediately with a task id, and the agent keeps working while it
  runs. `check_background` / `kill_background` / `list_background` round it out.
- **Vision** — `view_image` lets the agent look at a file itself; `show_image` displays
  one to you (a real `<img>` in the PWA, a link in the TUI).
- **Live indicators** — `set_metric`/`clear_metric` let the agent report on whatever
  it's tracking (loss, throughput, ...), shown in a live sidebar panel.
- **Native stats** — real context usage, tokens/sec, and speculative-decode acceptance
  straight from the model server's own reporting (not estimated), plus live container
  CPU/RAM, and GPU utilization/VRAM for the session's assigned device when available.
  GPU stats degrade silently (not an error) on machines without an NVIDIA GPU — this is
  meant to run on more than just one rig.
- **Context compaction** — once real usage crosses a configurable threshold of the
  model's context window, older messages get summarized into a persisted checkpoint
  (never mutating the human-readable transcript itself) so long sessions don't just
  hard-fail once they fill the window.
- **Basic auth + tailnet-ready** — a generated password protects the server; exposing it
  beyond localhost (e.g. `tailscale serve`) is a deliberate, separate step.

---

## State layout

`$SCUTTLE_HOME` (default `~/.scuttle`) is the single pointer to everything.

```
$SCUTTLE_HOME/
├── server-password              # generated on first run; see Auth below
└── sessions/
    └── <session-id>/
        ├── session.json         # project path, container id, model, status, indicators, timestamps
        ├── transcript.jsonl     # append-only message log — the real, un-compacted history
        ├── compaction.json      # optional: {summary, throughIndex} once a session has been compacted
        └── background/
            └── <task-id>.json   # record for a detached run_bash task (pid, log path, command)
```

- A **project** is just an absolute directory path, recorded on the session that uses it.
- A **session** is a directory. `transcript.jsonl` is append-only — cheap to write, easy
  to tail, greppable, and impossible to corrupt the way a shared DB can be. It is never
  rewritten by compaction; only the model's own prompt gets compacted, via the separate
  checkpoint file.
- **Reconciliation:** each container carries labels `scuttle.session=<id>` and
  `scuttle.project=<path>`, so `docker ps --filter label=scuttle.session` is enough to
  rebuild live state even if `session.json` is stale.

---

## Architecture

```
        Phone / Desktop PWA  ·  Terminal (TUI)
                      │  (plain HTTP + SSE, same API either way)
                      ▼
              ┌──────────────────┐
              │  Scuttle server   │  control plane + agent loop (runs server-side —
              │                  │  turns survive a client disconnecting)
              └──────────────────┘
                 │   │   │           docker exec, per session
           ┌─────┘   │   └─────┐
           ▼         ▼         ▼
       ┌───────┐ ┌───────┐ ┌───────┐
       │session│ │session│ │session│   each: one durable container, one project
       │  A    │ │  B    │ │  C    │   bind-mounted at its real path
       └───────┘ └───────┘ └───────┘
```

### UI passthrough (not yet built)

- **Web apps:** the agent runs its dev server in-container; the server could expose the
  port so you can view the live app from anywhere on the tailnet.
- **GUI / desktop:** `Xvfb` + **noVNC** in the container could stream a virtual display
  to a browser tab — the same pattern computer-use sandboxes use.

---

## Quickstart

```bash
npm install
docker build -t scuttle-runtime --build-arg UID=$(id -u) --build-arg GID=$(id -g) docker/
npm run build:web                 # builds the PWA into web/dist, served by the same server

npm run server                    # or install the systemd --user unit, see systemd/scuttle.service
```

The default image (`docker/Dockerfile`) is intentionally lean — git, build tools, Python,
Node, no GPU/CUDA — so the first build isn't a multi-GB download for work that doesn't
need it. If yours is ML-heavy, `docker/Dockerfile.gpu-ml.example` layers PyTorch/CUDA on
top; build it under its own tag and point `SCUTTLE_IMAGE` at it rather than replacing the
default, so a plain coding session still starts fast.

The server prints a generated password on first run (`scuttle` / `<password>`, also saved
to `$SCUTTLE_HOME/server-password`) — every route requires it, including the PWA.

```bash
# in another shell, from any project folder:
scuttle          # interactive TUI; type to start a session here, / for commands
scuttle ls       # list every session, from anywhere
```

(`ln -s "$PWD/bin/scuttle" ~/.local/bin/scuttle` once, to get a plain `scuttle` command.)

Open `http://localhost:<port>/` (default **4177**) in a browser for the PWA. To reach it
from your phone, expose it over your tailnet — e.g. `tailscale serve --bg --https=8443 <port>`
— rather than binding the server itself to anything but localhost.

### Config (env vars)

| Var | Default | |
|---|---|---|
| `SCUTTLE_MODEL_URL` | `http://localhost:8080/v1` | any OpenAI-compatible endpoint |
| `SCUTTLE_GPU` | `1` | device passed to new session containers (`"none"`/`"all"` also valid) |
| `SCUTTLE_IMAGE` | `scuttle-runtime` | sandbox image |
| `SCUTTLE_CACHE_DIR` | `$SCUTTLE_HOME/cache` | shared pip/HF cache mounted into every session |
| `SCUTTLE_HOME` | `~/.scuttle` | state root |
| `SCUTTLE_PORT` | `4177` | server port |
| `SCUTTLE_COMPACTION_THRESHOLD` | `0.85` | fraction of ctx that triggers compaction |
| `SCUTTLE_COMPACTION_KEEP_RECENT` | `12` | messages always kept verbatim |

---

## Status

Working end-to-end: streaming TUI, PWA, background tasks, vision, live indicators and
native stats, context compaction, basic auth, tailnet exposure — all verified live
against a local model, not just typechecked.

Known gaps: no GPU auto-scheduling across sessions (you pick the device), no scheduled/
recurring tasks, no UI passthrough for dev servers or GUIs (sketch above, not built).
