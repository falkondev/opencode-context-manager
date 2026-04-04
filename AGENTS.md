# Agent Guidelines for opencode-context-manager

This document provides guidelines for agentic coding agents operating in this repository.

## Project Overview

**opencode-context-manager** is a Node.js application that manages OpenCode AI sessions and context. It tracks session state, analyzes file changes between OpenCode sessions, and monitors database modifications through SQLite integration.

**Technology Stack:**
- Runtime: Node.js with Bun package manager
- Primary Language: TypeScript
- Database: SQLite (via opencode.db at `~/.local/share/opencode/`)
- Version Control: Git

**MCP Servers:**
- `opencode Docs`: Remote MCP for OpenCode source code and internals
- `SQLIte MCP Server Opencode Folder`: Local SQLite wrapper for opencode.db analysis

## Build, Lint, and Test Commands

### Package Manager: Bun
All commands below use `bun` as the package manager. Install with: `curl -fsSL https://bun.sh | bash`

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Build production bundle
bun run build

# Run linter
bun run lint

# Fix linting issues
bun run lint:fix

# Run tests
bun run test

# Run a single test file
bun test path/to/test.test.ts

# Watch mode for development
bun run watch

# Type check
bun run type-check
```

## Code Style Guidelines

### Imports
- Use ES6 module syntax: `import ... from '...'`
- Group imports in order: external packages, internal modules, relative imports
- One blank line between groups

```typescript
import { Server } from 'http';
import path from 'path';

import { SessionManager } from '@/managers/session';
import { GitAnalyzer } from '@/analyzers/git';

import { config } from './config';
```

### Formatting
- **Indentation:** 2 spaces (enforced by Prettier)
- **Line length:** 100 characters maximum
- **Semicolons:** Always use semicolons
- **Trailing commas:** Use in multiline objects/arrays
- **Quotes:** Double quotes for strings

### TypeScript & Types
- Always provide explicit return types for functions
- Use `const` by default, `let` when reassignment needed, never `var`
- Define interfaces for objects, use `type` for aliases
- Avoid `any` type; use `unknown` when necessary and narrow with type guards
- Use strict null checking: `tsconfig.json` should have `strict: true`

```typescript
interface SessionContext {
  sessionId: string;
  timestamp: Date;
  changes: Change[];
}

async function analyzeSession(context: SessionContext): Promise<AnalysisResult> {
  // Implementation
}
```

### Naming Conventions
- **Files:** kebab-case (`session-manager.ts`, `git-analyzer.ts`)
- **Directories:** kebab-case (`src/managers/`, `src/analyzers/`)
- **Constants:** UPPER_SNAKE_CASE (`const OPENCODE_DB_PATH = '...'`)
- **Functions/Methods:** camelCase (`analyzeChanges()`, `trackSession()`)
- **Classes:** PascalCase (`SessionManager`, `GitAnalyzer`)
- **Interfaces:** PascalCase prefixed with `I` (`ISessionContext`)
- **Variables:** camelCase (`currentSession`, `dbConnection`)

### Error Handling
- Always handle errors explicitly; no silent failures
- Use custom error classes extending `Error`
- Provide descriptive error messages with context

```typescript
class SessionError extends Error {
  constructor(sessionId: string, message: string) {
    super(`Session ${sessionId}: ${message}`);
    this.name = 'SessionError';
  }
}

try {
  await analyzeSession(context);
} catch (error) {
  if (error instanceof SessionError) {
    logger.error(error.message);
  } else {
    throw new SessionError(sessionId, 'Unexpected error');
  }
}
```

## Project Structure

```
opencode-context-manager/
├── src/
│   ├── managers/          # Session and context management
│   ├── analyzers/         # Git and SQLite analysis
│   ├── services/          # MCP server integrations
│   ├── models/            # Data models and types
│   ├── utils/             # Helper functions
│   └── index.ts           # Application entry point
├── tests/                 # Test files (*.test.ts)
├── opencode.json          # OpenCode MCP configuration
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── .env.example           # Environment variables template
└── AGENTS.md              # This file
```

## Key Workflows

### Session Analysis Pattern
1. Receive OpenCode session path (default: `~/.local/share/opencode/`)
2. Use `git` to identify changed files
3. Query SQLite database for modifications
4. Cross-reference with OpenCode Docs MCP for internal changes
5. Generate analysis report

### Database Monitoring
- Use SQLite MCP Server for table queries and record inspection
- Track schema changes via `opencode.db` version
- Monitor user-created tables (agents, skills, rules, workflows, MCPs)

## Important Patterns

### Configuration
- Read from environment variables or `~/.local/share/opencode/opencode.json`
- Validate paths at startup
- Use absolute paths consistently

### Logging
- Use structured logging (consider winston or pino)
- Include context: sessionId, timestamp, operation
- Log at appropriate levels: error, warn, info, debug

### Testing
- Test files: `src/**/__tests__/**/*.test.ts` or `src/**/*.test.ts`
- Use consistent testing framework (Jest or Vitest)
- Mock MCP server responses
- Test database operations in isolation

## Development Workflow

1. **Planning:** Understand task scope and dependencies
2. **Analysis:** Use `git log`, `git diff` to inspect changes
3. **Implementation:** Write TypeScript with explicit types
4. **Testing:** Run `bun test` before commit
5. **Linting:** Run `bun run lint:fix` to auto-fix issues
6. **Type Checking:** Run `bun run type-check` to ensure correctness

## Git Workflow

- Default branch: `main`
- Create feature branches: `git checkout -b feature/description`
- Commit messages: Clear, present tense (`Add session tracking`)
- Use `git diff` to verify changes before committing

## MCP Integration Notes

### OpenCode Docs MCP
- Fetch full documentation with `opencode_Docs_fetch_opencode_documentation()`
- Search specific topics with `opencode_Docs_search_opencode_documentation(query)`
- Search code with `opencode_Docs_search_opencode_code(query)`

### SQLite MCP Server
- List tables: `SQLIte_MCP_Server_Opencode_Folder_list_tables()`
- Get schema: `SQLIte_MCP_Server_Opencode_Folder_get_table_schema(tableName)`
- Query: `SQLIte_MCP_Server_Opencode_Folder_query(sql, values)`
- CRUD operations: `create_record()`, `read_records()`, `update_records()`, `delete_records()`

## Environment Setup

```bash
# User must provide OpenCode path (defaults to ~/.local/share/opencode/)
export OPENCODE_PATH="$HOME/.local/share/opencode"

# Database is automatically located at $OPENCODE_PATH/opencode.db
# Git repository is initialized: git init $OPENCODE_PATH
```

## Performance Considerations

- Cache session metadata to avoid repeated database queries
- Use git diff-tree for efficient change detection
- Batch database operations when possible
- Stream large file processing instead of loading into memory

## Links

- [OpenCode Documentation](https://opencode.ai/docs)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [OpenCode Discord](https://discord.gg/opencode)
