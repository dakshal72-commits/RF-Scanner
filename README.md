# RF Stock Move Scanner

A mobile-first warehouse stock-transfer application built with JavaScript, HTML/CSS, and Supabase. It validates warehouse master data, updates inventory atomically, preserves transfers during connectivity outages, and runs as an installable web app on handheld devices.

**[Open the live RF Scanner](https://dakshal72-commits.github.io/RF-Scanner/)**

## Try the live demo

Use this valid test transfer:

1. Enter source bin `A01.01.A03`.
2. Add SKU `BWV12` with quantity `1`.
3. Continue and scan `BWV12` again from the bucket.
4. Enter destination bin `A01.01.A04`, choose the move quantity, and complete the transfer.
5. Expand **Recent transfers** to inspect the SKU, quantity, and sync status.

The confirmed move subtracts one unit from the source inventory and adds one unit to the destination inventory in Supabase.

## Workflow

1. Scan or enter a source bin.
2. Scan SKUs and add quantities to a multi-item transfer bucket.
3. Edit quantities or remove items before continuing.
4. Scan a SKU from the bucket, enter the quantity to move, and scan its destination bin.
5. Complete that SKU's bin transfer immediately. If quantity remains, scan the SKU again and choose another destination.

```text
Source bin → Add SKUs and quantities → Scan SKU from bucket → Move quantity to destination → Sync
```

## Features

- Mobile scanner layout with one focused decision per screen
- Supabase validation for active bins, SKUs, and available quantities
- Multi-SKU transfer bucket with edit and remove controls
- Partial-quantity moves to different destination bins, each recorded as its own transfer
- Atomic source-to-destination inventory updates
- Expandable device history with item-level quantities and sync status
- Offline application cache and cached warehouse master data
- Inventory snapshots refreshed about every five minutes while the app is open and connected
- Local transfer queue with automatic retry after an outage
- Server-side conflict reports when a queued move is rejected; affected transfers stay on the device for review and retry
- Idempotent transaction IDs that prevent duplicate inventory updates
- Installable Home Screen experience for iPhone and Android
- Responsive desktop support and GitHub Pages deployment

## Validation examples

The application rejects:

- Unknown or inactive bins
- Unknown or inactive SKUs
- SKUs that are not stocked in the source bin
- Quantities above the source inventory balance
- Matching source and destination bins
- Empty or invalid quantities

## Testing outage recovery

1. Open the app online and wait for **Online • Offline ready**.
2. Install it using **Add to Home Screen** or **Install app**.
3. Disconnect the device from the network and complete a transfer.
4. Confirm that the move displays **Waiting to sync**.
5. Reconnect and confirm that it changes to **Synced** and updates Supabase once. If current inventory cannot support the move, it changes to **Needs attention** and appears on the supervisor dashboard.

## Technologies and demonstrated skills

- JavaScript functions, objects, arrays, events, and DOM manipulation
- Form and workflow validation
- Application state management
- Device-local draft saving and transfer history with `localStorage`
- Supabase/PostgreSQL, REST/RPC calls, row locking, and database transactions
- Progressive Web App caching and service workers
- Responsive interface design for desktop and handheld screens
- Requirements-to-interface translation
- Functional testing and error-state design
- Git and GitHub Pages deployment

## Run locally

Serve the `dist` directory from a local web server so service-worker caching is available:

```bash
python -m http.server 4173 --directory dist
```

Then open `http://127.0.0.1:4173/`.

The scanner uses portfolio data in Supabase. It does not connect to NetSuite or any company production system.

Apply `supabase/offline_conflicts.sql` after the base schema when setting up a fresh Supabase project. Offline transfers depend on a previously loaded app and snapshot on that device; browsers cannot guarantee background sync while the app is fully closed, so syncing resumes when it is reopened or focused.
