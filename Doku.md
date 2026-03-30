# NodeAnalyzer Dokumentation

Diese Dokumentation basiert auf dem tatsächlich vorhandenen Codebestand der App und ignoriert den Ordner `_doku` bewusst vollständig. Beschrieben wird zuerst die fachliche Sicht, danach die technische Umsetzung.

Fremdbibliotheken und generierte Artefakte sind im technischen Modulverzeichnis nicht als eigene Module geführt. Ausgenommen sind daher insbesondere `d3.v7.min.js`, `bootstrap.bundle.min.js`, `bootstrap.min.css` sowie die generierten Dateien unter den Output-Verzeichnissen.

<a id="toc-fachlich"></a>

## Fachliches Inhaltsverzeichnis

- [1. Zweck und Positionierung](#fachlich-zweck)
- [2. Zielgruppen und Nutzen](#fachlich-zielgruppen)
- [3. Fachlicher Ablauf](#fachlich-ablauf)
- [4. Fachliche Objekte und Ergebnisse](#fachlich-objekte)
- [5. Abgrenzung](#fachlich-abgrenzung)

<a id="toc-technisch"></a>

## Technisches Inhaltsverzeichnis

- [NodeAnalyzer Dokumentation](#nodeanalyzer-dokumentation)
  - [Fachliches Inhaltsverzeichnis](#fachliches-inhaltsverzeichnis)
  - [Technisches Inhaltsverzeichnis](#technisches-inhaltsverzeichnis)
  - [1. Zweck und Positionierung](#1-zweck-und-positionierung)
  - [2. Zielgruppen und Nutzen](#2-zielgruppen-und-nutzen)
  - [3. Fachlicher Ablauf](#3-fachlicher-ablauf)
  - [4. Fachliche Objekte und Ergebnisse](#4-fachliche-objekte-und-ergebnisse)
  - [5. Abgrenzung](#5-abgrenzung)
  - [6. Systemkontext und Laufzeitbild](#6-systemkontext-und-laufzeitbild)
  - [7. Komponentenübersicht](#7-komponentenübersicht)
  - [8. HTTP-Schnittstellen](#8-http-schnittstellen)
    - [Wichtige Response-Eigenschaften](#wichtige-response-eigenschaften)
  - [9. Analyse-Pipeline und Datenfluss](#9-analyse-pipeline-und-datenfluss)
    - [Detailfluss pro Schicht](#detailfluss-pro-schicht)
    - [Graph-Modell](#graph-modell)
  - [10. Artefakte, Datenformate und Speicherorte](#10-artefakte-datenformate-und-speicherorte)
    - [Datenformate](#datenformate)
    - [Betriebsrelevante Hinweise](#betriebsrelevante-hinweise)
  - [11. Modul-TOC](#11-modul-toc)
    - [11.1 Backend Bootstrap und Konfiguration](#111-backend-bootstrap-und-konfiguration)
    - [11.2 HTTP-Routen](#112-http-routen)
    - [11.3 Backend Analysekern](#113-backend-analysekern)
    - [11.4 Frontend Shell und Zusatzansichten](#114-frontend-shell-und-zusatzansichten)
    - [11.5 CodeGraph Renderer](#115-codegraph-renderer)
    - [11.6 Styles und Inhaltsassets](#116-styles-und-inhaltsassets)
  - [12. Technische Besonderheiten und aktueller Stand](#12-technische-besonderheiten-und-aktueller-stand)
    - [Technisches Fazit](#technisches-fazit)
  - [addon](#addon)
  - [Farbzuordnung Daten](#farbzuordnung-daten)
  - [Edgebreite](#edgebreite)

---

<a id="fachlich-zweck"></a>

## 1. Zweck und Positionierung

NodeAnalyzer ist ein webbasiertes Werkzeug zur **statischen Struktur- und Architektur-Analyse** von JavaScript-/TypeScript-Projekten. Die App analysiert ein konfiguriertes Zielsystem über dessen Entrypoint, leitet daraus Abhängigkeiten, Funktionsknoten, Strukturknoten und ergänzende Artefakte ab und stellt das Ergebnis interaktiv dar.

Fachlich verfolgt die Anwendung vier Kernziele:

| Ziel | Beschreibung | Technische Umsetzung |
|---|---|---|
| Architektur sichtbar machen | Reale Abhängigkeiten sollen sichtbar werden, nicht nur angenommene Architektur. | Siehe [Analyse-Pipeline und Datenfluss](#technisch-pipeline) |
| Risiken sichtbar machen | Komplexe, volatile oder stark gekoppelte Bereiche sollen auffallen. | Siehe [Hotspot-Anreicherung](#technisch-besonderheiten) |
| Orientierung beschleunigen | Entwickler sollen schneller verstehen, welche Dateien, Funktionen und Readmes zusammengehören. | Siehe [HTTP-Schnittstellen](#technisch-schnittstellen) und [CodeGraph Renderer](#modul-codegraph) |
| Historie nutzbar machen | Veränderungen im Zeitverlauf sollen über gespeicherte CSV-Snapshots sichtbar werden. | Siehe [Artefakte, Datenformate und Speicherorte](#technisch-artefakte) |

Die App ist damit kein Ersatz für Quellcode, IDE oder klassische Dokumentation, sondern ein **strukturorientiertes Analyse- und Navigationswerkzeug**.

<a id="fachlich-zielgruppen"></a>

## 2. Zielgruppen und Nutzen

| Zielgruppe | Fachlicher Nutzen | Typische Fragestellungen |
|---|---|---|
| Entwickler | Schnellere Orientierung im Bestandscode | Wo liegt der echte Einstieg? Welche Module hängen zusammen? |
| Tech Lead / Architekt | Bessere Grundlage für Refactoring und Risikoabschätzung | Wo sind Hotspots? Welche Bereiche sind zentral gekoppelt? |
| Projektverantwortliche | Gemeinsames Architekturverständnis im Team | Welche Teile der App sind stark gewachsen? Wo fehlen Doku-Anker? |
| Neue Teammitglieder | Beschleunigtes Onboarding | Welche Dateien sind zentral? Welche Readmes erklären Teilbereiche? |

Besonders nützlich ist NodeAnalyzer bei:

- gewachsenen Codebasen mit unklarer Modulstruktur
- Vorhaben mit größerem Refactoring-Anteil
- Architekturgesprächen, in denen reale Abhängigkeiten benötigt werden
- Projekten, bei denen Dokumentation und Quellrealität regelmäßig auseinanderlaufen

<a id="fachlich-ablauf"></a>

## 3. Fachlicher Ablauf

Der fachliche Prozess der App sieht aus Anwendersicht wie folgt aus:

| Schritt | Fachliche Sicht | Ergebnis | Technische Verknüpfung |
|---|---|---|---|
| 1 | Eine Ziel-App wird aus einer konfigurierten Liste ausgewählt. | Analysekontext steht fest. | Siehe [`/apps`](#technisch-schnittstellen) und [Frontend Shell](#modul-frontend-shell) |
| 2 | Die Analyse wird gestartet. | Ein neuer Lauf erzeugt Graph- und CSV-Artefakte. | Siehe [`/analyze`](#technisch-schnittstellen) |
| 3 | Die Struktur des Zielsystems wird aufgelöst. | Dateien, Verzeichnisse, Funktionen und Kanten entstehen. | Siehe [Analyse-Pipeline und Datenfluss](#technisch-pipeline) |
| 4 | Das Ergebnis wird visuell erkundet. | Standard-Graph, MRI-View und Time-View werden nutzbar. | Siehe [CodeGraph Renderer](#modul-codegraph) |
| 5 | Zu Knoten werden Zusatzinformationen geladen. | README-Inhalte, Header-Kommentare und Knotendetails werden sichtbar. | Siehe [`/readme`](#technisch-schnittstellen) |
| 6 | Änderungen im Dateisystem werden verfolgt. | Bereits geöffnete Graphen markieren betroffene Knoten live. | Siehe [`/events`](#technisch-schnittstellen) |

Fachlich wichtig ist dabei: Die App analysiert immer **den Zustand des Quellbestands**, nicht das Laufzeitverhalten des Systems.

<a id="fachlich-objekte"></a>

## 4. Fachliche Objekte und Ergebnisse

| Fachliches Objekt | Bedeutung | Entsteht aus |
|---|---|---|
| Ziel-App | Ein analysierbares Projekt mit `id`, `name`, `rootDir`, `entry`, optional `url` | `app/config/apps.json` |
| Analyse-Lauf | Eine konkrete Ausführung für genau eine Ziel-App | `POST /analyze` |
| Graph-Knoten | Dateien, Verzeichnisse, Funktionen, Assets, Dokumente | Parser-, Scan- und Klassifikationslogik |
| Graph-Kanten | Beziehungen wie `include`, `use`, `call` | Importauflösung, Strukturscan, Funktionsaufrufe |
| Hotspot | Fachlich auffälliger Bereich mit hoher Änderungsfrequenz und Komplexität | Git-Historie + Metrikgewichtung |
| README-Kontext | Nächstgelegene Doku zu einem gewählten Knoten | README-Suche im Zielsystem |
| Verlaufsdaten | Historische CSV-Snapshots für Trend- und Drift-Sicht | gespeicherte Output-Dateien |

Die wichtigsten fachlichen Ergebnisse sind:

- ein interaktives Architekturmodell des analysierten Systems
- ein strukturell angereichertes Navigationsbild bis auf Funktionsniveau
- historische Metrik-Snapshots für Zeitverlauf und Drift
- dokumentationsnahe Zusatzinformationen aus README-Dateien und Dateikommentaren

<a id="fachlich-abgrenzung"></a>

## 5. Abgrenzung

NodeAnalyzer arbeitet bewusst innerhalb klarer Grenzen:

| Thema | Verhalten |
|---|---|
| Analyseart | statisch, keine Runtime- oder Tracing-Analyse |
| Zielsysteme | konfiguriert über `apps.json`, kein freies Ad-hoc-Browsing durch beliebige Pfade |
| Importauflösung | konservativ und projektintern, keine vollständige Package- oder Runtime-Auflösung |
| Fokus | Struktur, Abhängigkeiten, Funktionen, Artefakte, Hotspots |
| Nicht-Ziel | vollständige semantische Programmanalyse oder Build-/Deployment-Orchestrierung |

Die fachliche Abgrenzung spiegelt sich direkt in der technischen Architektur wider, insbesondere in [resolveImports.js](#modul-backend-kern), [buildMetricsFromEntrypoint.js](#modul-backend-kern) und den [HTTP-Schnittstellen](#technisch-schnittstellen).

---

<a id="technisch-systemkontext"></a>

## 6. Systemkontext und Laufzeitbild

NodeAnalyzer ist eine klassische Node-/Express-Webanwendung mit lokaler Analyse-Engine und browserseitiger D3-Visualisierung.

```text
Browser UI
  -> GET /apps
  -> POST /analyze
  -> GET /output/<artefakt>
  -> GET /readme
  -> GET /api/output-files
  -> GET /events (SSE)

Express Server
  -> Routen / API
  -> Analyse-Engine
  -> Git-Historienauswertung
  -> Artefaktpersistenz
  -> Dateisystem-Watcher

Analysiertes Zielprojekt
  -> rootDir aus apps.json
  -> entry aus apps.json
  -> Quellcode, Assets, Readmes
```

Laufzeitlich gibt es drei zentrale Betriebsachsen:

| Achse | Beschreibung |
|---|---|
| Analyse | Ein Entrypoint-gesteuerter BFS-Lauf erzeugt den kanonischen Graphen. |
| Visualisierung | Die UI lädt das Ergebnis-JSON und rendert daraus interaktive Graphen. |
| Live-Betrieb | Ein SSE-Kanal und ein Dateisystem-Watcher markieren Änderungen während einer aktiven Analyse. |

<a id="technisch-komponenten"></a>

## 7. Komponentenübersicht

| Komponente | Verantwortung | Wichtige Dateien |
|---|---|---|
| Server-Bootstrap | Express starten, statische Inhalte und Routen verdrahten | `app/server.js`, `app/config/config.js` |
| App-Registry | Konfigurierte Analyseziele verwalten | `app/config/apps.json`, `app/lib/appsRegistry.js`, `app/routes/apps.js` |
| Analyse-Routen | Analyse, README-Auflösung, Output-Dateien, Help-Endpunkt | `app/routes/*.js` |
| Analysekern | Strukturscan, Parser, Importauflösung, Graphaufbau, Klassifikation | `app/lib/buildMetricsFromEntrypoint.js` und Hilfsmodule |
| Hotspot- und Artefaktlogik | Git-basierte Hotspots, JSON/CSV-Ausgabe | `app/routes/analyze.js`, `app/lib/analyze/*.js` |
| Live-Change-Feed | SSE-Clientverwaltung und Chokidar-Watcher | `app/lib/liveChangeFeed.js` |
| Frontend-Steuerung | App-Auswahl, Analyse-Start, Panel-Logik, SSE-Verarbeitung | `app/public/assets/js/app.js` |
| Graph-Rendering | Standardgraph, Filter, Tooltips, Repaint, Force-Layout | `app/public/assets/js/d3_codeStructure.js`, `app/public/assets/js/codeGraph/*.js` |
| Zusatzansichten | MRI-Sicht und Time-View | `graph_mriView.js`, `graph_timeView.js` |

<a id="technisch-schnittstellen"></a>

## 8. HTTP-Schnittstellen

| Methode / Pfad | Zweck | Eingaben | Antwort / Wirkung |
|---|---|---|---|
| `GET /apps` | Konfigurierte Ziel-Apps für die UI laden | keine | `{ apps: [...] }` |
| `POST /analyze` | Analyse eines konfigurierten Projekts starten | Body mit `appId`, optional `maxDirDepth` | Run-Metadaten, URLs auf JSON/CSV-Artefakte |
| `GET /readme?appId=...&file=...` | Nächstgelegene README zu Datei oder Verzeichnis liefern | `appId`, `file` | `{ found, readmePath, markdown }` |
| `GET /help` | Help-Markdown der Analyzer-App liefern | keine | `{ found, helpPath, markdown }` |
| `GET /api/output-files?appId=...&type=code-metrics` | Historische CSV-Dateien der Ziel-App auflisten | `appId`, optional `type` | `string[]` |
| `GET /events` | Server-Sent Events für Live-Änderungen | keine | Stream mit `hello`, `analysis`, `fs-change`, `fs-watch-error` |
| `GET /output/<datei>` | Persistierte Analyseartefakte ausliefern | Dateiname | JSON- oder CSV-Dateien aus dem Output-Verzeichnis |


### Wichtige Response-Eigenschaften

| Thema | Beschreibung |
|---|---|
| `metricsUrl` | URL zur kanonischen JSON-Datei des Laufs |
| `csvUrl` | URL zur CSV-Datei des Laufs |
| `summary.nodes / summary.links` | Kompakte Laufzusammenfassung |
| `analysisStatus: "unsupported"` | Signalisiert fachlich/technisch nicht unterstützte Ziele |
| `runToken` | Dient zur Entkopplung alter und neuer Live-Events |

<a id="technisch-pipeline"></a>

## 9. Analyse-Pipeline und Datenfluss

Die Kernpipeline verläuft in der aktuellen Implementierung so:

```text
UI wählt App
  -> POST /analyze
  -> appsRegistry löst rootDir + entry auf
  -> buildMetricsFromEntrypoint() startet
  -> scanProjectTree() baut Struktur-Skelett
  -> parseFile() / parseJsTsAst() extrahieren Funktionen, Imports, Calls
  -> resolveImports() löst interne Importe auf
  -> autoMode erweitert indirekt referenzierte Dateien/Ordner
  -> GraphStore dedupliziert Nodes und Links
  -> graphFinalize berechnet abgeleitete Metriken
  -> analyze.js ergänzt Hotspots über Git-Historie
  -> artifacts.js schreibt JSON/CSV
  -> liveChangeFeed aktiviert Watcher + SSE-Kontext
  -> UI lädt metricsUrl und rendert Standard-, MRI- und Time-View
```

### Detailfluss pro Schicht

| Schicht | Aufgabe | Relevante Module |
|---|---|---|
| Zielauflösung | `appId` in echtes Projektwurzel- und Entrypoint-Paar überführen | `app/routes/analyze.js`, `app/lib/appsRegistry.js` |
| Strukturscan | Dateien und Verzeichnisse bis zur konfigurierten Tiefe erfassen | `app/lib/scanProjectTree.js` |
| Parsing | JS/TS-Funktionen, Imports, Calls und Header-Kommentare lesen | `app/lib/parseFile.js`, `app/lib/parseAst.js` |
| Referenzauflösung | Relative und projektinterne Imports auflösen | `app/lib/resolveImports.js`, `app/lib/fsPaths.js` |
| Graphaufbau | Knoten/Kanten erstellen, deduplizieren und anreichern | `app/lib/buildMetricsFromEntrypoint.js`, `app/lib/graphStore.js` |
| Klassifikation | `group`, `layer`, `type`, `subtype` deterministisch setzen | `app/lib/nodeClassification.js` |
| Finalisierung | In-/Out-Degrees, Call-Statistiken, Wichtigkeit, Depth setzen | `app/lib/graph/graphFinalize.js` |
| Hotspots | Commit-Frequenz, LOC und Komplexität gewichten | `app/routes/analyze.js` |
| Persistenz | JSON- und CSV-Artefakte schreiben | `app/lib/analyze/artifacts.js`, `app/lib/analyze/csvExport.js` |
| Laufender Betrieb | Aktive Analyse beobachten und Events streamen | `app/lib/liveChangeFeed.js` |

### Graph-Modell

| Element | Typischer Inhalt |
|---|---|
| `meta` | Entrypoint, App-Metadaten, Layer-Reihenfolge, Warnungen, Hotspot-Modell |
| `nodes` | `root`, `dir`, `file`, `asset`, `function` |
| `links` | `include`, `use`, `call` |
| abgeleitete Felder | `_inbound`, `_outbound`, `_importance`, `_unused`, `_hotspotScore`, `_changeFreq` |

Die UI verwendet dieses Modell direkt weiter. Die Architekturentscheidung lautet hier klar: **semantische Ableitungen werden überwiegend im Backend vorgenommen, das Frontend rendert vor allem**.

<a id="technisch-artefakte"></a>

## 10. Artefakte, Datenformate und Speicherorte

| Artefakt | Zweck | Typischer Speicherort | Primär genutzt von |
|---|---|---|---|
| Metrics-JSON | Kanonischer Graph eines Analyse-Laufs | `app/public/output/<app>-<timestamp>-code-metrics.json` | Standardgraph |
| Metrics-CSV | CSV-Abbild desselben Laufs | `app/public/output/<app>-<timestamp>-code-metrics.csv` | Export, MRI-View, Time-View |
| Zusätzliche CSV-Side-Artefakte | Parallel geschriebene modulbezogene CSV-Snapshots aus dem Graph-Builder | aktuell zusätzlich unter `public/output/*.csv` | derzeit kein eigener Haupt-API-Pfad |
| Apps-Konfiguration | Analyseziele mit Root und Entry | `app/config/apps.json` | Backend und UI |
| Help-/README-Markdown | Hilfe und Kontextdokumentation | `app/public/readme.md` bzw. Readmes im Zielprojekt | Seitenpanel / Help-Logik |


### Datenformate

| Format | Inhalt |
|---|---|
| JSON | vollständige Graphstruktur mit Nodes, Links und Metadaten |
| CSV | flache Zeilenform für Knoten- und Linkdaten oder modulbezogene Verlaufsmetriken |
| Markdown | Hilfe- und README-Inhalte für UI-Kontext |

### Betriebsrelevante Hinweise

- Der **kanonische Output-Pfad** des Servers ist `app/public/output`.
- Die Zusatzansichten `MRI` und `Time view` lesen ihre CSV-Dateien über `/api/output-files` und `/output/<datei>` aus diesem kanonischen Pfad.
- Zusätzlich schreibt `buildMetricsFromEntrypoint.js` aktuell nicht-fatal weitere CSV-Snapshots nach `public/output`; dieser Pfad ist im Ist-Zustand parallel vorhanden.

<a id="technisch-module"></a>

## 11. Modul-TOC

Dieses Verzeichnis deckt die internen, laufzeitrelevanten Dateien der App außerhalb von `_doku` ab. Die Beschreibung ist bewusst knapp und auf Verantwortung sowie Einordnung fokussiert.

<a id="modul-backend-bootstrap"></a>

### 11.1 Backend Bootstrap und Konfiguration

| Modul | Verantwortung |
|---|---|
| `app/server.js` | Startpunkt des Express-Servers; verdrahtet Routen, statische Verzeichnisse, Output-Freigabe und SSE-Endpunkt. |
| `app/config/config.js` | Zentralisiert Port, Project Root, Public Root und Output Root. |
| `app/config/apps.json` | Fachliche Registry aller analysierbaren Zielsysteme mit `id`, `rootDir`, `entry` und optional `url`. |

<a id="modul-routes"></a>

### 11.2 HTTP-Routen

| Modul | Verantwortung |
|---|---|
| `app/routes/analyze.js` | Haupt-API zum Starten einer Analyse; validiert Ziele, berechnet Hotspots, schreibt Artefakte und aktiviert Live-Überwachung. |
| `app/routes/apps.js` | Liefert die App-Auswahl für die UI aus `apps.json`. |
| `app/routes/help.js` | Liefert die Analyzer-eigene Hilfe aus `app/public/readme.md`. |
| `app/routes/output.js` | Listet historische Output-Dateien je App und Typ, vor allem für die Time-View. |
| `app/routes/readme.js` | Sucht die nächstgelegene README-Datei innerhalb des Zielprojekts und schützt dabei die Root-Grenzen. |
| `app/routes/readme.md` | Begleitdokument zu den Routen; kein Runtime-Modul, aber Teil der in-repo-Dokumentation. |

<a id="modul-backend-kern"></a>

### 11.3 Backend Analysekern

| Modul | Verantwortung |
|---|---|
| `app/lib/appsRegistry.js` | Lädt, validiert und durchsucht die App-Registry; löst `rootDir` und `entry` auf. |
| `app/lib/autoMode.js` | Ergänzt indirekt referenzierte Dateien, Assets und Verzeichnisse, die nicht über normale Imports sichtbar würden. |
| `app/lib/buildMetricsFromEntrypoint.js` | Orchestriert den gesamten Analysegraphen ab Entrypoint inklusive Scan, Parsing, Call-/Use-Kanten und Finalisierung. |
| `app/lib/fsPaths.js` | Stellt normierte Pfad- und Root-Boundary-Helfer bereit. |
| `app/lib/graphStore.js` | Deduplizierender In-Memory-Speicher für Knoten und Kanten. |
| `app/lib/liveChangeFeed.js` | Verwaltet SSE-Clients, aktiven Analysekontext und den Chokidar-Watcher. |
| `app/lib/nodeClassification.js` | Leitet `group`, `layer`, `ext`, `type` und `subtype` deterministisch aus Knoten ab. |
| `app/lib/parseAst.js` | AST-basierte JS/TS-Extraktion mit Babel; erkennt Imports, Funktionen, Aufrufe und Komplexität. |
| `app/lib/parseFile.js` | Stabile Parser-Fassade, die nie werfen soll und immer eine konsistente Ergebnisstruktur liefert. |
| `app/lib/projectPaths.js` | Stellt `APP_ROOT`, `PUBLIC_DIR` und `OUTPUT_DIR` für Backend-Teile bereit. |
| `app/lib/requestNormalization.js` | Leeres Platzhaltermodul für künftige Request-Normalisierung. |
| `app/lib/resolveImports.js` | Löst konservativ projektinterne Import-Spezifikatoren zu existierenden Dateien auf. |
| `app/lib/scanProjectTree.js` | Traversiert Verzeichnisstrukturen deterministisch und mit Begrenzungen. |
| `app/lib/stringUtils.js` | Kleine Helfer für String- und Identifier-Normalisierung. |
| `app/lib/README.md` | Interne Doku zum Analysekern; kein Runtime-Modul, aber fachlich-technische Orientierung im Repo. |
| `app/lib/graph/graphFinalize.js` | Berechnet abgeleitete Graphmetriken wie Degree, Importance, Tiefe und Caller/Callee-Listen. |
| `app/lib/analyze/analyzeService.js` | Leeres Platzhaltermodul für einen möglichen Service-Layer rund um Analyseabläufe. |
| `app/lib/analyze/artifacts.js` | Schreibt JSON- und CSV-Artefakte und erzeugt konsistente Dateinamen/URLs. |
| `app/lib/analyze/csvExport.js` | Serialisiert Graphdaten in CSV-Strukturen. |

<a id="modul-frontend-shell"></a>

### 11.4 Frontend Shell und Zusatzansichten

| Modul | Verantwortung |
|---|---|
| `app/public/index.html` | Grundlayout der Oberfläche mit App-Auswahl, Standardgraph, MRI-/Time-Tabs und Seitenpanels. |
| `app/public/assets/js/main.js` | Schlanker ESM-Einstiegspunkt, der die UI-Module lädt. |
| `app/public/assets/js/app.js` | Browserseitiger Orchestrator für App-Auswahl, Analyze-Trigger, Panelpflege, README-Laden, SSE und Zusatzcharts. |
| `app/public/assets/js/graph_timeView.js` | Historische Zeitreihenansicht auf Basis gespeicherter `code-metrics.csv`-Dateien. |
| `app/public/assets/js/graph_mriView.js` | Zusatzvisualisierung auf Basis des neuesten CSV-Snapshots, fokussiert auf Modulgröße, Fan-Out und Hotspots. |

<a id="modul-codegraph"></a>

### 11.5 CodeGraph Renderer

| Modul | Verantwortung |
|---|---|
| `app/public/assets/js/d3_codeStructure.js` | Haupt-Renderer des Standardgraphen; koordiniert Daten-Normalisierung, Simulation, Rendering, Interaktionen und Repaint. |
| `app/public/assets/js/codeGraph/data.js` | Normalisiert Backend-Metriken für die D3-Schicht und ergänzt UI-freundliche Hilfsfelder. |
| `app/public/assets/js/codeGraph/interactions.js` | Kapselt Drag-, Click- und Highlight-Verhalten der Knoten. |
| `app/public/assets/js/codeGraph/render.encoders.js` | Leitet Farben, Radien, Stroke-Breiten und Edge-Darstellung aus Knoteneigenschaften ab. |
| `app/public/assets/js/codeGraph/render.hulls.js` | Rendert Cluster-Hüllen mit Dichte- und Sichtbarkeitslogik. |
| `app/public/assets/js/codeGraph/render.repaint.js` | Aktualisiert Styles bei Änderungen ohne Voll-Render, etwa für Change-Marker oder Hotspot-Badges. |
| `app/public/assets/js/codeGraph/render.simulation.js` | Baut das D3-Force-Layout und dessen Parameterisierung auf. |
| `app/public/assets/js/codeGraph/render.tooltip.js` | Erzeugt den inhaltlichen HTML-Body der Tooltips. |
| `app/public/assets/js/codeGraph/ui.diagnostics.js` | Kleine Dev-Helfer für Renderer-Abhängigkeitsprüfungen und optionale Diagnostik. |
| `app/public/assets/js/codeGraph/ui.filters.js` | Dünne Orchestrierung zwischen Filter-Panel, Selections und Renderer-Kontext. |
| `app/public/assets/js/codeGraph/ui.js` | Hält Filterzustand pro Graph und stellt zentrale UI-Hooks für Header und Filter bereit. |
| `app/public/assets/js/codeGraph/ui.panel.js` | Baut das eigentliche Legend-/Filter-Panel-Markup und dessen lokale Interaktionen auf. |
| `app/public/assets/js/codeGraph/ui.tooltip.js` | Reine DOM-Helfer für Tooltip-Erzeugung, Positionierung und Sichtbarkeit. |

<a id="modul-style-assets"></a>

### 11.6 Styles und Inhaltsassets

| Modul | Verantwortung |
|---|---|
| `app/public/assets/css/style.css` | Seitenlayout, Panels, App-Liste und allgemeine UI-Stile. |
| `app/public/assets/css/graph.css` | Farb- und Darstellungsregeln des Graphen, inklusive Hotspot- und Kanten-Tokens. |
| `app/public/readme.md` | Aktueller Inhalt der Help-Datei; wird serverseitig über `/help` bzw. teilweise über `/readme` ausgeliefert. |

<a id="technisch-besonderheiten"></a>

## 12. Technische Besonderheiten und aktueller Stand

| Thema | Aktueller Stand |
|---|---|
| Hotspot-Modell | Die Hotspot-Berechnung erfolgt in `app/routes/analyze.js` aus Git-Commit-Frequenz, Komplexität und LOC und ist als „CodeScene-like“ dokumentiert. |
| Live-Analyse | Es gibt immer genau einen aktiven Analysekontext mit genau einem Watcher; mehrere SSE-Clients sind möglich. |
| README-Kontext | Die README-Suche ist root-sicher und arbeitet relativ zur ausgewählten Ziel-App. |
| Help-Funktion | Route und Help-Panel-Markup sind vorhanden, die aktive Verdrahtung der Help-UI in `app.js` ist derzeit jedoch nicht implementiert. |
| Restart-Funktion | Die UI versucht mehrere Restart-Endpunkte, im vorliegenden Backend existieren dafür jedoch keine eigenen Routen. |
| Output-Pfade | Der Server arbeitet mit `app/public/output`, zusätzlich werden modulbezogene CSVs derzeit auch nach `public/output` geschrieben. |
| Platzhaltermodule | `app/lib/requestNormalization.js` und `app/lib/analyze/analyzeService.js` sind derzeit leer und markieren Ausbaupunkte. |
| UI-Platzhalter | In `index.html` existieren weitere vorbereitete Flächen wie Recommendations-Panel und zusätzliche Graph-Panes, die aktuell nicht vollständig verdrahtet sind. |

### Technisches Fazit

Die App ist architektonisch klar aufgeteilt in:

1. eine **konfigurationsgesteuerte Analyse-Schicht**,
2. einen **kanonischen Graph- und Artefaktpfad im Backend**,
3. eine **vergleichsweise dünne, aber modulare Frontend-Visualisierung**.

Besonders stark ist die Lösung dort, wo statische Struktur, README-Kontext, Git-Historie und Live-Dateisystemereignisse zu einem gemeinsamen Navigationsbild verbunden werden. Ausbaupotenzial liegt vor allem in der Konsolidierung einzelner Output- und UI-Platzhalterpfade.




## addon

## Farbzuordnung Daten
Aktuell gilt im Backend diese Zuordnung über Dateiendungen:

doc → türkis: .md, .txt, siehe nodeClassification.js (line 48) und nodeClassification.js (line 66)
data → orange: .json, .jsonc, .csv, .tsv, .yml, .yaml, .sql, .env, siehe nodeClassification.js (line 49) und nodeClassification.js (line 67)
image → violett: .png, .jpg, .jpeg, .gif, .svg, .webp, .ico, siehe nodeClassification.js (line 50) und nodeClassification.js (line 68)
Diese Gruppe wird dem Node beim Normalisieren gesetzt, siehe nodeClassification.js (line 307). Im Renderer wird dann für die Kante auf den target-Node geschaut: Wenn dessen group doc|data|image ist, bekommt die Edge die entsprechende Resource-Farbe. Wenn stattdessen nur kind === "asset" oder type === "asset" vorliegt, fällt sie auf die generische Asset-Farbe zurück, siehe render.encoders.js (line 176) und render.encoders.js (line 186). Die aktuellen Farben selbst stehen in render.encoders.js (line 77).
## Edgebreite
Die Breite der Edge hängt vom numerischen Gewicht ab. Dafür werden der Reihe nach _weight, weight, count, value, strength, calls, uses gelesen; wenn nichts da ist, fällt es auf 1 zurück, siehe render.encoders.js (line 505). Dieses Gewicht wird logarithmisch mit Referenz 12 normalisiert, siehe render.encoders.js (line 483). Für Resource-Edges liegt die sichtbare Breite dann nur zwischen 0.4 und 1, siehe render.encoders.js (line 86) und render.encoders.js (line 667). Für normale Edges liegt sie zwischen 1 und 4; _changed-Edges werden direkt auf 4 gesetzt, siehe render.encoders.js (line 83) und render.encoders.js (line 677).

Praktisch heißt das: code-metrics.csv ist bei dir data und müsste deshalb orange gerendert werden.





