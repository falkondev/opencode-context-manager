# Agent Guidelines for opencode-context-manager

This document provides guidelines for agentic coding agents operating in this repository.

## Project Overview

**opencode-context-manager** is a Bun/TypeScript TUI application that displays analytics and context metrics for OpenCode AI sessions. It reads session data from the SQLite database (`opencode.db`) and renders real-time dashboards in the terminal using the `blessed` UI framework.

**Technology Stack:**
- Runtime: Bun (can be transpiled to Node.js with `bun build --target node`)
- Language: TypeScript with strict mode enabled
- Database: SQLite (read-only access to `~/.local/share/opencode/opencode.db`)
- UI Framework: blessed + blessed-contrib (terminal widgets)
- Version Control: Git

**Key Libraries:**
- `blessed`: Terminal UI framework
- `blessed-contrib`: Additional UI widgets (graphs, tables, etc.)
- `bun:sqlite`: Synchronous SQLite driver

## Build, Lint, and Test Commands

```bash
# Install dependencies (uses Bun package manager)
bun install

# Start development (file watching, hot reload)
bun run dev
# or: bun run start

# Type check only
bun run type-check

# Build production bundle (outputs to dist/)
bun run build

# Run linter (ESLint via bunx)
bun run lint

# Fix linting issues
bun run lint:fix

# Run all tests (Bun test runner)
bun test

# Run tests in watch mode
bun run test:dev

# Run a single test file
bun test tests/analyzers/session-analyzer.test.ts
```

## Code Style Guidelines

### Imports
- Use ES6 module syntax: `import ... from '...'`
- Separate `import type` statements for type-only imports
- Group imports in order: external packages, internal modules, relative imports
- Use path alias `@/` for src/ imports: `import { SessionManager } from '@/managers/session-manager'`
- Include `.ts` extension in relative imports
- One blank line between import groups

```typescript
import { Database } from "bun:sqlite";

import type { IDbSession } from "@/models/session";
import { SessionAnalyzer } from "@/analyzers/session-analyzer";

import { loadConfig } from "./utils/config";
```

### Formatting
- **Indentation:** 2 spaces (enforced by Bun's formatter + ESLint)
- **Line length:** ~80-100 characters
- **Semicolons:** Always use semicolons
- **Trailing commas:** Use in multiline objects/arrays
- **Quotes:** Double quotes for strings (not single)

### TypeScript & Types
- Always provide explicit return types for functions: `function foo(): string { ... }`
- Use `const` by default, `let` when reassignment needed, never `var`
- Define interfaces for objects with `I` prefix: `IDbSession`, `ISessionMetrics`
- Use `type` for discriminated unions and type aliases
- Avoid `any` type; use specific types or `unknown` with type guards
- Use strict null checking: `tsconfig.json` has `strict: true` enabled
- Type import syntax: `import type { IFoo } from '...'`

```typescript
interface ISessionContext {
  sessionId: string;
  timestamp: Date;
  changes: IChange[];
}

type IPartData = IPartDataText | IPartDataTool | IPartDataPatch;

async function analyzeSession(context: ISessionContext): Promise<IAnalysisResult> {
  // Explicit return type required
}
```

### Naming Conventions
- **Files:** kebab-case (`session-manager.ts`, `sqlite-reader.ts`)
- **Directories:** kebab-case (`src/managers/`, `src/analyzers/`, `src/ui/`)
- **Constants:** UPPER_SNAKE_CASE (`const DEFAULT_CONTEXT_LIMIT = 128000`)
- **Functions/Methods:** camelCase (`analyzeSession()`, `listSessions()`)
- **Classes:** PascalCase (`SessionManager`, `SessionAnalyzer`, `SqliteReader`)
- **Interfaces:** PascalCase with `I` prefix (`IDbSession`, `ISessionMetrics`)
- **Variables:** camelCase (`currentSession`, `dbConnection`)
- **Private fields:** camelCase with underscore prefix (`_reader`, `_analyzer`)

### Error Handling
- Always use try-catch for operations that may fail
- No custom error classes; use standard `Error` with descriptive messages
- Check error type before accessing properties: `if (error instanceof Error) { ... }`
- Add explanatory comments for intentional silent failures (graceful degradation)
- Fatal errors should exit with `process.exit(1)`
- Non-fatal errors should be logged or ignored with explicit comments

```typescript
try {
  const results = await analyzeSession(context);
  return results;
} catch (error) {
  if (error instanceof Error) {
    console.error(`Analysis failed: ${error.message}`);
  }
  // Non-fatal — will retry on next poll
  return null;
}
```

## Project Structure

```
opencode-context-manager/
├── src/
│   ├── managers/          # Session and context management
│   │   └── session-manager.ts
│   ├── analyzers/         # Database and metrics analysis
│   │   ├── session-analyzer.ts
│   │   └── sqlite-reader.ts
│   ├── ui/                # Terminal UI (blessed framework)
│   │   ├── dashboard.ts   # Main UI orchestration
│   │   └── utils/         # UI utilities (colors, formatters)
│   ├── models/            # Type definitions and interfaces
│   │   ├── session.ts
│   │   └── metrics.ts
│   ├── utils/             # Utilities (config, watchers, i18n)
│   ├── locales/           # i18n translation files
│   ├── types/             # TypeScript type declarations
│   └── index.ts           # Application entry point
├── tests/                 # Test files (currently empty)
├── tsconfig.json          # TypeScript configuration (strict: true)
├── package.json           # Dependencies and scripts
├── opencode.json          # OpenCode MCP configuration
├── .env.example           # Environment variables template
└── AGENTS.md              # This file
```

## Key Workflows

### UI Rendering Pipeline
1. `SessionManager` polls SQLite database for changes
2. `SessionAnalyzer` computes metrics from raw DB rows
3. `Dashboard` (blessed-contrib) renders widgets with computed data
4. User interaction (keyboard/mouse) triggers session selection
5. Config saved to `~/.config/opencode-cm/config.json`

### Database Query Pattern
- Use `SqliteReader` for all SQLite operations
- Database opened in read-only mode: `{ readonly: true, create: false }`
- Typed queries return parsed interface objects
- Non-critical JSON parsing failures return sensible defaults

## Important Patterns

### Configuration
- Read from `~/.config/opencode-cm/config.json` (or environment fallback)
- Type-safe config with discriminated unions (Language: "en" | "pt-BR")
- Always provide defaults; gracefully handle missing config files
- Use `loadConfig()` from `@/utils/config` for all config access

### Observer Pattern (Callbacks)
```typescript
public onRefresh(cb: RefreshCallback): void {
  this.callbacks.push(cb);
}

private notify(): void {
  for (const cb of this.callbacks) {
    try {
      cb(this.summaries, this.currentMetrics);
    } catch {
      // Ignore callback errors
    }
  }
}
```

### UI Component Structure
- Main entry: `src/ui/dashboard.ts` (881 lines)
- Blessed widgets: sessionList, context, token timeline, details panel
- Colors managed in `src/ui/utils/colors.ts` (e.g., `fg()`, `bold()`, `asciiBar()`)
- Formatting utilities in `src/ui/utils/formatters.ts` (e.g., `fmtTokens()`, `fmtDuration()`, `fmtCost()`)
- Internationalization: `t()` function from `@/utils/i18n`

### Testing
- Test files: `tests/**/*.test.ts`
- Runner: Bun's built-in test framework
- Currently no tests written; use this template when adding tests:

```typescript
import { describe, it, expect } from "bun:test";
import { SessionAnalyzer } from "../../src/analyzers/session-analyzer";

describe("SessionAnalyzer", () => {
  it("should aggregate tokens correctly", () => {
    // Test implementation
  });
});
```

## Development Workflow

1. **Planning:** Understand task scope and dependencies
2. **Exploration:** Use `grep` or glob tools to locate relevant files
3. **Implementation:** Write TypeScript with explicit return types
4. **Type Checking:** Run `bun run type-check` to catch errors
5. **Linting:** Run `bun run lint:fix` to auto-fix style issues
6. **Testing:** Add test cases as needed for critical logic
7. **Git:** Commit with clear present-tense messages

## Git Workflow

- Default branch: `main`
- Create feature branches: `git checkout -b feature/description`
- Commit messages: Clear, present tense (`Add session tracking`, `Fix token calculation`)
- Use `git diff` to verify changes before committing
- Never push to main without review

## MCP Integration Notes

### OpenCode Docs MCP
- Fetch full documentation: `opencode_Docs_fetch_opencode_documentation()`
- Search specific topics: `opencode_Docs_search_opencode_documentation(query)`
- Search code: `opencode_Docs_search_opencode_code(query)`

### SQLite MCP Server (opencode.db)
- List tables: `SQLIte_MCP_Server_Opencode_Folder_list_tables()`
- Get schema: `SQLIte_MCP_Server_Opencode_Folder_get_table_schema(tableName)`
- Query: `SQLIte_MCP_Server_Opencode_Folder_query(sql, values)`
- CRUD: `create_record()`, `read_records()`, `update_records()`, `delete_records()`

## Key Files Reference

| File | Purpose | Size |
|------|---------|------|
| `src/index.ts` | App entry point, initialization | 63 lines |
| `src/managers/session-manager.ts` | Session orchestration, observer pattern | 117 lines |
| `src/analyzers/session-analyzer.ts` | Metrics computation from DB rows | 318 lines |
| `src/analyzers/sqlite-reader.ts` | SQLite read operations, parsing | 152 lines |
| `src/models/session.ts` | DB row interfaces (IDbSession, IMessage, etc.) | 152 lines |
| `src/models/metrics.ts` | Computed metrics types (ISessionMetrics) | 120 lines |
| `src/ui/dashboard.ts` | Terminal UI with blessed widgets | 881 lines |
| `src/ui/utils/colors.ts` | Color palette and formatting helpers | 97 lines |
| `src/ui/utils/formatters.ts` | Value formatting utilities | 128 lines |
| `src/utils/config.ts` | Config file I/O | 68 lines |
| `src/utils/db-watcher.ts` | File mtime polling for changes | 68 lines |
| `src/utils/i18n.ts` | Internationalization (t function) | 35 lines |

## Performance Considerations

- Database opened in read-only mode to prevent locking
- Synchronous SQLite operations (acceptable for query-based workload)
- UI updates debounced via `DbWatcher` polling (default: 2-second interval)
- Callbacks wrapped in try-catch to prevent one bad listener from breaking others
- Session list cached in memory; refreshed only on DB change detection

## Links

- [OpenCode Documentation](https://opencode.ai/docs)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [OpenCode Discord](https://discord.gg/opencode)
