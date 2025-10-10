# Fidelior Desktop – Starter Kit

Dieses Paket enthält die Grundstruktur und Konfigurationsdateien für dein Projekt.

## Ordner
- `assets/` – Logo-Dateien (SVG/PNG)
- `config/` – `objects.json`, `document_types.json`, `settings.json`
- `logs/` – hier legt die App monatliche CSV-Logs ab (lokal, nicht syncen)
- `backups/` – optionale PDF-Backups pro Monat (lokal)

## Konfigurationsdateien
- `config/objects.json` – Mapping Kürzel → Anzeigename → Zielpfad-Template
- `config/document_types.json` – Liste der Dokumentarten (mit „code“ für Dateinamen)
- `config/settings.json` – Farben, Watermark, Benennung, Verzeichnisse, Konfliktverhalten

> EGYO bleibt vollständig ausgeschrieben. Für B75 existieren optionale Unterordner: D1, D4, Allgemein.

## Nächste Schritte
1. In `settings.json` `paths.scopevisioRoot`, `paths.logsDir`, `paths.backupsDir` eintragen.
2. Prüfe die `objects.json` und ergänze weitere Objekte nach Bedarf.
3. Dokumentarten in `document_types.json` anpassen.
4. Projekt in VS Code öffnen und mit der Implementierung beginnen.
