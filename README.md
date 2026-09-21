# RF Stock Move Prototype

A browser-based warehouse RF workflow prototype built with plain HTML, CSS, and JavaScript. The interface uses one focused page per decision so scanner users are not overloaded with information.

## Workflow

1. Scan or enter a source bin.
2. Scan SKUs and add quantities to a multi-item transfer bucket.
3. Edit quantities or remove items before continuing.
4. Scan a destination bin.
5. Review and confirm the bin transfer.

## Demonstrated skills

- JavaScript functions, objects, arrays, events, and DOM manipulation
- Form and workflow validation
- Application state management
- Device-local draft saving and transfer history with `localStorage`
- Outage-safe transfer queuing with automatic Supabase retry and duplicate protection
- Offline app-shell caching and cached bin, SKU, and inventory validation
- Responsive interface design for desktop and handheld screens
- Requirements-to-interface translation
- Functional testing and error-state design

## Run locally

Open `dist/index.html` in a modern browser.

The scanner uses Supabase for validation and completed transfer records. When connectivity drops, it keeps transfers on the device and syncs them when the connection returns.
