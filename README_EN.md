# Agent-Nexus

> **Zero-Overhead Multi-Agent Concurrency Coordinator & Cross-Machine Context Relay for Claude Code**
> 
> [English](README_EN.md) | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/@xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/@xiaoran7/agent-nexus)
[![npm downloads](https://img.shields.io/npm/dm/@xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/@xiaoran7/agent-nexus)
[![GitHub Release](https://img.shields.io/github/v/release/xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://github.com/xiaoran7/agent-nexus/releases)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-10b981.svg?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/xiaoran7/agent-nexus.svg?style=flat-square&color=64748b)](LICENSE)

**Agent-Nexus** is a lightweight, zero-overhead coordination engine and cross-machine engineering memory hub built for concurrent Claude Code sessions. When multiple AI sessions work on the same repository, across Git Worktrees, or across multiple machines (e.g. a local Windows workstation and a remote Linux devbox), Agent-Nexus prevents **silent file overwrite collisions, test suite & port racing, Git merge disasters, and cross-machine context loss**—with zero pollution to your business repositories.

---

### Feature Matrix

| Dimension | Uncoordinated Sessions | Heavy Distributed Locks | **Agent-Nexus** |
|---|---|---|---|
| **Repo Pollution** | Zero protection; frequent file clobbering & merge conflicts | Requires repo configs or code changes | **Global hook installed once; 0 repo files, 0 `.mcp.json`, 0 `.gitignore` edits** |
| **Conflict Granularity** | Manual Git conflict resolution | Coarse repo or whole-file locks | **File (`#anchor` aware) / Module / Symbol / Named Resource (`tests`, `dev-server`, `build`)** |
| **Worktree & Multi-OS** | Blind to worktree & cross-OS paths | Unaware of Git worktrees | **Common Git root (`crewmates`) & `git_remote` fingerprint alignment across OSes** |
| **Crash Recovery** | Dead sessions leave orphaned locks | Passive waiting for long TTL expiration | **Named pipe + Host PID liveness probing; instant lease reclamation on exit** |
| **Cross-Machine Relay** | Context lost when switching machines or sessions | None | **Auto-synthesizes Handoff tickets on `git commit`/`push` & injects `additionalContext` via Hook** |
| **Resource Footprint** | - | Requires Redis or Docker | **Pure native Node.js 24 + built-in `node:sqlite` WAL** |

---

## Quick Start

### 1. Run via npx or Source

Requires Node.js 24+ (uses built-in `node:sqlite`).

```bash
# Launch central Hub and live web console
npx @xiaoran7/agent-nexus start
```

```bash
# Or run from source
npm ci
npm start
npm test
```

### 2. Background Probe & Global Hook (Recommended)

```bash
# Install auto-starting background Hub probe (port 4300)
nexus probe:install
```

```bash
# Install global PreToolUse & PostToolUse hooks into ~/.claude/settings.json
nexus hook:install
```

```bash
# Check probe status
nexus probe:status
```

### 3. Multi-Machine Hub + Edge Probe Setup

Connect remote development machines (e.g., over Tailscale) to a single central Hub without running a second database or dashboard:

```bash
# On the remote machine: bind to central Hub and install stateless Edge Probe
nexus connect --hub http://<hub-tailscale-ip>:4300 --token <operator-token> --node us-zenix
nexus hook:install
nexus probe:install --edge
```

---

## Open-Source Lineage

- **`crewmates` ([asutekku/crewmates](https://github.com/asutekku/crewmates))**: Powers Git common root detection (`resolveGitCommonRoot`), cross-worktree relative path collision checks (`toRepoRelativePath`), and named exclusive locks (`tests`, `dev-server`, `build`).

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md): Subsystems, conflict arbitration, session liveness, and cross-machine relay.
- [API Reference](docs/API.md): REST endpoints, WebSocket events, and the 7 core MCP tools.
- [Hooks Guide](docs/HOOKS.md): `PreToolUse` / `PostToolUse` interception and PowerContext injection.
- [Changelog](CHANGELOG.md): Release and engineering history.

---

## License

MIT © [WANGUI TANG](https://github.com/xiaoran7)
