# PDF Pro Editor – Copilot Instructions

This is a browser-based PDF editor using:
- PDF.js 3 for rendering
- pdf-lib 1 for PDF export
- Fabric.js 5 for the interactive annotation layer

## Project Structure

```
index.html        – Main UI shell
css/style.css     – All styles (dark theme, responsive layout)
js/app.js         – Main application logic
README.md         – User documentation
```

## Architecture

- All PDF rendering is done via PDF.js onto `#pdf-canvas`
- Fabric.js canvas (`#annotation-canvas`) overlays the PDF canvas
- One Fabric canvas instance is kept per page in `State.fabricCanvases`
- On PDF export, each Fabric canvas is rasterized to PNG and embedded via pdf-lib

## Key Patterns

- `setTool(name)` – switches active tool and configures Fabric.js mode
- `renderPage(n)` – renders page n with current scale/rotation
- `getOrCreateFabric(n, w, h)` – returns or creates the Fabric canvas for page n
- History (undo/redo) is stored per-page as JSON snapshots

## Coding Guidelines

- Keep Arabic UI labels in the HTML/JS, English code identifiers
- All tools must update `statusTool` in the status bar
- New shapes should be added via Fabric.js, not raw canvas
