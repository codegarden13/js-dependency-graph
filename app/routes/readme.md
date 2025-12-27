# Routes

This directory contains all HTTP route handlers exposed by **NodeAnalyzer**.
Each file defines a focused Express router responsible for a single concern.

The routes are intentionally thin: they validate input, delegate work to `/lib`,
and shape responses for the frontend. No heavy analysis logic lives here.

---

## Overview

| File        | Endpoint(s)        | Responsibility |
|------------|-------------------|----------------|
| `analyze.js` | `POST /analyze`   | Trigger static analysis and persist results |
| `apps.js`   | `GET /apps`       | Provide configured applications for selection |
| `readme.js` | `GET /readme`     | Resolve and return nearest `README.md` content |

---

## `analyze.js`

**Purpose**  
Entry point for running a static analysis on a Node (and later PHP) application.

**Responsibilities**
- Validate request payload
- Resolve and validate entrypoint paths
- Optionally probe a running application URL
- Invoke the analysis pipeline in `/lib`
- Persist the generated graph data for frontend consumption

**Request**
```json
POST /analyze
{
  "entryPath": "app/server.js",   // optional
  "appUrl": "http://localhost:3000" // optional
}