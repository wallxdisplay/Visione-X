# WallX SignageOS — Modern SaaS Design System

> **Purpose:** Visual design reference for Google Stitch to generate a coherent, production-minded interface for WallX SignageOS, a multi-tenant digital signage SaaS platform. Use these rules across the customer portal, content studio, screen player management, sensor integrations, billing, and WallX Super Admin.
>
> **Design direction:** Modern, precise, calm, enterprise-ready SaaS. Bright workspace, strong information hierarchy, restrained color, clean tables, useful data visualizations, and a capable content editor. Avoid a generic AI-dashboard aesthetic.

---

## 1. Product Identity

- **Product name:** WallX SignageOS
- **Category:** Cloud digital signage management platform
- **Core promise:** Create, schedule, publish, monitor, and connect every screen from one place.
- **Primary users:** Business owners, marketing teams, operations teams, signage administrators, IT staff, dealers, and WallX platform administrators.
- **Brand personality:** Confident, modern, technically capable, dependable, approachable.
- **Brand signature:** Preserve WallX's orange identity as a small, intentional brand accent. The application UI itself should use a modern indigo/blue SaaS action palette for a fresh software-product feel.
- **Suggested tagline:** One Platform. Every Screen.

## 2. Visual Principles

1. **Make operational status instantly legible.** Users should understand what is healthy, offline, scheduled, or needs attention without reading long descriptions.
2. **Design for the task, not decoration.** Favor practical layouts, clear hierarchy, useful summaries, and compact information density.
3. **Use color semantically.** Indigo is for primary actions and selected navigation; teal supports connected/data-related features; semantic colors communicate status only.
4. **Maintain a light, breathable workspace.** Use a pale blue-gray application canvas, white surfaces, fine borders, and very subtle shadows.
5. **Keep complex tools approachable.** The layout designer can be dense, but controls should remain grouped and predictable.
6. **Use consistent patterns.** Lists, filters, dialogs, tables, status chips, and forms should behave consistently across all modules.
7. **Design multi-tenant boundaries clearly.** The active organization, site, and screen context must always be visible when relevant.
8. **Do not rely on color alone.** Pair status colors with labels and, where appropriate, icons.

## 3. Modern SaaS Color Palette

### 3.1 Core palette

| Token | Hex | Use |
|---|---|---|
| `color-brand-primary` | `#4F46E5` | Primary buttons, active navigation, selected controls, links |
| `color-brand-primary-hover` | `#4338CA` | Hover state for primary actions |
| `color-brand-primary-pressed` | `#3730A3` | Pressed state |
| `color-brand-primary-soft` | `#EEF2FF` | Selected rows, active navigation background, subtle highlights |
| `color-brand-secondary` | `#0EA5E9` | Secondary emphasis, interactive data controls |
| `color-data-teal` | `#0F9F9A` | Sensor/data features, connected integrations, telemetry visuals |
| `color-wallx-orange` | `#D77836` | Small WallX brand signature, branded X mark, occasional accent only |
| `color-ink` | `#172033` | Main text and strong headings |
| `color-ink-secondary` | `#475569` | Secondary text and descriptions |
| `color-ink-muted` | `#64748B` | Supporting text, helper labels, timestamps |
| `color-canvas` | `#F6F8FC` | Main app background |
| `color-surface` | `#FFFFFF` | Cards, panels, modals, dropdown surfaces |
| `color-surface-subtle` | `#F8FAFC` | Table headers and muted surface areas |
| `color-border` | `#E2E8F0` | Standard borders and dividers |
| `color-border-strong` | `#CBD5E1` | Emphasized borders, input focus boundaries when not focused |

### 3.2 Semantic states

| Token | Hex | Use |
|---|---|---|
| `color-success` | `#15803D` | Success labels, healthy status |
| `color-success-soft` | `#DCFCE7` | Success chip backgrounds |
| `color-warning` | `#B45309` | Attention needed, stale readings, approaching limits |
| `color-warning-soft` | `#FEF3C7` | Warning chip backgrounds |
| `color-danger` | `#B91C1C` | Offline/error status, destructive actions, failed publishing |
| `color-danger-soft` | `#FEE2E2` | Error chip backgrounds |
| `color-info` | `#0369A1` | Informational messages and neutral system notices |
| `color-info-soft` | `#E0F2FE` | Informational chip backgrounds |
| `color-neutral-soft` | `#F1F5F9` | Draft, disabled, inactive, and neutral labels |

### 3.3 Color usage rules

- Use indigo as the main action color, not as a large decorative background.
- Use WallX orange sparingly for brand identity and very limited emphasis. Do not make every primary button orange.
- Teal may identify sensor data, integrations, or live telemetry, but must not imply success unless the status is actually healthy.
- Red is reserved for errors, offline conditions, destructive actions, or serious warnings.
- Keep chart colors consistent and distinguishable. Do not use a rainbow palette for unrelated series.
- Keep normal body text at strong contrast against its background. Never use pale gray for important labels or input text.

## 4. Typography

- **Font family:** Inter. Use a neutral sans-serif fallback if unavailable.
- **Page title:** 26–30 px, weight 650–700, line height 1.2.
- **Section title:** 16–20 px, weight 600–650.
- **Card title:** 14–16 px, weight 600.
- **Body text:** 14 px, weight 400–500, line height 1.45–1.6.
- **Secondary/helper text:** 12–13 px, weight 400.
- **Metric value:** 28–36 px, weight 650–700, tabular numerals enabled.
- **Table text:** 13–14 px. Use tabular numerals for counts, dates, usage, and sensor readings where supported.
- **Navigation labels:** 13–14 px, weight 500.
- Avoid oversized marketing typography inside operational screens. Use sentence case rather than all caps for labels.

## 5. Layout, Spacing, and Shape

### 5.1 Main application shell

- Desktop app uses a fixed left navigation rail/sidebar of approximately 248 px, with a compact/collapsed option around 72 px.
- Top bar height: 64 px.
- Main content horizontal padding: 28–32 px on wide desktop, 20–24 px on medium screens, 16 px on small screens.
- Use a 12-column grid where a complex dashboard needs alignment; prefer simple two- or three-column layouts otherwise.
- Keep the primary content width comfortable. Tables and monitoring views may use available width.
- Use a sticky top bar when helpful; avoid sticky panels that obscure the editor or table.

### 5.2 Spacing scale

Use an 8 px base spacing system, with 4 px available for compact icon/text alignment.

- `space-1`: 4 px
- `space-2`: 8 px
- `space-3`: 12 px
- `space-4`: 16 px
- `space-5`: 20 px
- `space-6`: 24 px
- `space-8`: 32 px
- `space-10`: 40 px
- `space-12`: 48 px
- `space-16`: 64 px

### 5.3 Corner radius and elevation

- Small inputs/chips: 6–8 px radius.
- Buttons: 8 px radius.
- Cards and panels: 12 px radius.
- Large editor panels and dialogs: 14–16 px radius.
- Standard borders: 1 px solid `#E2E8F0`.
- Shadows should be soft and rare: e.g. `0 1px 3px rgba(15, 23, 42, 0.06)` for floating surfaces.
- Avoid heavy shadows, glassmorphism, glowing borders, oversized rounded pills, and gradients used as decoration.

## 6. Iconography and Imagery

- Use a consistent outline icon family such as Lucide.
- Standard sizes: 16 px inline, 18 px controls, 20 px navigation, 24 px empty states.
- Keep icons simple and recognizable. Avoid emoji as UI icons.
- Use actual screen thumbnails or neutral display previews in screen cards; avoid arbitrary stock photography in operational pages.
- Media library thumbnails should show realistic previews of uploaded assets or clear file-type placeholders.
- Use charts for meaningful changes or comparisons, not as decoration.

## 7. Application Architecture in the UI

The design system must support three distinct app areas that share the same design language:

1. **Customer Portal** — manages an organization, sites, screens, media, layouts, playlists, schedules, sensors, team members, and billing.
2. **WallX Super Admin** — manages all customer organizations, approvals, plans, permissions, platform health, support access, and audit records.
3. **Signage Player / Playback UI** — a minimal, reliable screen playback surface. It is not the same UI as the management portal.

Keep the active organization visible in the global shell. Use organization-scoped data and labels. A user should never confuse which organization's screens they are managing.

## 8. Customer Portal Navigation

Use a clean left sidebar with grouped navigation. Recommended order:

**Overview**
- Dashboard

**Manage**
- Screens
- Sites & Groups
- Content Library
- Layout Studio
- Playlists
- Schedules

**Connect**
- Sensors & Data
- Integrations
- Alerts

**Insights**
- Playback Reports
- Analytics

**Account**
- Team & Permissions
- Subscription & Billing
- Organization Settings
- Help & Support

Rules:
- Show icons plus labels in the expanded sidebar.
- Use a subtle indigo background and indigo icon/text for the active item.
- Put account switching, organization identity, and user profile in predictable locations.
- Do not expose features that an account is not entitled to as if they were available. Use a clear upgrade state only where appropriate.
- On narrow viewports, collapse navigation into a drawer.

## 9. Global Top Bar

Include, as appropriate:

- Breadcrumbs or current page title.
- Organization / site context selector when relevant.
- Search or command-search entry for large deployments.
- Notification icon with unread count.
- Help entry.
- User avatar and account menu.

Keep the top bar quiet and compact. Avoid putting too many unrelated actions beside the title.

## 10. Customer Dashboard

### Primary job
Help a customer understand in approximately 30 seconds: **What needs attention, and what should I do next?**

### Recommended hierarchy

1. Page heading: `Good morning` or `Overview`, with active organization/site context.
2. Primary CTA: `Add screen` or `Create content`, chosen based on user role and setup state.
3. A compact metric row:
   - Total screens
   - Online screens
   - Offline screens
   - Scheduled content / active playlists
4. A prominent **Needs attention** area with prioritized items:
   - Screen offline
   - Player has not checked in
   - Publish failed
   - Sensor data stale or threshold crossed
   - Storage or screen limit approaching
5. Screen health list or grid with status, site, current content, and last seen.
6. Upcoming schedule or recent activity.

### Dashboard rules

- A healthy screen count should not visually overpower an offline/error count.
- Each issue should say what happened, which screen/site is affected, when it happened, and the next action.
- Use empty states to guide new customers through setup rather than displaying blank charts.
- Avoid more than four KPI cards in the first row unless the viewport is very wide.
- Do not use ornamental charts or fake data. In generated mockups, label sample content as sample if needed.

## 11. Screens and Device Monitoring

### Screens list
Use a high-utility table with optional thumbnail/grid toggle.

Recommended columns:
- Screen name
- Site / group
- Online status
- Current playlist/content
- Player version or device type when useful
- Last seen
- Last publish result
- More actions

### Screen statuses
Use status chips with both color and text:
- `Online` — green
- `Offline` — red
- `Syncing` — blue
- `Needs attention` — amber
- `Not configured` — neutral

### Screen details
Use tabs such as:
- Overview
- Content & Schedule
- Sensors
- Playback History
- Device & Network
- Activity Log

Remote actions such as restart player, refresh content, or capture screenshot must be grouped in an overflow or clearly labeled action area. Destructive or disruptive commands require confirmation and should show the action's scope.

## 12. Content Library

### Layout
- Page title and a clear `Upload media` primary action.
- Search, file type filters, tags, sort controls, and folder navigation.
- Grid/list view toggle.
- Thumbnail cards showing filename, media type, dimensions/duration where available, and processing/upload state.
- Bulk selection actions for move, tag, delete, or add to playlist.

### Upload behavior
- Show per-file progress and processing status.
- Support drag-and-drop without making it the only way to upload.
- Show useful errors for unsupported formats, oversized files, interrupted uploads, and transcoding failure.
- Separate media metadata in Firestore from the binary media files stored in object storage.
- Confirm before deleting media that is currently referenced by a layout or playlist.

## 13. Layout Studio / Designer

### Visual objective
The editor should feel like a dependable design tool, not a full professional video editor. It must be easy to understand and precise enough for digital signage composition.

### Recommended editor shell
- **Top bar:** Back to layouts, layout name, save state, undo/redo, preview, publish.
- **Left panel:** Media, widgets, templates, layers/zones.
- **Center:** Canvas representing the selected display resolution and orientation.
- **Right panel:** Properties of the selected zone/widget, alignment, size, styling, timing, and data binding.
- **Bottom area (optional):** Layer order or playlist/timeline controls where needed.

### Canvas rules
- Show the selected screen aspect ratio or resolution accurately.
- Include clear landscape/portrait switching and screen-resolution context.
- Zones can be moved, resized, aligned, layered, duplicated, and locked.
- Provide visible selection handles and keyboard-accessible alternatives where feasible.
- The canvas background should be quiet; the content being designed must be the focus.
- Use a subtle grid or snap guides only when they improve precision.
- Keep unsaved, saved, and publish states distinct.

### Widget insertion
Widgets may include:
- Text and formatted text
- Image, video, audio
- Table and chart
- Clock and date
- Weather and RSS
- QR code
- Web page / web embed
- Sensor value, gauge, status indicator, and alert banner
- API-driven data block

### Properties panel
Organize settings into short sections such as `Content`, `Style`, `Position & size`, `Playback`, and `Data source`. Hide irrelevant settings until the relevant widget type is selected. Clearly identify when data binding is live, stale, missing, or misconfigured.

## 14. Playlists and Scheduling

### Playlists
- Provide list view with playlist name, item count, duration, linked screens/groups, and updated date.
- Include a simple ordered sequence of content items with drag handles, duration, transition, and preview.
- Make loop behavior and item duration explicit.
- Allow items to be removed without deleting their source media.

### Scheduling
- Provide day/week calendar and a simpler schedule list.
- Show which screen/group a schedule targets.
- Support start/end dates, days of week, time windows, priorities, time zone, and recurrence.
- Show conflicts and overlapping high-priority schedules before publishing.
- Distinguish draft schedules from published schedules.
- Use a clear preview of what should be playing at a selected time.

### Emergency override
- Design an elevated but carefully controlled workflow for emergency announcements or high-priority content.
- Require confirmation, identify target screens, display the expected duration or priority, and log the publishing action.
- Do not make emergency override a casual one-click action.

## 15. Sensors & Data (ESP32 and Other Sources)

The product will connect ESP32 devices and sensors installed near screens. The interface should make the relationship between organization, site, screen, sensor device, and individual sensor channels explicit.

### Sensor overview
Show:
- Device name and assigned site/screen
- Online/offline or last-seen status
- Last reading timestamp
- Sensor types / channels
- Current value and unit
- Data freshness or connection warnings

### Sensor detail
Use tabs or sections:
- Live readings
- Historical charts
- Device configuration
- API credentials / integration status
- Thresholds and alerts
- Event history

### Data widgets
Allow customers to bind a sensor source to:
- Text value
- Table cell or row
- Chart
- Gauge
- Status indicator
- Alert/banner

### Sensor UI rules
- Always display units (for example, °C, %, V, A) and the timestamp of a reading.
- Visually distinguish `No data`, `Stale data`, and `Device offline`.
- Show thresholds as labeled values; do not communicate a critical threshold only through chart color.
- Use teal to distinguish telemetry/data features from general navigation.
- Never expose secret device credentials in plain text after initial creation. Provide rotate/revoke flows.
- The UI should reflect server-side validation and secure device authentication; do not imply ESP32 devices can write directly to unrestricted application data.

## 16. WallX Super Admin

This is a separate admin area with the same component system but stronger operational clarity. It should not look like the customer dashboard with different text.

### Navigation
- Platform Overview
- Organization Approvals
- Organizations
- Users & Roles
- Screens & Players
- Features & Limits
- Plans & Billing
- Integrations & API
- Support Access
- Audit Logs
- Platform Settings

### Platform overview
Prioritize:
- Pending organization approvals
- Active / suspended organizations
- Total registered screens
- Online/offline player summary
- Usage and storage warnings
- Payment/subscription issues
- Platform incidents or integration errors

### Organization approvals
- Use a table with company, requested administrator, date submitted, organization size if provided, and status.
- Actions: review, approve, reject, or request more information.
- Show an organization's requested permissions and any risk-relevant metadata before approval.
- Confirm rejection and require a reason where appropriate.

### Feature limits
Represent permissions and quotas explicitly:
- Screen limit
- User limit
- Storage limit
- Sensor/IoT capabilities
- API access
- Advanced widgets
- Remote commands
- Reports and proof-of-play
- White-label capabilities

Use clear switches for feature entitlements and explicit values for numeric quotas. Do not rely on unlabeled icons or color alone.

### Support access and audit
- Support access must be time-limited, permission-limited, and auditable.
- A support administrator should not see customer passwords or unmasked secrets.
- Record who performed sensitive actions, what changed, target organization, timestamp, and available context.
- Make audit logs searchable and filterable.
- Clearly separate read-only diagnostics from actions that change a customer's environment.

## 17. Plans, Billing, and Usage

- Show current plan, billing cadence, included limits, and usage in plain language.
- Distinguish actual usage from the plan limit.
- Provide an upgrade path without blocking unrelated work with intrusive modals.
- Display invoices, transaction status, payment history, and next billing date when available.
- Support trial states, manual invoices, custom enterprise pricing, and admin-managed entitlements.
- Use clear empty and error states for missing payment information or failed billing events.
- Never communicate successful payment based solely on a browser redirect; the UI should rely on verified backend status.

## 18. Tables, Forms, and Filters

### Tables
- Use clear column headers and light row dividers.
- Keep row heights around 48–56 px for comfortable scanning.
- Align numbers consistently and right-align them when comparison benefits.
- Put row-specific actions at the right, commonly behind a labeled overflow menu.
- Support search, filters, sorting, pagination, and bulk selection when relevant.
- Sticky headers are useful on long tables, but avoid excessive visual chrome.

### Forms
- Labels sit above fields.
- Placeholder text is an example, not a replacement for the label.
- Show required fields clearly.
- Put validation messages directly beside the relevant field.
- Use helper text for consequences or formatting rules.
- Group long forms into sections; keep the primary save action predictable.
- For destructive, security-sensitive, or publishing actions, explain consequences before the user confirms.

### Filters
- Place high-use filters in a compact row under the page title.
- Use chips to display active filters and provide a clear reset action.
- Preserve filters when navigating into an item and returning to the list where practical.

## 19. Component Style Rules

### Buttons
- Primary: indigo fill with white label.
- Secondary: white fill, neutral border, dark label.
- Tertiary: transparent background, neutral/dark label.
- Destructive: red treatment reserved for deletion, suspension, revocation, or similarly serious actions.
- Button height: roughly 36–40 px for normal actions; 44 px for touch-first actions.
- Use verbs such as `Publish`, `Add screen`, `Save layout`, `Approve organization`.
- Avoid multiple competing primary buttons in the same region.

### Inputs
- White surface, neutral border, 8 px radius, visible focus ring in indigo.
- Use readable input text and explicit units for numeric values.
- Disabled state must be distinguishable without making the label unreadable.

### Status chips
- Small, compact, sentence-case labels with a pale semantic background and strong text contrast.
- Always include the status word, such as `Online`, `Offline`, `Draft`, `Published`, `Pending`, or `Failed`.

### Cards
- White surface with fine border and 12 px radius.
- Avoid making every section a separate card. Use cards for meaningful groups of information, not as decoration.
- Maintain consistent padding, title placement, and action alignment.

### Tabs
- Use a clear active indicator and accessible text labels.
- Keep tabs limited to major content areas, not every small setting.

### Dialogs and confirmations
- Use for focused tasks, confirmation, or small forms.
- Prefer full pages/drawers for complex editors or long settings.
- Name the action in the primary confirmation button, for example `Suspend organization` instead of `OK`.

### Toasts and inline feedback
- Use toasts for brief non-blocking results.
- Use inline messages for persistent errors or issues that need action.
- Do not rely on a toast as the only record of a failed publishing operation.

## 20. Empty, Loading, and Error States

Every major page must have designed states for:

- First-time setup / no data
- Loading
- No search results
- Partial failure
- Permission denied
- Offline or unavailable service
- Failed upload or processing
- Publish in progress / publish failed
- Stale sensor data
- Missing integration configuration

Empty states should explain the next step and offer one sensible action. Use skeletons for large content regions when loading. Avoid fake charts that suggest real operating data exists. Error messages must explain what failed and what the user can do next, without exposing internal stack traces or sensitive details.

## 21. Responsive Behavior

### Desktop (1440 px and wider)
- Expanded sidebar.
- Dashboards may use 3–4 summary cards per row.
- Full content studio with media, canvas, and properties panels visible together.

### Laptop / tablet landscape (1024–1439 px)
- Allow collapsible sidebar.
- Preserve table usability; hide or move lower-priority columns into row details.
- Keep canvas visible; secondary panels can collapse.

### Tablet portrait / mobile (below 768 px)
- Sidebar becomes a drawer or bottom-safe navigation only where appropriate.
- Stack dashboard cards.
- Convert wide tables to carefully designed row cards or allow controlled horizontal scrolling when column relationships matter.
- The full layout editor can display a simplified editing experience; do not simply shrink the desktop canvas and panels to an unusable size.
- Make primary actions accessible and touch targets at least about 44 px where practical.

## 22. Accessibility and Interaction

- Follow WCAG AA contrast targets for normal text wherever practical.
- Ensure keyboard focus is visible with an indigo focus ring.
- All icon-only buttons need accessible names and tooltips where appropriate.
- Interactive targets must be easy to distinguish from static labels.
- Support keyboard navigation for dialogs, menus, tables, and core editor operations wherever feasible.
- Do not use color as the only signifier for status or errors.
- Respect reduced-motion preferences; use short, subtle transitions only.
- Avoid animations that distract from monitoring or live operational data.

## 23. Motion

- Use restrained 120–180 ms transitions for hover, focus, popovers, and navigation state.
- Do not animate large dashboard panels on every load.
- Use progress indicators for upload, processing, syncing, and publishing.
- For live data, update values without flashing or shifting the entire layout. Use a very subtle cue only when a changed value is important.

## 24. Charts and Data Visualization

- Use a restrained series palette: indigo, teal, sky blue, amber, and muted slate where multiple series are needed.
- Prefer line charts for readings over time, bars for comparisons, and compact gauges only when they provide a meaningful threshold context.
- Include titles, units, labels, tooltips, and useful time ranges.
- Use clear axis ticks and avoid unnecessary 3D effects, gradients, and decorative chart backgrounds.
- Show missing data honestly and distinguish gaps from zero values.
- Do not imply sensor readings are live if the timestamp indicates stale data.

## 25. Suggested Screen Inventory for Stitch

Generate these screens in the same design system and retain the same color, typography, spacing, and component conventions:

1. Sign in / forgot password
2. Organization onboarding and pending approval
3. Customer dashboard
4. Screens list with grid/table switch
5. Screen detail and playback health
6. Sites and screen groups
7. Content library with upload flow
8. Layout Studio with canvas and widget properties
9. Playlist editor
10. Schedule calendar and conflict review
11. Sensors overview
12. Sensor detail with readings and thresholds
13. Integrations / API / webhook configuration
14. Playback reports and analytics
15. Team members and roles
16. Subscription, plan usage, and invoices
17. Organization settings
18. Super Admin platform overview
19. Organization approval review
20. Organization permissions and plan limits
21. Platform device monitoring
22. Support access and audit logs
23. Alerts and notification preferences

## 26. Stitch Generation Instructions

When generating a screen:

1. Follow the color tokens and layout rules in this file. Do not invent a new palette for each screen.
2. Use the light theme as the default. A dark playback interface may be used for the screen player only when the content or playback purpose requires it; the admin workspace remains light by default.
3. Create realistic, enterprise-oriented sample data, but mark it clearly as demo/sample data where needed.
4. Favor a polished product UI with real hierarchy: page title, concise context, primary action, filters, data, and focused empty/error states.
5. Reuse navigation, tables, chips, dialogs, forms, and buttons consistently.
6. Keep WallX orange for brand identity rather than flooding the interface with orange controls.
7. Use indigo for primary actions, selected states, and focus; teal for connected sensor/data concepts; semantic colors for actual status.
8. Avoid gradients, neon glow, heavy glass effects, excessive pills, oversized metric cards, unnecessary decorative illustrations, and generic AI-generated dashboard patterns.
9. Do not overcrowd the dashboard. Use progressive disclosure for advanced controls.
10. Make the page look credible as a real B2B product that handles live screens, sensor telemetry, access control, and billing.

## 27. Example Design Token Summary

```css
:root {
  --color-primary: #4F46E5;
  --color-primary-hover: #4338CA;
  --color-primary-pressed: #3730A3;
  --color-primary-soft: #EEF2FF;
  --color-secondary: #0EA5E9;
  --color-data-teal: #0F9F9A;
  --color-wallx-orange: #D77836;

  --color-ink: #172033;
  --color-ink-secondary: #475569;
  --color-ink-muted: #64748B;
  --color-canvas: #F6F8FC;
  --color-surface: #FFFFFF;
  --color-surface-subtle: #F8FAFC;
  --color-border: #E2E8F0;
  --color-border-strong: #CBD5E1;

  --color-success: #15803D;
  --color-success-soft: #DCFCE7;
  --color-warning: #B45309;
  --color-warning-soft: #FEF3C7;
  --color-danger: #B91C1C;
  --color-danger-soft: #FEE2E2;
  --color-info: #0369A1;
  --color-info-soft: #E0F2FE;

  --font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  --radius-control: 8px;
  --radius-card: 12px;
  --radius-panel: 16px;
  --border-default: 1px solid #E2E8F0;
  --shadow-subtle: 0 1px 3px rgba(15, 23, 42, 0.06);
}
```

---

**Final design direction:** WallX SignageOS should feel like a modern enterprise SaaS product: indigo-led actions, pale blue-gray workspace, crisp white surfaces, teal data cues, and a restrained WallX orange signature. Prioritize readability, operational clarity, consistency, and a layout studio that is powerful without feeling intimidating.
