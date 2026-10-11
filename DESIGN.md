# Design — Live Chat (desktop client)

## Vision & Identity

The desktop client has two faces:

- **Overlay.** It is invisible until a meme lands on screen. Its only visual signature is the caption: white text with a green stroke and green glow.
- **Launcher.** It is a native, Spotlight-like utility that should feel like part of the OS, not like an app. It appears instantly, gets out of the way, and is driven entirely from the keyboard. The memes are the content; the chrome recedes behind them.

## Color Palette

The launcher follows the OS:

- light or dark from `prefers-color-scheme`;
- accent from `systemPreferences.getAccentColor()`, injected at runtime;
- surface: native vibrancy (`hud` on macOS, `acrylic` on Windows 11), with a translucent tint for contrast.

```css
:root {
  --accent: #0a84ff;                 /* overridden by the system accent */
  --surface-tint: rgb(246 246 246 / 0.72);
  --text: rgb(0 0 0 / 0.88);
  --text-secondary: rgb(0 0 0 / 0.55);
  --text-tertiary: rgb(0 0 0 / 0.35);
  --separator: rgb(0 0 0 / 0.1);
  --fill-hover: rgb(0 0 0 / 0.05);
  --selection-text: #fff;
  --danger: #ff3b30;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface-tint: rgb(30 30 30 / 0.66);
    --text: rgb(255 255 255 / 0.9);
    --text-secondary: rgb(255 255 255 / 0.55);
    --text-tertiary: rgb(255 255 255 / 0.32);
    --separator: rgb(255 255 255 / 0.1);
    --fill-hover: rgb(255 255 255 / 0.06);
    --danger: #ff453a;
  }
}
```

Overlay caption (unchanged): white fill, `2px` green stroke, green glow.

## Typography

- Font: system stack, i.e. `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. Native is the point, so the system font is the deliberate choice here.
- Search field: 22px, weight 300.
- Rows: 13px.
- Section labels: 11px, weight 600, secondary color.
- Metadata: 11px with `font-variant-numeric: tabular-nums`, so durations and sizes line up.

## Layout & Spacing

- 4px base unit.
- Launcher window: 760 × 480. Radius 12px on macOS; Windows 11 rounds the window itself.
- Columns: results list 300px, then the preview pane (flex).
- Row height 40px, thumbnail 28px with a 6px radius, row radius 6px.
- Selection is a full accent fill with white text, as in Spotlight. Hover is a faint fill only.
- No shadows inside the window; the OS draws the window shadow.

## Component Patterns

| Component | Pattern | Notes |
|---|---|---|
| Launcher search field | Borderless input, magnifier glyph, 22px light | Autofocus on show; selects the previous query |
| Result row | Thumbnail → name + folder → duration badge | Accent fill when selected; `aria-selected` |
| Section label | "Vidéos", "Images", "Récents" | Sticky inside the scroll list |
| Preview pane | Media (contain) → name → metadata line → send form | Videos autoplay muted on loop |
| Duration picker | Segmented control: 3 s / 5 s / 10 s / 30 s / Complète | `⌘/Ctrl+1…5` |
| Footer | Result count, index status · keyboard hints | Hints use `<kbd>` |
| Empty and loading states | Single centered sentence with an optional action | No illustration |

## Design Decisions

- **2026-10-11**: Launcher follows the native Spotlight direction (chosen over a "green signal" branded variant and a thumbnail grid). The launcher is a system utility, and familiarity beats branding there.
- **2026-10-11**: System accent color instead of a brand color, so the launcher matches the user's OS settings.

## Motion & Animation

| Element | Animation | Timing |
|---|---|---|
| Launcher appear | opacity 0 → 1, scale 0.98 → 1 | 120ms, `cubic-bezier(0.2, 0.9, 0.3, 1)` |
| Selection move | none (instant) | Keyboard navigation must never lag |
| Preview swap | media fades in once loaded | 100ms |

All of it is disabled under `prefers-reduced-motion`.

## Anti-Patterns

- Branded colors or gradients in the launcher.
- Animating the selection highlight or the result list on each keystroke.
- Cards, borders or shadows around results.
- Placeholder illustrations in empty states.
- Mouse-only affordances: every action has a key.

## Visual References

- **macOS Spotlight (Tahoe):** vibrancy, search field scale, full-accent selection.
- **Raycast:** the footer hint bar, and sticky section labels in the list.
