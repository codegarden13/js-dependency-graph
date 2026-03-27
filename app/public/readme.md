# NodeAnalyzer Benutzeranleitung

NodeAnalyzer ist ein Werkzeug zur **statischen Analyse von JavaScript- und TypeScript-Projekten**. Die App erzeugt aus einem konfigurierten Entrypoint einen Architekturgraphen, ergänzt ihn um Struktur- und Hotspot-Informationen und stellt das Ergebnis in mehreren Ansichten dar.

## Wofür die App gedacht ist

NodeAnalyzer hilft dabei,

- den Einstieg in ein unbekanntes Projekt zu finden,
- Modul- und Dateistrukturen sichtbar zu machen,
- Funktions- und Abhängigkeitsbeziehungen zu erkennen,
- problematische oder volatile Bereiche schneller zu identifizieren,
- Readmes und Quellstruktur gemeinsam zu betrachten.

Die App analysiert **statisch den Quellbestand**. Sie zeigt also die Struktur des Codes, nicht das Laufzeitverhalten einer Anwendung.

---

## Schnellstart

1. Starte NodeAnalyzer lokal.
2. Öffne die Oberfläche im Browser.
3. Wähle links oben eine konfigurierte App aus.
4. Die Analyse wird gestartet und der Standardgraph geladen.
5. Klicke auf Knoten im Graphen, um Details und passende README-Inhalte zu sehen.

## Voraussetzungen

Damit die App sinnvoll arbeitet, braucht sie:

- eine konfigurierte Ziel-App in `app/config/apps.json`
- ein gültiges `rootDir`
- einen gültigen `entry`
- lesbaren Quellcode im Zielprojekt

Für Hotspot-Informationen sollte das Zielprojekt zusätzlich in einem Git-Repository liegen.

---

## Oberfläche im Überblick

| Bereich | Inhalt | Zweck |
|---|---|---|
| Links | README, Selection, Recommendations | Kontext zum aktuell gewählten Knoten |
| Mitte oben | App-Auswahl | Zielprojekt auswählen |
| Mitte | Graph-Tabs | Standard graph, MRI, Time view |
| Rechts | Legend & Filter | Knotengruppen, Kantenarten und Sichtbarkeitsregeln steuern |
| Kopfzeile | Status | Fortschritt, Fehler und Analyseergebnis |

### App-Auswahl

Für jede konfigurierte App werden Name, Entrypoint und URL angezeigt.

- `Show` öffnet die konfigurierte Ziel-URL im Browser.
- `Restart` versucht definierte Restart-Endpunkte der Ziel-App. Das funktioniert nur, wenn die Zielumgebung solche Endpunkte tatsächlich bereitstellt.

---

## Typischer Arbeitsablauf

### 1. App auswählen

Wähle in der App-Liste das gewünschte Projekt aus. Die Auswahl wird in der Oberfläche gehalten und ist die Basis für alle weiteren Aktionen.

### 2. Analyse ausführen

Nach der Auswahl startet NodeAnalyzer die Analyse des konfigurierten Entrypoints. Das Ergebnis wird als Graph geladen und zusätzlich als JSON- und CSV-Artefakt gespeichert.

### 3. Graph lesen

Der Standardgraph zeigt die Struktur des Projekts als Netz aus Knoten und Kanten. Dort kannst du:

- hineinzoomen und herauszoomen,
- den Graphen verschieben,
- Knoten ziehen,
- einzelne Knoten anklicken.

### 4. Knotendetails prüfen

Nach einem Klick auf einen Knoten werden links Informationen angezeigt:

- Dateiname oder Funktionsname,
- technische Basisdaten wie Typ, Größe oder Komplexität,
- der passende README-Kontext aus dem Zielprojekt, sofern vorhanden.

### 5. Zusatzansichten nutzen

- **MRI** zeigt die aktuelle strukturelle Belastung einzelner Module.
- **Time view** zeigt Veränderungen über mehrere gespeicherte Analyse-Läufe.

### 6. Änderungen live verfolgen

Wenn eine Analyse aktiv ist, kann NodeAnalyzer Dateisystemänderungen verfolgen. Betroffene Knoten werden dann im Graphen optisch hervorgehoben.

---

## Wie die Graphen zustandekommen

Die Graphen entstehen in mehreren Schritten:

| Schritt | Was passiert |
|---|---|
| 1. Zielauflösung | Die ausgewählte `appId` wird über `apps.json` zu `rootDir` und `entry` aufgelöst. |
| 2. Strukturscan | Verzeichnisse und Dateien werden bis zu einer begrenzten Tiefe eingesammelt, damit die Grundstruktur sichtbar ist. |
| 3. Parsing | JS/TS-Dateien werden geparst. Dabei werden Imports, Funktionen, Funktionsaufrufe, Header-Kommentare und Metriken extrahiert. |
| 4. Importauflösung | Projektinterne Importe werden zu echten Dateien aufgelöst. |
| 5. Auto-Referenzen | Indirekt referenzierte Dateien und Verzeichnisse wie Docs, Daten oder Assets können zusätzlich in den Graphen aufgenommen werden. |
| 6. Graphaufbau | Aus allen Informationen entstehen Knoten und Kanten. |
| 7. Graph-Finalisierung | Abgeleitete Werte wie Inbound/Outbound, Importance oder ungenutzte Funktionen werden berechnet. |
| 8. Hotspot-Anreicherung | Wenn Git-Historie vorhanden ist, werden Änderungsfrequenz und Hotspot-Scores ergänzt. |
| 9. Persistenz | Das Ergebnis wird als JSON und CSV gespeichert und anschließend visualisiert. |

### Wichtige Konsequenz

Der Graph zeigt die **statische Architektur**, nicht:

- Runtime-Zustände,
- echte Request-Flows,
- dynamisch geladene Module,
- package-interne Details aus `node_modules`.

Das Ergebnis ist also bewusst strukturell und konservativ.

---

## Den Standardgraphen interpretieren

Der Standardgraph ist die wichtigste Ansicht. Er kombiniert Struktur, Abhängigkeiten, Funktionsniveau und Hotspot-Signale in einer einzigen Visualisierung.

### Knotentypen

| Knotengruppe | Bedeutung |
|---|---|
| Project root | Oberster Einstiegsknoten des analysierten Projekts |
| Directories | Ordnerstruktur |
| Source files | Code-Dateien wie `.js`, `.ts`, `.tsx`, `.jsx` |
| Docs | Markdown- und Dokumentationsdateien |
| Data/config | JSON, CSV, Konfigurationen und sonstige Datendateien |
| Images/assets | Statische Medien und Assets |

### Kantenarten

| Kantenart | Bedeutung |
|---|---|
| Imports/includes | Eine Datei bindet eine andere strukturell ein |
| Uses/reference | Eine Datei oder Funktion verwendet einen anderen Knoten referenziell |
| Function calls | Eine Funktion ruft eine andere Funktion auf |
| Inheritance | Vererbungs- oder Ableitungsbeziehungen, falls solche Informationen vorhanden sind |

### Wie Knoten visuell gelesen werden

| Merkmal | Interpretation |
|---|---|
| Größe | Größere Knoten stehen für höhere Komplexität oder mehr enthaltene Komplexität im Modul |
| Grundfarbe | Spiegelt zuerst die Knotengruppe wider, also z. B. Code, Dokumentation oder Daten |
| Farbintensität | Höhere Komplexität wird meist intensiver dargestellt |
| Randfarbe | Zeigt grob die Rolle im Abhängigkeitsnetz: eher importiert, eher exportierend oder beides |
| Randbreite | Höhere Kopplung erzeugt stärkere Konturen |
| Außenring | Markiert exportierte Funktionen oder Module mit exportierten Kindfunktionen |
| Ringbreite | Nimmt mit der Funktionskopplung zu |
| Gestrichelte, blasse Knoten | Typischerweise als ungenutzt erkannte Funktionen |
| Rote Hervorhebung | Kürzlich geänderte Knoten aus dem Live-Dateisystem-Feed |
| Hotspot-Halo / Hotspot-Badge | Zusätzliche Hervorhebung für strukturell riskante, häufig geänderte Bereiche |

### Hotspots lesen

Hotspots kombinieren drei Faktoren:

- Änderungsfrequenz aus Git,
- Komplexität,
- Codeumfang.

Je stärker ein Knoten als Hotspot gilt, desto deutlicher wird er hervorgehoben. Besonders wichtige Hotspots bekommen ein Badge wie:

`1 · CC12`

Das bedeutet sinngemäß:

- `1`: sehr hoher Hotspot-Rang
- `CC12`: hohe cyclomatische Komplexität

### Cluster-Zonen

Die weichen Flächen im Hintergrund gruppieren zusammenhängende Bereiche zu Architektur-Zonen. Sie helfen bei der Orientierung, ersetzen aber keine harten Modulgrenzen.

---

## Filter und Legende verwenden

Die rechte Spalte enthält die Legende und die wichtigsten Filter.

### Node groups

Hier kannst du ganze Knotengruppen ein- und ausblenden, zum Beispiel:

- nur Quellcode,
- nur Dokumentation,
- nur Daten- oder Asset-Dateien.

### Link types

Hier blendest du bestimmte Beziehungstypen aus, etwa:

- nur Importbeziehungen,
- nur Funktionsaufrufe,
- nur strukturelle Includes.

### Options

Die wichtigsten Optionen sind:

| Option | Wirkung |
|---|---|
| Show files/dirs | Strukturelle Dateisystemknoten ein- oder ausblenden |
| Show functions | Funktionen zusätzlich zu Dateien anzeigen |
| Show unused | Als ungenutzt erkannte Funktionen sichtbar halten |
| Unused only | Fokus auf ungenutzte Funktionen |
| Show visitor handlers | Parser-/Traversal-Handler sichtbar halten, besonders relevant bei AST-lastigen Projekten |
| Hide isolates | Knoten ohne sichtbare Beziehungen ausblenden |

Hinweis: Einzelne Optionen in der Legende sind experimentell oder noch nicht in jeder Ansicht vollständig wirksam.

---

## MRI-Ansicht interpretieren

Die MRI-Ansicht verdichtet die aktuelle Lage des Systems auf Modulebene. Sie nutzt den **neuesten verfügbaren CSV-Snapshot** der aktuellen App.

### Was die MRI-Ansicht zeigt

| Visuelles Signal | Bedeutung |
|---|---|
| Kreisgröße | Umfang eines Moduls, vor allem über Zeilenanzahl |
| Füllfarbe | Hotspot-Score des Moduls |
| Halo | Änderungsfrequenz |
| Randbreite | Fan-Out, also wie stark das Modul nach außen wirkt |
| Labels | Fokus auf die wichtigsten Module |
| Layer-Beschriftungen | Falls Layerdaten vorhanden sind, werden Module nach Architektur-Lage geordnet |

### Layout der MRI-Ansicht

Die MRI-Ansicht kann drei Layouts verwenden:

| Layout | Wann es verwendet wird |
|---|---|
| CSV coordinates | Wenn verwertbare Koordinaten im Snapshot vorhanden sind |
| Layer layout | Wenn Layerinformationen vorhanden sind |
| Force layout | Fallback, wenn keine bessere Struktur vorliegt |

### Wofür MRI gut ist

Nutze diese Ansicht, wenn du schnell erkennen willst:

- welche Module groß und heiß sind,
- welche Module viele ausgehende Beziehungen haben,
- welche Bereiche häufig geändert werden,
- welche Teile der Architektur besonders dominant wirken.

---

## Time view interpretieren

Die Time-View zeigt Veränderungen über mehrere Analyse-Läufe derselben App.

### Was dargestellt wird

Die Ansicht berechnet für die wichtigsten Module einen **Drift-Wert** über aufeinanderfolgende Läufe. Dabei fließen insbesondere ein:

- `LOC`,
- `fanIn`,
- `fanOut`.

### Wichtige Leseregeln

| Element | Bedeutung |
|---|---|
| Gestapelte Flächen | Die wichtigsten Module mit dem höchsten Drift |
| Laufpunkte | Ein einzelner gespeicherter Analyse-Lauf |
| Tooltip am Laufpunkt | Drift, LOC, Fan-In und Fan-Out inklusive Delta zum vorherigen Lauf |
| Gleichmäßige X-Abstände | Die Läufe werden gleichmäßig verteilt, nicht proportional zur realen Zeit |

### Was „Drift“ hier bedeutet

Drift ist kein Fehlerwert, sondern ein Veränderungssignal. Hohe Drift kann bedeuten:

- ein Modul wächst stark,
- die Kopplung ändert sich deutlich,
- Schnittstellen verschieben sich,
- Umbauten oder Refactorings laufen.

Die Time-View ist damit besonders nützlich für:

- Architekturbeobachtung über mehrere Tage oder Wochen,
- Erkennen instabiler Module,
- Sichtbarmachen von Umbauphasen.

---

## README und Knotenkontext

Wenn du einen Knoten auswählst, sucht NodeAnalyzer nach der **nächstgelegenen README-Datei** innerhalb des Zielprojekts.

Das ist hilfreich, um:

- Code-Struktur und Projektdokumentation direkt nebeneinander zu sehen,
- Kontextinformationen pro Bereich zu lesen,
- Onboarding und Navigation zu verbessern.

Wenn keine README gefunden wird, ist das kein Fehler. Es bedeutet nur, dass im gewählten Bereich keine passende Datei vorhanden ist.

---

## Praktische Lesestrategien

### Für den Einstieg in ein unbekanntes Projekt

1. App auswählen
2. Standardgraph öffnen
3. Erst nur `Source files` und `Directories` anzeigen
4. Dann `Show functions` aktiv lassen
5. Große, stark umrandete und farbintensive Knoten zuerst prüfen
6. Passende README-Inhalte lesen

### Für Refactoring

1. Hotspots im Standardgraphen identifizieren
2. MRI-Ansicht zur schnellen Modulpriorisierung nutzen
3. In der Time-View prüfen, ob die betroffenen Module schon länger instabil sind

### Für Aufräumen ungenutzter Funktionen

1. `Show functions` aktivieren
2. `Show unused` einschalten
3. Optional `Unused only` verwenden
4. Treffer manuell validieren, weil die Erkennung heuristisch ist

---

## Häufige Fragen

### Warum sehe ich keinen Graphen?

Mögliche Ursachen:

- die App ist in `apps.json` nicht korrekt konfiguriert,
- `rootDir` oder `entry` existieren nicht,
- es konnten keine verwertbaren internen Beziehungen gefunden werden,
- das Ziel ist vom aktuellen Analysemodus nicht unterstützt.

### Warum sehe ich keine Hotspots?

Hotspots brauchen in der Regel:

- ein Git-Repository,
- Commit-Historie,
- analysierbare Dateien mit Metriken.

### Warum bleibt die Time-View leer?

Die Time-View braucht bereits vorhandene CSV-Snapshots aus mehreren oder wenigstens einem früheren Analyse-Lauf.

### Warum fehlt im README-Panel Inhalt?

Dann wurde für den gewählten Knoten keine passende README-Datei im Zielprojekt gefunden.

### Warum werden nicht alle Änderungen live sichtbar?

Live-Änderungen funktionieren nur für den aktuell aktiven Analysekontext. Außerdem ignoriert der Watcher bewusst technische Verzeichnisse wie Build-Artefakte oder `node_modules`.

---

## Grenzen der Interpretation

Bitte lies die Graphen immer als **Strukturmodell**, nicht als exaktes Laufzeitmodell.

Besonders wichtig:

- dynamische Imports können fehlen,
- Paketabhängigkeiten außerhalb des Projektwurzelpfads werden bewusst nicht vollständig verfolgt,
- „unused“ ist eine Heuristik,
- Hotspots sind eine Annäherung aus Historie, Größe und Komplexität.

Wenn du diese Grenzen im Blick behältst, ist NodeAnalyzer ein sehr starkes Werkzeug für Orientierung, Architekturgespräche und Refactoring-Vorbereitung.
