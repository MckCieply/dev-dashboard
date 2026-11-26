# Design direction — locked

**Status: LOCKED (2026-11-26).** Single source of truth for the dashboard's look.
Read this before generating any UI. Do not re-pick a style per screen. Density
changes are variants inside this style (spacing, type scale), not a new style.
Changing this file is a deliberate decision taken with the owner.

**Direction:** B · "Telemetria" — `brutalist-skill`, archetype *Tactical Telemetry
& CRT Terminal* (dark only), plus `dataviz` rules for status color.

**Reference brand:** none from `design-md/`. The brutalist skill's Tactical
Telemetry spec is the reference. Mockup: `design/telemetria-mockup.dc.html`
(Claude Design canvas "Dev dashboard: kierunki wyglądu", artboard B).

## Color

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#0A0A0A` | Page background |
| `surface` | `#121212` | Panels, tiles, header bar |
| `grid` | `#2A2A2A` | 1px panel borders and panel header rule |
| `grid-soft` | `#1F1F1F` | Row dividers inside a panel |
| `ink` | `#EAEAEA` | Primary text, neutral status icons |
| `ink-muted` | `#9A9A9A` | Secondary text, captions, idle/queued/pending icons (7.04:1 on canvas) |
| `alert` | `#FF2A2A` | Red as **text or icon**: waiting, fail, offline (5.30:1) |
| `alert-fill` | `#E61919` | Red as **fill** only, with `#FFFFFF` text (4.65:1). Never as text. |
| `live` | `#4AF626` | One "LIVE" indicator in the header. Nowhere else. |

Rules:
- Red means "needs you or broken". Only `alert`/`alert-fill` are chromatic,
  besides the single `live` dot.
- Every status = icon + uppercase label in brackets, e.g. `[CZEKA]`. Never color alone.
- Labels and values stay in `ink`/`ink-muted`; color goes on the icon (dataviz rule).
- No gradients, no shadows, no glow effects in v1.

### Status map

| Status | Icon color | Label |
|---|---|---|
| session waiting | `alert` | `[CZEKA]` |
| session working | `ink` | `[PRACUJE]` |
| session unknown | `ink-muted` | `[NIEZNANY]` |
| runner busy | `ink` | `[ZAJĘTY]` |
| runner idle | `ink-muted` | `[WOLNY]` |
| runner offline | `alert` | `[OFFLINE]` |
| run in progress | `ink` | `[W TRAKCIE]` |
| run queued | `ink-muted` | `[W KOLEJCE]` |
| check pass / approved | `ink` | text |
| check fail / changes requested | `alert` | text |
| check pending / review pending | `ink-muted` | text |

## Typography

- Data, labels, panel headers: `"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace`,
  `font-variant-numeric: tabular-nums`.
- Macro numbers and the H1: `Inter` weight 900, uppercase, tight tracking
  (`-0.03em` or tighter), line-height 0.9. Use `clamp()` only for macro numbers.
- Panel header: mono 12px, 700, uppercase, letter-spacing 1.2px, prefix `// `.
- Body rows: mono 13px/1.4 (`ink`), sub-line mono 12px/1.4 (`ink-muted`).
- Fonts are self-hosted in the app (no Google Fonts call at runtime).

## Shape and layout

- Radius 0 everywhere. 1px borders. Gap 12px between panels.
- Page max width 1360px, padding 24px, fluid below.
- Order: header bar → "Czeka na Ciebie" block (red fill counter + list) → 4 stat
  tiles → 3 columns (Sesje | Runnery + Kolejka | Pull requesty). Columns wrap
  with `auto-fit, minmax(380px, 1fr)`.
- Icons: inline stroke SVG 16px, `stroke-linecap: square`, `stroke-linejoin: miter`,
  stroke 2.4. No emoji, no icon font.

## Accessibility

- Text contrast ≥ 4.5:1 (checked for every pair above).
- Semantic markup: `<section aria-labelledby>`, `<h2>` per panel, `<data>`/`<time>`
  for values, icons `aria-hidden="true"`.
- Waiting count change is announced with `aria-live="polite"` on the counter.
- Respect `prefers-reduced-motion` (no blinking).
