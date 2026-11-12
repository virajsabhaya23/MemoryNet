# Design: MemoryNet

The locked system. Every Hallmark run reads this first; the website and the app share it. Change it on purpose; this file is the rule.

## System

- Genre: modern-minimal. Posture: restrained.
- Theme: Console (Hallmark deal 1/3, seed governed-decision-memory-engineering-70c4·bab809a1·2026-11-05·r0).
- Colourways: **graphite** for the website and the app's Dark mode; **paper** for the app's Light mode. Auto follows the operating system through `light-dark()` and `data-theme` on `<html>`.
- Axes: dark/grotesk-sans/chromatic-amber.
- Shapes: the website opens on a decision record (who replaced a decision, when, why, with the evidence); the app is a set of app screens whose signature is the decision record with its version trail.

## Meanings

- **Amber is a person:** an approver, a reviewer, the operator, the one primary action, the current step.
- **Cool blue is an instrument:** a version, a timestamp, a retrieval receipt, a hash, an id, a reading.
- **Ok and bad** mark status and diffs only. There is no third signal, and the meanings never swap.
- **Mono** (Atkinson Hyperlegible Mono) is what the system wrote: ids, versions, times, diffs and figures, always tabular. Never a label, a heading or a button.

## Tokens

The token block in `website/assets/tokens.css` and at the top of `src/web/assets/cobalt-system.css` is the source of truth. The scale, easings and durations are Hallmark's shared scale.

```css
/* graphite (dark) */
--color-paper: oklch(17% 0.008 250); --color-paper-2: oklch(21% 0.009 250); --color-paper-3: oklch(13.5% 0.007 250);
--color-ink: oklch(95% 0.005 250); --color-ink-2: oklch(83% 0.008 250); --color-muted: oklch(71% 0.01 250);
--color-rule: oklch(31% 0.01 250); --color-rule-2: oklch(42% 0.012 250); --color-field-edge: oklch(55% 0.012 250);
--color-accent: oklch(82% 0.15 80); --color-accent-ink: oklch(18% 0.04 75); --color-accent-soft: oklch(29% 0.05 80);
--color-cool: oklch(77% 0.12 245); --color-cool-soft: oklch(29% 0.05 245);
--color-ok: oklch(76% 0.15 150); --color-ok-soft: oklch(24.5% 0.03 150); --color-bad: oklch(70% 0.17 25); --color-bad-soft: oklch(24.5% 0.035 25);
/* paper (light) */
--color-paper: oklch(98% 0.006 85); --color-paper-2: oklch(99.6% 0.003 85); --color-paper-3: oklch(95.3% 0.008 85);
--color-ink: oklch(19% 0.01 60); --color-ink-2: oklch(33% 0.01 60); --color-muted: oklch(45% 0.012 60);
--color-rule: oklch(89% 0.008 85); --color-rule-2: oklch(78% 0.01 85); --color-field-edge: oklch(58% 0.012 70);
--color-accent: oklch(54% 0.14 70); --color-accent-ink: oklch(99% 0.004 85); --color-accent-soft: oklch(94% 0.045 80);
--color-cool: oklch(52% 0.14 250); --color-cool-soft: oklch(94.5% 0.03 250);
--color-ok: oklch(50% 0.12 150); --color-ok-soft: oklch(95% 0.035 150); --color-bad: oklch(52% 0.17 27); --color-bad-soft: oklch(95% 0.03 27);
/* both */
--font-display: "Host Grotesk", ui-sans-serif, system-ui, sans-serif; --font-body: var(--font-display);
--font-outlier: "Atkinson Hyperlegible Mono", ui-monospace, monospace;
--radius-card: 10px; --radius-pill: 6px; --radius-chip: 4px; --rule-hair: 1px; --shadow-card: none;
--tracking-display: -0.03em; --display-weight: 500;
```

## Type

- Heads: Host Grotesk 500, tracking -0.03em, sentence case, never 700. Body: Host Grotesk 400 at 16px, line-height 1.55.
- Labels, table heads, chips and nav: Host Grotesk 500 a step smaller, sentence case, untracked, muted.
- The app uses the fixed app scale (ratio 1.2); the website uses the fluid scale.

## Surfaces

- Hairline panels: a 1px rule around paper-2, radius 10px. Panels that sit together are one surface divided by 1px seams.
- Three steps and no lamp: ground (paper), panel (paper-2), deepest (paper-3) for code, logs, inputs and changed rows. No shadow, glow, glass or gradient.

## Controls

- Primary: amber fill with accent-ink, radius 6px, 36px in the app and 44px on the website. One per screen.
- Secondary: a 1px rule-2 outline on paper-2, same radius and height. Quiet: text only, underlined in rule-2.
- Fields: paper-3 inside a 1px field edge, radius 6px, 36px tall.
- Chips carry state only: label face inside a 1px rule at 4px, tinted by meaning.
- Every control has default, hover, focus-visible, active and disabled states; forms add loading, error and success where the app has logic for them.

## Layout

- App: a 15rem rail that becomes a top bar with a menu under 60rem; content capped at 1440px; tables restack under 40rem; controls 32 to 40px with a 44px hit target.
- Website: one container recipe; the gutters grow at 1920 and the measure does not.

## Motion

Still. A value changes when its source does, over 220ms on ease-out. No reveal, parallax or hover lift. Reduced motion ends everything at once.

## The map

The network map is the one living surface (approved 2026-11-05); the rules above hold everywhere else, and its panels stay flat Console surfaces.

- Cells: each repository is a soft cell in a quiet identity hue from a fixed set that avoids the amber, cool-blue, ok and bad ranges. The hue only says which repository. People stay amber, agent accounts cool, incidents and failed approaches bad. A hub and its own records are one cell; cells never overlap (they keep a clear gap, and a connection between two cells only leans its records toward each other), and a cell's outline is a tight rounded hull around its own records.
- Nodes: lit spheres with a sign that says what each record is: repository, pull request, commit, issue, decision, rule, person. Knowledge shines brighter than the evidence behind it; guidance floats in front, evidence behind, hubs on the middle plane.
- Connections are typed: cites dotted cool, owns dotted amber, runs-as dashed, the rest solid. Relations bow gently; spokes inside a cell stay straight; several connections between the same two records fan out.
- Names never cover another node or a panel: a crowded name tries above, right and left before it is left out.
- Life: nodes breathe, recent activity sparks more often, light travels along a sample of connections (evidence into the memory that cites it) and continuously along the selection's, and the map drifts in slight depth with the pointer. Ambient motion runs near 30 frames a second, pauses in a hidden tab or under a sheet, and is off entirely with reduced motion: then the map is flat and still.
- Live: while open, the map re-reads the same permission-filtered records every 15 seconds (`304` while unchanged, paused in a hidden tab, stopped after sign-out or lost access). New records grow in beside their hub and what changed rings cool blue for about four seconds (a still ring under reduced motion); the name card says what changed and when. An edit that adds or removes nothing never moves the layout. R replays how the map grew, oldest records first.
- Panels: four small corners (name and attention, one command bar, kinds with a folded colour key, zoom with full screen and the overview). Details dock on the right, 19 to 25rem wide with the window, only while something is selected or opened by hand; under 60rem they follow the map instead of floating over it. Cards appear only for what is selected, pointed at or pinned; everything else keeps a plain name.
- Brain registry, the details' front page: the four kinds as one tiled surface (sign, name, figure, meaning), what AI tools would get as a figure with an ok meter, what needs a person as rows with a tone dot and a count, the latest changes with their dates in cool mono, then a folded guide. Two tiles a row in the dock, four when the panel is wide, one when it is very narrow.
- Research and licences (2026-11-05): Obsidian's Graph view was studied from its public help pages only (hover highlight, depth-limited local graph, time-lapse, orphan filter); MiroFish (AGPL-3.0) was studied locally with REA (MIT) and by reading (polling every 10 seconds, fanned parallel links). Only behaviour was taken as inspiration; no code, assets or text were copied, and the map's code is MemoryNet's own.
