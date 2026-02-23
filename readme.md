# NodeAnalyzer

![screenshot](assets/NodeAnalyzer_ScS01.png)

Eine funktionierende App ohne Dokumentation ist nicht nur **wertlos**, sondern ein **Risiko**.

Hier setzt NodeAnalyzer an: Ein AST / Babel basierter Analyzer für JavaScript- und TypeScript-Webanwendungen, gedacht für Entwickler oder Entwicklerteams, die eine gemeinsame Echtzeitbasis ihrer DEV - Applikation verwenden wollen.

Die Anwendung findet den Entrypoint der zu analysierenden App, erzeugt ab da einen interaktiven Abhängigkeitsgraphen und visualisiert Projektstruktur, Module, Funktionen, relevante Assets, readme-files und Funktionskommentare. Wo die Projekte liegen, ist dabei irrelevant.

Apps und deren Speicherort werden per derzeit per seat in der config definiert - und natürlich könnte man diese Konfiguration auch auf ein gemeinsam genutztes Abteilungsshare legen.

## Aktueller Funktionsumfang

- Entrypoint-basierte Analyse (kein Full-Scan nötig)
- AST-Parsing mit Babel
- Datei- und Funktionsknoten im Graph
- Import-/Include-Beziehungen
- Heuristische Erkennung von Assets (HTML, CSS, JSON, CSV etc.)
- LOC- und einfache Komplexitätsmetriken
- D3-basierte interaktive Visualisierung der **Architektur** (nicht des Laufzeitverhaltens).



## Output

Die Analyse erzeugt eine strukturierte JSON-Datei, die dann mit D3 gerendert wird:

app/public/output/code-structure.json

```json
{
  "nodes": [...],
  "links": [...]
}
```

## Start

```bash
npm install
node app/server.js
```

Im Browser öffnen (Standard: http://localhost:3003).
