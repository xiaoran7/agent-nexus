# Agent-Nexus

> ⚡ **Zero-overhead Concurrency Coordinator & Resilient AI Gateway for Multi-Agent Coding (Claude Code, Codex, Cursor)**
> 
> [English](README_EN.md) | [中文](README.md)

**Agent-Nexus** is a lightweight, zero-overhead coordination engine and resilient AI gateway built for concurrent coding agents. When multiple AI agents (e.g., Claude Code, OpenAI Codex, Cursor) work on the same workspace or across multiple Git Worktrees, Agent-Nexus prevents **silent file overwrite collisions, test suite & port racing, and Git merge disasters**—without polluting your business repositories.

---

### Why Agent-Nexus? (Problem & Solution)

- ❌ **The Problem**: When running multiple concurrent Claude Code or AI coding sessions, agents have no shared awareness. They frequently overwrite each other's edits, run conflicting tests on the same ports, or touch related files in different Git Worktrees, creating brutal Git merge conflicts and corrupted workspaces.
-  **The Solution**: Agent-Nexus intercepts file writes and exclusive commands at the lowest layer (`PreToolUse` Hook) in milliseconds. Non-conflicting tasks run immediately in parallel; conflicting agents are placed into a deterministic waiting queue (**Safe Corridor**). When active leases expire, are released, or when an agent process unexpectedly exits, waiting agents are awakened automatically in milliseconds.

---

### Feature Matrix & Comparison

| Feature / Dimension | Uncoordinated Agents | Heavy Distributed Locks | **Agent-Nexus** |
|---|---|---|---|
| **Integration Overhead** | Zero protection; frequent file clobbering & Git conflicts | Heavy; requires modifying agent code or business repos | **Zero overhead: Global hook with 0 repo files, 0 gitignore, 0 boilerplate** |
| **Conflict Granularity** | Manual developer intervention or painful Git resolution | Coarse-grained repository or raw file locks | **Fine-grained File / Module / Symbol hierarchy with intelligent wait sorting** |
| **Git Worktree Support** | Path drift across worktrees causes collision blindness | Unaware of Git worktrees | **Common Git root discovery & path normalization (`crewmates`)** |
| **Fault Recovery** | Dead sessions leave orphaned locks for hours | Passive waiting for long TTL lease expiration | **Real-time Host PID liveness probing; instant lock reclamation on crash** |
| **AI Request Resilience** | 429 Rate limits or upstream outage halts the entire flow | Requires complex standalone reverse proxy setups | **Built-in `Magpie` AI Gateway with heuristic error classification & circuit breakers** |
| **Resource Footprint** | - | Requires Redis, Docker, or heavy daemon stacks | **Pure native Node.js 24 + `node:sqlite` WAL; minimal memory footprint** |

---

## Key Highlights

1. **Zero-Friction Universal Protection**:
   - Install once globally on your host machine.
   - All local repositories and concurrent sessions are instantly protected without adding `.mcp.json`, modifying `.gitignore`, or bloating project rule files.
2. **Deterministic Conflict Arbiter**:
   - Supports 3-tier resource claims: `file`, `module`, and `symbol`.
   - Automatic command parsing推导 exclusive locks for `tests`, `dev-server`, and `build`.
3. **Cross-Worktree Common Root Alignment**:
   - Integrates `crewmates` Git common root resolution (`resolveGitCommonRoot`).
   - Normalizes paths relative to the shared repository root to detect cross-worktree collisions before Git commit.
4. **Resilient AI Gateway (`Magpie`)**:
   - Heuristic error categorization (`auth`, `rate_limit`, `overloaded`, `server_error`, `billing`).
   - Automatic circuit breaker cooling (`resetsIn`) and project-affinity hash routing to backup upstream models.
5. **Real-time Visual Dashboard & Standalone EXE**:
   - **War Room**: Visualizes active leases, dynamic countdowns, waiting queues, and event streams.
   - **Magpie Gateway**: Upstream node health, circuit breaker countdowns, and latency telemetry.
   - **Dual Themes**: Aozora UI (clean sky blue & white card design) and transparent Dark mode.
   - **Windows Standalone App**: Packaged standalone executable `Agent-Nexus.exe` with multi-resolution crystal tray icons.
6. **Standard MCP Support**:
   - Full JSON-RPC 2.0 stdio MCP endpoint (`nexus mcp`), offering 13 coordination and long-term memory tools.

---

## Quick Start & Verification

### Prerequisites
- Node.js 24+ (utilizing native `node:sqlite` with zero native compilation dependencies).

```bash
# Clone the repository
git clone https://github.com/xiaoran7/agent-nexus.git
cd agent-nexus

# Install runtime dependencies (ws only)
npm ci

# Start the coordination daemon
npm start

# Run comprehensive test suite (235+ tests)
npm test
```

### Desktop Tray & Windows Standalone Packaging

- **Desktop Tray App**: `npm run desktop` (launches Electron tray daemon with auto token injection).
- **Standalone Windows EXE**: `npm run package:win` (compiles multi-resolution icon assets and generates standalone `Agent-Nexus.exe` in `Deliverables/Agent-Nexus/`).

### Web Dashboard
Open `http://127.0.0.1:4300/?token=<YOUR_ADMIN_TOKEN>` in your browser.
The daemon prints a secure one-time operator token on startup.

---

## Open-Source Lineage & Architecture

Agent-Nexus proudly credits and adheres to upstream boundaries of key open-source innovations:

1. **`crewmates` ([asutekku/crewmates](https://github.com/asutekku/crewmates))**:
   - Powers Git common root detection (`resolveGitCommonRoot`), cross-worktree relative path collision checks (`toRepoRelativePath`), and named exclusive locks (`tests`, `dev-server`, `build`).
2. **`Magpie` ([magpie-ai/magpie](https://github.com/magpie-ai/magpie))**:
   - Powers the resilient AI gateway router (`src/domain/gateway-router.js`), precise failure classification (`classifyFailure`), circuit breaker backoff, and affinity hash-based failover.
3. **`agent-comm`**:
   - Powers namespaced shared state management and atomic Compare-And-Swap (CAS) (`src/domain/state.js`).

---

## Documentation

- [API Reference](docs/API.md): REST endpoints, WebSocket event contracts, and tool signatures.
- [Architecture](docs/ARCHITECTURE.md): Component decoupling, state machines, and lifecycle diagrams.
- [Hook Gatekeeper](docs/HOOKS.md): PreToolUse interception flows, payload parsing, and host setup.

---

## License

MIT © [WANGUI TANG](https://github.com/xiaoran7)
