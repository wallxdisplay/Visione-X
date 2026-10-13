# WallX Play

Multi-tenant digital signage SaaS: customer app, Layout Studio, Super Admin, native Android
player and ESP32 sensor integration, on Firebase (asia-south1).

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Design system: [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)
- Local development: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## Layout

| Path | What |
|---|---|
| `apps/web` | React + TypeScript SPA: customer app (`/`), Studio (`/studio`), Super Admin (`/admin`), player registration (`/player`) |
| `apps/android-player` | Native Kotlin player (phase 3) |
| `firmware/esp32-sensor` | Reference ESP32 (Arduino) firmware for sensor devices (phase 5) |
| `functions` | Cloud Functions 2nd gen (HTTPS API at `/api/**`) |
| `packages/shared` | Types, zod schemas, permissions, feature entitlements, Firestore paths |
| `packages/layout-spec` | Layout/manifest contract shared by web preview and Android player |
| `packages/billing-core` | Payment gateway interface, GST and pricing math |
| `packages/ui` | Design tokens and base React components |
| `tests/rules` | Firestore security-rules tests (emulator) |
