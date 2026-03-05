// public/assets/js/main.js
// ---------------------------------------------------------------------------
// Single ESM entry point for the browser UI.
//
// - We keep D3/Bootstrap/marked/DOMPurify as global scripts (loaded in HTML).
// - Everything else is pure ESM with explicit imports/exports.
// - No window namespace “bridge” is used.
// ---------------------------------------------------------------------------

import "./d3_codeStructure.js";
import "./app.js";
