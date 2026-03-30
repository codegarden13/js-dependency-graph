# NodeAnalyzer - my personal code design UI.

Interactive architecture and dependency visualization for complex JavaScript and TypeScript systems.

<video src="assets/NodeTimeline.mp4" controls width="700" title="NodeAnalyzer Timeline (startup)"></video>

If a codebase grows for years, structure gets blurry. Dependencies spread, complexity hides in corners, and refactoring turns into guesswork.

NodeAnalyzer makes the static structure visible again, so you can decide with data instead of intuition.

---
⚠️ *This project has moved to a commercial model. The version on GitHub is a limited / legacy version.*

![screenshot](assets/screenshot01.png)
---

## Why

If you lead a team, inherit an older codebase, or want a clearer picture of your own project, this helps you:

- see the real dependency structure instead of the assumed one
- spot hotspots, complexity clusters and risky modules
- support onboarding and refactoring with actual structure data
- connect code, assets and README context in one view

## What it does

NodeAnalyzer starts from an entrypoint and builds an interactive graph of:

- files and functions
- imports and dependencies
- assets like HTML, CSS, JSON, CSV and images
- README files in folders
- basic metrics like LOC and complexity

It focuses on static structure, not runtime behavior.

It does not replace documentation. It supports it by showing structural reality.

It also does not replace your existing tools. I use it to adapt ideas from paid tools like CodeScene to my own workflow and NodeAnalyzer learning journey.

## Typical use

- **Dev Lead / You:** Get a live picture of the current state of your projects and see where the urgent technical work sits.
- **CTO / Tech Lead:** Check where complexity, coupling and hotspots make changes risky before a bigger feature or refactor starts.

## Projects

Targets are configured centrally in [app/config/apps.json](/Users/thomassalomon/Library/Mobile%20Documents/com~apple~CloudDocs/Documents/_OFFICE/Projects-GIT/25-12-16%20NodeAnalyzer/app/config/apps.json).

Each app usually defines:

- `id`
- `name`
- `rootDir`
- `entry`
- `url`

## Output

Analysis artifacts are written to [app/public/output](/Users/thomassalomon/Library/Mobile%20Documents/com~apple~CloudDocs/Documents/_OFFICE/Projects-GIT/25-12-16%20NodeAnalyzer/app/public/output).

The current graph model is exported as JSON and can be reused for further processing.

## Start

Requirements:

- Node.js 18+
- npm

```bash
npm install
node app/server.js
```

Open:

```text
http://localhost:3003
```
