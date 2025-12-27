# NodeAnalyzer

*js-dependency-graph* node app for interactive static analysis of JS/Typescript web-apps (using dependency graphs for navigation).

## Features
![screenshot](assets/logo.png)

- Entrypoint-based dependency graph
- LOC + heuristic complexity


## What it does

- Parses JavaScript / TypeScript source code
- Uses static analysis (AST-based, Babel)
- Builds dependency graphs
- Extracts file-level metrics and documentation
- Visualizes architecture & structure (not runtime behavior)

## Run
```bash
npm install
node app/server.js
```
## Tec

public/assets/metrics/code-structure.json

```json
{ "nodes": [ ... ], "links": [ ... ] }
```

will be rendered by d3.js



## Future
- external package nodes (`package:express`)
- tsconfig path alias resolution
