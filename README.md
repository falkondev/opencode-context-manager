# OpenCode Context Manager

Interactive terminal dashboard that reveals what OpenCode does behind the scenes — context window usage, token breakdown, timing per step, and session history — information the main software doesn't expose.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh | bash`
- OpenCode installed and at least one session created

## Quick Start

```bash
git clone https://github.com/anomalyco/opencode-context-manager
cd opencode-context-manager
bun install && bun start
```

The dashboard auto-detects OpenCode at `~/.local/share/opencode`. No configuration required.

## Custom OpenCode path

```bash
OPENCODE_PATH=/custom/path bun start
```

## What it shows

| Feature | OpenCode | This dashboard |
|---|---|---|
| Context window usage | Number only | Visual bar + history |
| Token composition | Not shown | System prompt / auto-context / user text |
| Auto-injected context (Git diffs) | Not shown | Highlighted with warnings |
| Step-by-step timing | Not shown | Full timeline with elapsed times |
| Session comparison | Not shown | Navigable list with per-session stats |
| Raw token/model data | Not shown | Technical details overlay |

## Navigation

| Key / Action | Description |
|---|---|
| `↑` `↓` or click | Navigate sessions |
| `D` | Toggle technical details overlay |
| `C` | Settings (language, refresh interval) |
| `R` | Force refresh from database |
| `Q` / `Ctrl+C` | Quit |
| `Scroll` | Scroll timeline / details |

## Language

English by default. Switch to **Português Brasileiro** in Settings (`C`).

## Live monitoring

The dashboard polls `opencode.db` every 2 seconds (configurable) and updates automatically when a new OpenCode session starts or tokens are added.

## Configuration

Saved at `~/.config/opencode-cm/config.json`. Managed via the in-app Settings screen.

```json
{
  "language": "en",
  "refreshInterval": 2
}
```
