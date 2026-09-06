# HyphAeon — design specification

The look the implementers build. It supersedes the visual decisions in `web/src/app.css` and in every
component's scoped `<style>`; it changes no logic, no numbers, no DOM hook and no class name.

Winning direction: **the lab notebook**, with the grafts the review asked for — CSS-counter numbering
and a 400/700-only weight rule from *the instrument*, the labelled threshold line, residue-prefixed
stem labels and one-line running state from *the journal article*, and *the instrument*'s rule that a
refusal is black, not orange. Every point where the winning proposal was ambiguous, contradicted a
Playwright assertion, or failed a contrast check is resolved below and marked **Resolved:**.

Read §6 before touching a component. It is the list of class names and strings 62 specs assert on.

---

## 1. Thesis

A HyphAeon report is a fixed sequence of analyses over one gene, so it is set like the results section
of a paper: numbered sections, captioned figures and captioned tables, one system sans with tabular
figures, hairline rules, generous left-aligned margins, and hierarchy carried by size and position
rather than by colour or a second face. Colour is information: the DataMonkey purple `#5B3FA0`
appears only on the brand mark, links, the one primary action, and the sites the model called — the
same 0.5 em purple square means "called" in the Manhattan track, in the site table's Call column, on
a network node and on a coherence track, so a reader learns the glyph once; the DataMonkey orange
`#D9721B` keeps its DataMonkey role and marks warnings, and nothing else. Everything that is not a
fact about the data is removed rather than restyled — no cards, no shadows, no rounded corners, no
eyebrow labels, no pills, no tints, no gradients, no third hue — so that a page with nothing to
signal carries no colour at all.

Rams principles this leans on, and where:

| Principle | Where it bites |
|---|---|
| 4 — understandable | Numbered sections in run order; captions that state the encoding; one glyph for "called". |
| 5 — unobtrusive | One purple control per view; the instrument recedes and the numbers carry the page. |
| 6 — honest | No tier ramp the surrogate cannot support; captions say what is *not* drawn; a refusal is a fact, not an alarm; caveats are set as prose, not as warnings. |
| 8 — thorough | Tabular numerals everywhere digits align; every off-path state designed; contrast measured on both grounds in both schemes. |
| 9 — environmentally friendly | Zero bytes of font shipped; no decorative asset anywhere. |
| 10 — as little design as possible | One face, two weights, seven greys, two signal colours, one rule weight. |

---

## 2. Tokens

Paste §2.1 into `web/src/app.css` `:root` and §2.2 as the dark override. Names are deliberately the
ones `app.css` and `viz/theme.ts` already use, so the port is a value change in most of the 35 scoped
blocks rather than a rename.

### 2.1 Light — `:root`

```css
:root {
	/* ---- Typefaces. System stacks; nothing is vendored; zero font bytes are shipped. ---- */
	--font-text: 'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif;
	--font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;

	/* ---- Type scale. Six steps. Weights 400 and 700 only (see §2.4). ---- */
	--text-xs: 0.75rem; /* 12 — plot tick labels only */
	--text-sm: 0.8125rem; /* 13 — small print, table foot, mono in tables, section run-in */
	--text-md: 0.875rem; /* 14 — tables, captions, metadata, controls, nav, notes */
	--text-base: 1rem; /* 16 — body, overview values, stat values */
	--text-lg: 1.25rem; /* 20 — h2, verdict, drop-zone title */
	--text-xl: 1.75rem; /* 28 — h1 */
	--leading-tight: 1.2;
	--leading-normal: 1.5;

	/* ---- Spacing. Names and values unchanged from today's app.css. ---- */
	--space-1: 0.25rem;
	--space-2: 0.5rem;
	--space-3: 0.75rem;
	--space-4: 1rem;
	--space-5: 1.5rem;
	--space-6: 2rem;
	--space-8: 3rem;
	--space-10: 4rem;

	/* ---- Shape and measure ---- */
	--radius: 0;
	--container: 60rem; /* 960px: the report column */
	--container-narrow: 44rem; /* 704px: landing, methods, mcp, evaluate prose */
	--measure: 68ch; /* every p, figcaption, caption */

	/* ---- Light palette. Seven greys, two signal colours, nothing else. ---- */
	--bg: #ffffff;
	--surface-2: #f4f4f4; /* code blocks, hovered clickable row, null band */
	--hair: #e6e6e6; /* table row rules, overview underline */
	--rule: #d0d0d0; /* section rules, borders, inputs, plot axes, network edges */
	--text-faint: #6e6e6e; /* tertiary: qualifiers, severity labels, disabled */
	--text-muted: #555555; /* captions, metadata, labels, nav, tick labels */
	--text: #111111; /* body, headings, table head rules */
	--brand: #5b3fa0; /* DataMonkey purple: mark, links, primary action, called sites */
	--on-brand: #ffffff;
	--warn: #a85200; /* warning TEXT (the raw orange fails AA on white) */
	--warn-mark: #d9721b; /* DataMonkey orange: the warning square, marks only */
	--plot-neutral: #b4b4b4; /* uncalled marks */
	--focus: var(--brand);

	/* ---- Plot tokens. theme.ts resolves these; no plot may hard-code a colour. ---- */
	--plot-axis: var(--rule);
	--plot-tick: var(--text-muted);
	--plot-called: var(--brand);
	--plot-uncalled: var(--plot-neutral);
	--plot-threshold: var(--text-faint);
	--plot-null-band: var(--surface-2);
	--plot-hatch: var(--rule);
	--dms-positive: var(--brand);
	--dms-zero: var(--bg);
	--dms-negative: var(--text-muted);
}

html {
	color-scheme: light dark; /* native controls follow the scheme */
}
```

### 2.2 Dark — both guards, in this order

```css
@media (prefers-color-scheme: dark) {
	:root:not([data-theme='light']) {
		--bg: #111111;
		--surface-2: #1b1b1b;
		--hair: #2a2a2a;
		--rule: #3a3a3a;
		--text-faint: #8a8a8a;
		--text-muted: #b0b0b0;
		--text: #ededed;
		--brand: #a48be0;
		--on-brand: #111111;
		--warn: #e5a15a;
		--warn-mark: #d9721b;
		--plot-neutral: #5a5a5a;
	}
}
:root[data-theme='dark'] {
	/* identical block, so an explicit choice wins in both directions */
}
```

`data-theme="light|dark"` on `<html>` overrides the OS. There is no in-app toggle in this phase; the
attribute exists so screenshots and the e2e are reproducible and so a toggle can be added later
without touching a component.

### 2.3 Measured contrast

WCAG 2 ratios, computed, against both grounds a token can land on. Every text token clears AA (4.5:1)
on `--bg` **and** on `--surface-2`; `--warn-mark` clears the 3:1 non-text threshold.

**Light** (`--bg` `#FFFFFF`, `--surface-2` `#F4F4F4`)

| Token | Hex | on `--bg` | on `--surface-2` | Kind |
|---|---|---|---|---|
| `--text` | `#111111` | 18.88 | 17.17 | text |
| `--text-muted` | `#555555` | 7.46 | 6.78 | text |
| `--text-faint` | `#6E6E6E` | 5.10 | 4.64 | text |
| `--brand` | `#5B3FA0` | 7.88 | 7.17 | text + mark; `--on-brand` on it 7.88 |
| `--warn` | `#A85200` | 5.42 | 4.93 | text |
| `--warn-mark` | `#D9721B` | 3.30 | 3.00 | mark only (≥ 3:1) |
| `--rule` | `#D0D0D0` | 1.54 | 1.40 | hairline, never text |
| `--hair` | `#E6E6E6` | 1.25 | 1.13 | hairline, never text |
| `--plot-neutral` | `#B4B4B4` | 2.07 | 1.89 | mark; never the sole carrier of meaning |

**Dark** (`--bg` `#111111`, `--surface-2` `#1B1B1B`)

| Token | Hex | on `--bg` | on `--surface-2` | Kind |
|---|---|---|---|---|
| `--text` | `#EDEDED` | 16.13 | 14.71 | text |
| `--text-muted` | `#B0B0B0` | 8.71 | 7.94 | text |
| `--text-faint` | `#8A8A8A` | 5.47 | 4.99 | text |
| `--brand` | `#A48BE0` | 6.61 | 6.03 | text + mark; `--on-brand` on it 6.61 |
| `--warn` | `#E5A15A` | 8.61 | 7.86 | text |
| `--warn-mark` | `#D9721B` | 5.73 | 5.23 | mark |
| `--rule` | `#3A3A3A` | 1.66 | 1.51 | hairline |
| `--hair` | `#2A2A2A` | 1.32 | 1.20 | hairline |
| `--plot-neutral` | `#5A5A5A` | 2.74 | 2.50 | mark |

> **Resolved: `--text-faint` was `#767676`.** At `#767676` the qualifier line under an overview value
> reads 4.13:1 on a `--surface-2` hovered row — below AA. `#6E6E6E` clears both grounds (5.10 / 4.64)
> and is otherwise indistinguishable. Dark `#8A8A8A` already cleared both and is unchanged.

`#5B3FA0` is **never** a text colour on a dark ground (2.39:1) and never a fill behind text in either
scheme except the primary button. There is no `--brand-soft`, no `--accent-soft`, no tinted panel, no
`--ok` green, no `--danger` red, and no tier ramp: called / not called is the only distinction the
surrogate score supports, and the tier *label* ("Top 2 %" vs "Top 5 %") carries the grade the engine
actually makes.

### 2.4 Weights, numerals, italics

Weights **400 and 700 only**. Nothing else may be specified.

> **Resolved: the winning spec used 500 and 600.** Arial ships neither, so Windows synthesises them
> and the table heads, the h2 and the call label come out heavier than they were designed. Two
> weights is the only rule that makes the page identical on macOS, Windows and Linux, and the design
> is legible without a third: h1 is 700 at 28 px, h2 700 at 20 px, table heads 700 at 14 px, body 400.

```css
body {
	font-variant-numeric: tabular-nums;
	font-feature-settings: 'tnum' 1, 'kern' 1;
}
```

Set once, globally, so every digit on the site aligns. No italics anywhere (the one exception is
`<em>` inside running-state copy, which existing components already use). No `letter-spacing` other
than `0`. No `text-transform` anywhere.

### 2.5 Rules, hairlines, corners, focus, shadow

| Thing | Value |
|---|---|
| Section rule (under an `h2`) | `1px solid var(--rule)` |
| Report head rule (under `h1` + metadata) | `1px solid var(--text)` — the one black rule outside a table |
| Table top / head-bottom / last-row rules | `1px solid var(--text)` |
| Table body row rules | `1px solid var(--hair)` |
| Overview underline, `dl.stats` bounding rules | `1px solid var(--hair)` |
| Input, secondary-button, drop-zone border | `1px solid var(--rule)` (drop zone `dashed`) |
| Corners | `--radius: 0`, everywhere. Set `border-radius: 0` explicitly on `input`, `select`, `textarea` and `progress`, which Safari and Chrome round by default. |
| Focus | `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }`. Never `outline: none`. |
| Shadow | None, on anything in the document flow. The site-tree modal is the one floating layer and gets `0 0 0 1px var(--rule), 0 12px 32px rgb(0 0 0 / 0.28)`. |

> **Resolved: 2 px radius → 0.** The winning spec conceded 2 px without a reason. There is no reason;
> a 2 px radius is 2 px of decoration on every control. 0 is honest and one token simpler. `--radius`
> stays as a token (value `0`) so no scoped block has to be edited to remove a `border-radius` line.

### 2.6 Porting the existing token block

Delete outright: `--font-display`, `--text-2xl`, `--text-3xl`, `--radius-sm`, `--radius-lg`,
`--shadow`, `--brand-strong`, `--brand-soft`, `--accent`, `--accent-strong`, `--accent-soft`,
`--bg-subtle`, `--surface`, `--surface-raised`, `--border`, `--border-strong`, `--ok`, `--ok-soft`,
`--warn-soft`, `--danger`, `--danger-soft`, `--tier-strong`, `--tier-moderate`, `--tier-weak`,
`--tier-none`, and the `.eyebrow` uppercase/letterspacing block.

Because ~35 scoped blocks reference some of those, port in two passes so the tree is never broken:

- **Pass A** — add §2.1/§2.2 and, *temporarily*, alias every deleted name to its nearest survivor
  (`--surface: var(--bg)`, `--bg-subtle: var(--surface-2)`, `--border: var(--rule)`,
  `--border-strong: var(--text-muted)`, `--font-display: var(--font-text)`, `--radius-sm`/`--radius-lg`
  → `var(--radius)`, `--shadow: none`, `--accent`/`--accent-strong` → `var(--warn-mark)`/`var(--warn)`,
  `--danger` → `var(--warn)`, `--ok` → `var(--text)`, `--tier-strong`/`--tier-moderate` →
  `var(--brand)`, `--tier-none` → `var(--plot-neutral)`, `--brand-soft`/`--accent-soft`/`*-soft` →
  `transparent`). The whole app immediately renders in the new palette with no per-component work.
- **Pass B** — convert components section by section per §3, then delete the alias block. The port is
  finished when `grep -rn -- '--surface\b\|--border\b\|--bg-subtle\|--tier-\|--accent\|--ok\|--danger\|--shadow\|--font-display\|--radius-' web/src` returns nothing.

`viz/theme.ts`: replace the `FALLBACK` map with the §2.1 values, and keep `tierPalette()`'s shape so
its callers do not change — `{ tier1: --brand, tier2: --brand, neutral: --plot-uncalled, unscored: --hair }`.
The two tiers resolve to the same colour on purpose (§2.3); the label carries the tier.

---

## 3. Component rules

One short paragraph each. Every rule preserves the DOM hooks in §6.

**Page frame, header, nav, footer.** One left-aligned column, `--container` (960 px) on the report and
`--container-narrow` (704 px) on landing, methods, MCP and evaluate; page margin `--space-5` (24 px),
`--space-4` below 640 px. The masthead is a single row under a `1px var(--rule)`: a 10 px `--brand`
square (the DataMonkey mark reduced to its colour) beside the wordmark in `--text` at 16 px / 700,
then `nav[aria-label="Primary"]` at 14 px `--text-muted` with `--space-5` gaps; the current page is
`--text` with a 1 px underline. No pill, no fill, no shadow, no rounded mark. The footer is a
`1px var(--rule)` above 14 px `--text-muted`: the privacy promise (its first clause in `--text`) at
the left, four links at the right. The masthead mark is the only purple on a page with nothing to
signal.

**Landing (drop zone, paste, examples).** `h1` "HyphAeon" at 28/700, one 16 px `--text-muted`
sentence, then `.dropzone`: a `1px dashed var(--rule)` rectangle, `--space-6` `--space-5` padding, no
fill, left-aligned, holding a 20/700 `.dropzone__title` ("Drop your alignment here") and a 14 px
`--text-muted` `.dropzone__hint`. Hover and `.dropzone--active` (drag-over) darken the dash to
`--text` and nothing else — no tint, no scale, no shadow. `details.paste` is a 14 px `--text-muted`
summary opening a `--font-mono` 13 px textarea and the one primary button, "Analyze". `p.examples` is
a sentence, not a row of pills: "Or try an example:" in `--text-muted` followed by five `a.chip`
styled as plain purple links separated by a middle dot in `--text-faint` (`.chip + .chip::before`),
each keeping its `title` and its `/report/gallery/<id>/` href. Nothing on this page is centred, and
the word "surrogate" does not appear on it (§5, §6).

**Report title line and metadata.** `h1` is the dataset name at 28/700 with no ornament. Under it,
`.head .eyebrow` stays exactly where it is and keeps its text ("Report · bundled example", "Report ·
stored in this browser") but is now a plain 14 px `--text-muted` line — no uppercase, no
letterspacing, no orange. Beside or under it, one 14 px `--text-muted` metadata line, items separated
by a middle dot: input file names · taxa · codons · reference · model variant · seed · surface and
elapsed · **date and time**. A `1px solid var(--text)` rule closes the head. *Resolved:* the winning
mock printed the date only, so two runs on one evening were indistinguishable; print
`YYYY-MM-DD HH:mm`.

**Diagnostics strip and warnings table.** `details.strip` is a plain 14 px `--text-muted` sentence
with no panel and no background: `<summary>` opens **"What we did to your data."** (that exact string,
in `--text` 700 — the e2e reads it), then counts by severity in words, then the repairs, then
`.strip .tree` in full `--text` (it is always present, D22, and its text is asserted verbatim), then
the reference and any note that changes how the report is read. Counts take `--warn` only when
warnings exist. Expanded, it is the warnings table (§ Tables) with columns Severity, Code, Message:
`.sev` is 13 px `--text-faint`, `.sev--warn` is `--warn` preceded by the orange square. `.badge--*`
spans in `DataStrip`/`BeforeYouRun` lose their fills, borders and radius and become plain text spans.

**Section headings, numbering, figure and table captions.** Sections are numbered in run order — 1
Sites, 2 Gene, 3 Epistasis, 4 Attribution, 5 Filter, 6 Digital DMS, 7 Phenotype, 8 Data and
provenance — by **CSS counter**, never by markup:

```css
.report { counter-reset: section figure table; }
.section h2::before {
	counter-increment: section;
	content: counter(section);
	color: var(--text-muted);
	font-weight: 400;
	position: absolute; left: 0;  /* 2.5rem hanging column */
}
figcaption b::before { counter-increment: figure; content: 'Figure ' counter(figure) '. '; }
caption b::before   { counter-increment: table;  content: 'Table '  counter(table)  '. '; }
```

> **Resolved: the winning mock put `<span class="n">1</span>` inside the `h2`.**
> `e2e/report.spec.ts:112,150,155,157,174` assert `locator('h2').toHaveText(SECTION_TITLE[name])`,
> which is a full-text match, so a number in the element fails five assertions. Generated content is
> not in `textContent`. **The `h2` must contain exactly `SECTION_TITLE[name]` and nothing else** —
> including `'Epistasis and sectors'`, not the mock's "Co-selection network and sectors".

The heading row is `display: flex` with the title at 20/700 in `--text` and, at its right,
`.section__head .eyebrow`: a 13 px `--text-muted` run-in naming the CLI command in `--font-mono` and
what it is a surrogate for ("`hyphaeon meme`, surrogate for MEME"), sentence case, no colour, no
tracking. A `1px var(--rule)` closes the heading row. Sections are separated by `--space-10` (64 px);
`h3` is 16/700. Every plot is a `<figure>` with a `<figcaption>` **below**; every table has a
`<caption>` **above** (`caption-side: top`, left-aligned). Captions are 14 px `--text-muted` on
`--measure`, opening with a `<b>` (whose `::before` carries the generated number) in `--text` 700, and
they state what is drawn, what the marks mean, what is deliberately **not** drawn, and what clicking
does. Figures and tables number continuously through the report in DOM order; because all eight
sections are mounted from the first paint and land in a fixed order, the numbers are stable — a
pending section must therefore render no `figcaption` or `caption` (its running line carries none).

**Overview line.** `dl[aria-label="Report overview"]` keeps that exact label and its six
`div.tile` children — *Resolved:* the winning mock renamed it `"Overview"` and dropped `.tile`, which
breaks `gallery.spec.ts:73` and `report.spec.ts:167,168,318`. What changes is the typography, not the
structure: no borders, no fills, no tones, no radius, no shadow. A six-column grid closed by a
`1px var(--hair)` rule, each tile a 13 px `--text-muted` `dt` (Gene verdict, Called sites, Taxa,
Variant, Surface, Elapsed — these labels are asserted), a `dd` at 16 px whose `dd strong` is 700 and
carries **only the value**, and a 13 px `--text-faint` qualifier under it. Nothing is 24 px: the
verdict and the called count read at body size, and no word like "server" gets display size. Rules
that are load-bearing: `Taxa`'s and `Variant`'s `strong` must contain the bare value and nothing else
(`toHaveText('18')`, `toHaveText('viral')`); `Gene verdict`'s `strong` is `toContainText`ed with the
p-value, so it reads "No gene-wide signal, p<sub>ACAT</sub> 0.118" — the verdict phrase first, at
reading size, because it is the thing a reader is looking for. A tile whose section has not landed
shows an em dash in `--text-faint` with the phase in the qualifier, so the row doubles as progress.
`.tile--accent` styles the called count in `--brand`; `.tile--warn` styles a warning value in
`--warn`; every other tone class is dropped.

**Tables (site table, pair table, provenance, warnings, tools).** 14 px, `border-collapse: collapse`,
full column width, no zebra, no vertical rules, no side borders, no background. Head row between two
`1px var(--text)` rules, cells 700 in `--text`; body rows on `1px var(--hair)`; the last row closed by
`1px var(--text)`. Cell padding `0.4rem 0.75rem 0.4rem 0` so the first column sits on the rule.
Numeric columns are `.num`, right-aligned, tabular; codons and hashes are `--font-mono` at 13 px;
scientific notation is set as `1.01 × 10⁻⁵` with real superscripts. Column names stay the engine's
where a row must be matched to the JSON (`site_u`, `fdr_q`, `cesi`). `tr.row` is the control in the
site table, so it gets `cursor: pointer` and a `--surface-2` hover; the Site column is plain text
there and a link in the pair table and sector lists. Sort is shown by underlining the active head
cell (the existing `.sort` button and `.arrow` stay). Under each table, one 13 px `--text-muted`
`.table__foot` line: "Showing 6 of 97 scored sites. All sites, called only, Sites (CSV)."
**`.table .count` keeps its exact current text — `"1097 of 1097 sites"` — and appears once per page**;
it is asserted verbatim in five places. *Resolved:* the winning mock moved `.count` into a caption as
a bare number, which breaks all five.

**The call column.** `td.call` on an uncalled row is an em dash in `--text`; on an invariable row,
"not scored" in `--text-faint` with dashes in the numeric columns; on a called row, a 0.5 em
`--brand` square (`.call--on::before`) followed by the mode's label — "Top 2 %", "Top 5 %", "q ≤ 0.05",
"q ≤ 0.10" — in **`--text` at 400**. The existing `.badge--tier1/2/0` classes are kept as the hooks
and lose their fill, border, padding and radius. *Resolved:* the winning spec set the label in purple
700 *as well as* the square, which is one mark more than the plot uses for the same fact; the square
is the glyph, the label is the grade, and the two tiers are told apart by the words, not by a second
colour. The row is never tinted.

**Buttons, links, inputs, disclosures.** Links: `--brand`, 1 px underline at `0.16em` offset,
thickening to 2 px on hover, no colour change, no visited colour. One primary button per view
(`Analyze` on the landing, `Run phenotype association`, `Re-run everything`): `--brand` fill,
`--on-brand` label, `1px solid var(--brand)`, square, 14 px / 700, `0.4rem 0.9rem`; hover underlines
the label and changes nothing else. Secondary (`.button--secondary`, every download, every pager
control): transparent, `1px solid var(--rule)`, `--text` label, border darkening to `--text` on hover.
`.button--accent` is deleted. Disabled: `opacity: .45`, no other change. Inputs, selects and
textareas: `1px solid var(--rule)`, `--bg` fill, square, 14 px (`textarea` in mono 13 px), the global
focus ring; `accent-color: var(--brand)` on checkboxes, radios and `<progress>`. Segmented controls
(`.modes`, masked/unmasked, codon/AA, `.toggle-group`) are text buttons in one `1px var(--rule)` box,
32 px tall, the pressed one carrying a 2 px `--text` underline — **not** a filled black block, which
would outweigh the called sites it sits above. Disclosures (`details.paste`, `details.rerun`,
`details.strip`) are a 13–14 px `--text-muted` summary with the native marker in `--text-faint`; no
box, no chevron graphic.

**Progress checklist and running state.** A section that has not arrived renders one line — no grey
blocks, no animated bars, no spinner: a 0.5 em square in `--plot-neutral` (waiting) or `--brand`
(running), the phase name from `PHASE_LABEL`, and the count when there is one: "Running: scoring
sites, 612 of 1,097." at 14 px `--text-muted`. The run bar (`.runbar`, `role="status"`) is the same
line at the top of the report with the elapsed phase list beside it; the per-phase measured times
(PLAN §4.2) are printed as a 13 px `--text-faint` run-in, not as a bar chart. The DMS keeps its native
`<progress>` (`#dms progress`) at 2 px tall with `accent-color: var(--brand)` on a `--hair` track,
because it carries a real value. `.skeleton`'s `.bars` element is removed from the DOM.

**Warnings and refusals.** One treatment for `.note--warn`, `.banner--warn`, `.sev--warn`: a 0.5 em
`--warn-mark` square before the text, the lead phrase in `--warn` 700, the rest in `--text-muted`. No
fill, no border, no left rail, no radius. A **refusal** — `.notice--error`, `.note--danger`,
`.banner--danger` — is black, not orange: the word "Refused." (or "The run failed.") in `--text` 700
with a `2px solid var(--text)` left rule and `--space-3` padding, and the reason in `--text-muted`.
*Resolved:* orange is the attention colour; a refusal has already stopped the run and needs no alarm,
and spending the orange on it would make a warning and a refusal look like the same event. Orange
appears nowhere else on the site. Informational caveats are **not** warnings: the neural-head
disclaimer in `GeneCard` moves from `.note--warn` to a plain `.note` paragraph in `--text-muted`
("Selection probability, predicted gene LRT and synonymous rate variation come from one seeded draw
of the neural head and are not reproducible against the Python reference; they never drive the
verdict above."). The DMS cancellation note keeps `.note--warn` (the class is asserted) and is a
genuine warning: the scan is incomplete.

**Manhattan plot (canvas, `manhattan.ts`).** No frame, no grid, no tier halos, no dot on an uncalled
site. Axes are `1px --plot-axis` with 12 px `--plot-tick` labels in `--font-text`; both axes carry a
title ("LRT", "codon"). Variable sites are drawn as 1.5 px **stems** in `--plot-uncalled`; called
sites as stems in `--plot-called` with a 3 px dot and, above the dot, the residue-prefixed site label
in `--plot-called` 700 — "D697", "S279", the form a reader writes in her notes. Invariable sites are
not drawn at all. A **labelled threshold rule** is drawn across the plot at the active call cut:
a 1 px dashed `--plot-threshold` line with its rule named at the right in 12 px `--plot-tick` — "top
5 % of variable sites, LRT ≥ 3.29" under the percentile mode, "q ≤ 0.10" under the q mode, "z ≥ 2"
under the z mode. *Resolved:* without it a reader cannot see why site 452 at LRT 2.2 was not called
while 279 at 3.3 was; the rule is the plot explaining its own cut, and it is the **active** rule, not
a fixed χ² 3.84 the call mode may not be using. Entropy overlays become two 1 px `--text-muted` lines,
**off by default**, toggled from `.toggles`. The tooltip is a `--bg` box with a `1px var(--rule)`
border, 14 px, no shadow, no radius. `canvas[aria-label^="Predicted LRT by codon site"]` is unchanged
and the canvas lives inside the `<figure>`. Caption: what the stems are, what purple means, that
invariable sites are left blank rather than drawn at zero, and that clicking a stem opens the site
tree.

**Ranked plot (Observable Plot, `rankedPlots.ts`).** Same two colours, `grid: false`, hairline axes in
`--plot-axis`, ticks 12 px `--plot-tick`, no frame, no legend (the caption carries it). Marks:
`--plot-uncalled` r 2.5, called `--plot-called` r 3.5 with the residue-prefixed label. The α or
threshold reference is a 1 px dashed `--plot-threshold` rule with a text label, never a coloured
band. `.plot__bar select` keeps its hook and takes the input rule; the selected option's description
becomes the figure caption.

**Epistasis network (d3, `EpistasisNetwork.svelte`).** Nodes are `--bg` fill with a
`1px --plot-uncalled` stroke, area proportional to LRT; a **called** site's node is filled
`--plot-called` — the same purple square-equivalent as the table and the track. Edges are
`--plot-axis` with width by CESI. **Sector membership is never a hue and never a ring**: it is text —
the sector's site list under the figure and in each sector's `h3` block. *Resolved:* this is the
ambiguity two of the three proposals left open ("called or sector nodes → signal"); purple means
"called" and only that, so a sector cannot borrow it. The `SECTOR_PALETTE` and the legend row are
deleted; node/edge encoding moves into the caption ("Node area is proportional to predicted LRT, edge
width to CESI; filled nodes are called sites; layout is d3-force run to a fixed tick count, so it is
the same on every load"). Labels are 12 px `--plot-tick`, a called node's label `--plot-called` 700.
`#epistasis p.lede strong` keeps the edge count as its first `strong`, digits only.

**Sector panel.** No cards. Each sector is an `h3` ("Sector 1", size in 13 px `--text-faint`), the
consensus signature as `p.pars` in `--font-mono` 14 px, a two-column `dl` of the numbers (sites,
spectral coherence, null coherence with its s.d. and 95th percentile, isotropic baseline 1/K,
p<sub>perm</sub> with B and its Monte-Carlo error, mean LRT, shared taxa) at 14 px with `dt` in
`--text-muted`, and the coherence track as a captioned `<figure>` beside it. The track: a 0–1
hairline in `--plot-axis`, the null mean ± 2 s.d. as a `--plot-null-band` band, the 95th percentile a
dashed `--plot-threshold` tick, 1/K a solid `--plot-threshold` tick, the observed value a 2 px
`--plot-called` bar. The "Reading the numbers" paragraph is written once for the section, as a
`.note`, not once per sector.

**DMS heatmap and legend.** A diverging ramp built from tokens the site already has:
`--dms-positive` (`--brand`) for ΔLRT > 0, through `--dms-zero` (`--bg`) at zero, to
`--dms-negative` (`--text-muted`) for ΔLRT < 0, with the limit at the 98th percentile of |Δ| as today.
Wild-type cells are hatched in `--plot-hatch`. No red–blue, no third hue, no single-hue-plus-hatching
(sign must survive at a glance). The legend is one 13 px `--text-muted` line: a `−limit` swatch, the
ramp, a `+limit` swatch, then the sentence that already exists ("ΔLRT = mutant − baseline; the 98th
percentile of |Δ| sets the scale; hatched = wild type; click a site for its 19 deltas"). Because
purple and grey differ in chroma rather than only in lightness, and because the tooltip and the
per-site detail table print the signed number, sign is never carried by colour alone.
`canvas[aria-label^="Digital DMS heatmap"]` and `#dms progress` are unchanged.

**Phenotype plot and panel.** The association plot follows the ranked-plot rule: impulses in
`--plot-uncalled`, sites at q ≤ α in `--plot-called` with residue-prefixed labels, a dashed labelled
α rule, hairline axes, no legend. The panel's `role="tab"` strip becomes underlined text tabs (the
active one 2 px `--text` underline, `.pill` count spans become plain 13 px `--text-faint` numbers);
presets become a plain list of radios with a `1px var(--hair)` rule between rows, `.preset--on`
marked by `--text` 700 on the title rather than by a fill; `.preview__line` is a 14 px `--text-muted`
line; the result is a `.verdict` sentence at 20/700 plus `dl.stats`, with no tinted band. The section
is on demand, so before a run it is one sentence and a link, not an empty panel. The run button is
this section's one primary; **no button on the report may be labelled exactly "Run"** (§6).

**Site-tree modal.** The one floating layer: `--bg`, `1px solid var(--rule)`, the §2.5 shadow, square,
no radius. `.modal__header` is `h2` at 20/700 with a text "×" Close button at the right (accessible
name "Close"). `p.treesource` is 14 px `--text-muted` and keeps its exact strings. The phylotree draws
branches in `--text` at 1 px; branches carrying a parsimony substitution and the substitution counts
are `--brand`; `.facts` is a two-column 14 px block whose labels are `--text-muted`. The backdrop is
`rgb(0 0 0 / .4)`, no blur.

**/methods and /mcp.** Same rules as the report: `h1`, a metadata line, numbered `h2` per analysis
(CSS counter on the page container) with the CLI command as the 13 px mono run-in, prose at
`--measure`, caveats as a table with a Severity column, and `<pre>` install lines on `--surface-2`
with no border and no radius. `/methods` keeps its eight `section#model|sites|gene|epistasis|
attribution|filter|dms|phenotype` ids and its `nav.toc` (a plain list of links, no pills); the word
"surrogate" must appear on the page. `/mcp` keeps the `claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp`
line as the first thing after the intro, the `@veg/hyphaeon-mcp <version>` line, the
"with the N tools listed below" sentence, and `table.tools` under the §3 table rule with
`tr.tools__group` heading rows set in `--text-muted` 700; the table must contain no "Runs", "bridged"
or "python" text. Both pages: `.eyebrow` becomes a plain 14 px `--text-muted` line or is dropped
where the `h1` already says it.

**/evaluate.** The same frame; the form is a plain `dl`-like stack of labelled inputs under §3
Inputs with one primary button "Evaluate"; the disabled state is `opacity: .45` with the existing
`.hint` sentence explaining why. `.card` loses its border, fill, radius and shadow and becomes a
`1px var(--hair)`-bounded block; `.panels`' `.todo` lines are 14 px `--text-muted` statements, not
placeholders — no "to be written", "TODO" or "coming soon" text may appear on any route.

**Dark scheme notes.** The same page, inverted; nothing is designed twice and no asset has a dark
variant. Only the twelve tokens in §2.2 change. Three things to check on every component during the
port: (a) no component hard-codes `#fff`, `#000` or `rgb(…)` — everything reads a token, including
canvas and Plot code through `theme.ts`; (b) `theme.ts` must re-resolve tokens and redraw on a
`prefers-color-scheme` change and on a `data-theme` mutation, or a canvas keeps its light palette on a
dark page; (c) the `--brand` fill under `--on-brand` flips (white on purple in light, `#111` on
lightened purple in dark), so the primary button must take both from tokens.

**Motion.** None. No transitions on hover, no transforms, no scale, no spinner, no skeleton shimmer,
no animated progress bar (`<progress>` shows a real value and does not animate). The one permitted
animation is a 120 ms `opacity` fade as a section's payload replaces its running line, and it must be
wrapped:

```css
@media (prefers-reduced-motion: no-preference) {
	.section > :not(.section__head) { animation: fade 120ms ease-out; }
}
```

Nothing else may animate, and nothing may depend on the animation having run.

---

## 4. Remove

Delete these, do not restyle them. Each is a thing a reader cannot state the purpose of.

- **All shadows** on in-flow elements — the report sections, the gene card, the overview tiles, the
  preset cards, the sector cards, the header. `--shadow` is deleted; only `SiteTreeModal` keeps one,
  because it floats.
- **All radii above 0** — `--radius-sm: 4px`, `--radius: 8px`, `--radius-lg: 14px` and every literal
  `border-radius` in a scoped block, including the ones Safari adds to inputs.
- **Eyebrows as a device** — the uppercase, letterspaced, orange `.eyebrow` in `app.css`. The class
  name stays (the e2e reads it); the treatment becomes a plain sentence-case line (§3).
- **Pills and badges as decoration** — `DataStrip`'s severity badges, `SiteTable`'s tier badges, the
  provenance surrogate badge, the phenotype preset `.pill` counts, the landing chips-as-pills, the
  nav pills. The class hooks stay; the fills, borders, padding and radii go.
- **Purple as anything but the signal** — no purple page fills, card rails, section rails, left
  borders, tinted panels, `--brand-soft` backgrounds, purple gradients, purple headings, purple
  section numbers. It stays on the mark, links, the primary button, called sites, and the observed
  value against its null. On a page with nothing to signal, only the masthead mark is purple.
- **Orange anywhere except warnings** — the accent buttons, the orange eyebrows, the orange dot on the
  brand mark, `--tier-moderate`, `--accent-soft`. A refusal is black (§3).
- **The tier ramp and the third and fourth hues** — `--tier-strong` red, `--tier-weak` yellow,
  `--ok` green, `--danger` red, `SECTOR_PALETTE`, `AA_COLORS` in `SparkBar` (redraw it as a grey
  stacked bar with the majority residue printed beside it, or drop it from the table and keep the
  residue letters, which carry the information the colours needed a legend to explain).
- **Gradients** — none exist; none may be added.
- **Uppercase and letterspacing** — everywhere. `text-transform` and non-zero `letter-spacing` do not
  appear in the codebase after this change.
- **Marketing copy** — hero bands, feature grids, benefit columns, exclamation marks, "powerful",
  "seamless", "blazing", "simply drop". §5.
- **The display face** — `--font-display` and the DM Serif Display stack; and the `TODO(fonts)` block
  in `app.css`, since nothing is vendored (§2.1).

---

## 5. Copy rules

- **Fewer words.** A caption is one or two sentences. A section lede states the finding with the
  numbers inline and stops: "5 of 97 variable sites are called, the strongest at codon 697 (LRT 6.91,
  p = 0.014)."
- **Plain statements, not claims about the software.** "Every analysis runs here, in seconds, and
  nothing leaves your browser" is a fact. "Blazing-fast, state-of-the-art selection analysis" is not
  copy this product writes.
- **Captions say what the figure shows** — what is plotted, what the marks encode, **what is not
  drawn**, and what clicking does. "Figure 1. Predicted LRT by codon site. Grey stems are variable
  sites that were not called; purple stems mark the five called sites, labelled with residue and
  codon number. The dashed rule is the active call threshold (top 5 % of variable sites, LRT ≥ 3.29).
  Invariable sites (1,000 of 1,097) are not scored and are not drawn. Click a stem to open the site
  tree."
- **Table captions say what the rows are, how many of how many, and how the columns were computed**,
  and name the engine's own field names where a row must be matched to the JSON.
- **Caveats are facts, in the same voice as the results.** "The neural head's 11 parameters are
  missing upstream, so selection probability is one seeded draw and is not reproducible against the
  Python reference." Not "Please note that…", not an alarm, not a disclaimer box.
- **A refusal says what was refused and why, in one sentence**, and offers the next action.
- **Never label a result with a claim the model does not make.** An uncalled site is "not called", not
  "neutral"; an invariable site is "not scored", not "0".
- **No emoji, no icons, no exclamation marks, no first-person plural boasting.** The one "we" the
  product uses is the diagnostics summary, "What we did to your data", and it stays.
- **Route-specific copy constraints** (asserted): the landing page must contain "stay in this browser"
  and must **not** contain the word "surrogate"; `/methods` must contain "surrogate"; no route may
  contain "to be written", "TODO" or "lorem ipsum"; `table.tools` must not contain "Runs", "bridged"
  or "python".

---

## 6. The e2e contract — class names, hooks and text that must survive

Read from `e2e/{smoke,gallery,report,treefree,phenotype,server}.spec.ts` and `e2e/helpers.ts`. Change
the CSS behind these; do not change the name, the structure they imply, or the text where text is
asserted. Anything marked **exact** is a full-text match.

**Shell and navigation**
- `nav[aria-label="Primary"] a` — labels **exactly** `['Methods', 'Evaluate', 'MCP']`, in that order;
  no nav href may match `/(analyze|gallery)/?$`.
- `page.getByRole('heading', { level: 1, name: 'HyphAeon' })` on `/`; `<title>` matches `/HyphAeon/`.
- Every route document must keep COOP/COEP; no request may go off-origin (this is why no CDN and no
  Google Font may be introduced) and no route may fetch `*.onnx`, `ort-*.wasm/.mjs`, or anything
  matching `/hyphy/i`.

**Landing**
- `.dropzone`; the text `/drop your alignment here/i`.
- `details.paste`, `details.paste summary`, `details.paste textarea`, and inside it a button named
  `Analyze`.
- `p.examples a.chip` — exactly 5, each with `href$="/report/gallery/<id>/"` for
  `Smc6, bat_oas1, camelid, HIV1_RT, RHO`, each carrying a non-empty `title`.
- Body text must match `/stay in this browser/i` and must **not** match `/surrogate/i`.

**Report frame**
- `h1` = the dataset name (**exact**: `bat_oas1`, `Smc6`).
- `.head .eyebrow` — contains `/bundled example/i` (gallery) or `stored in this browser` (local).
- `dl[aria-label="Report overview"]` with `.tile` children; tiles found by `hasText` `Gene verdict`,
  `Called sites`, `Taxa`, `Variant`; value read from `.tile dd strong` (`Taxa` **exact** `'18'`/`'20'`,
  `Variant` **exact** `'viral'`, `Gene verdict` `toContainText` the p-value).
- The text `What we did to your data` (**exact substring**, visible).
- `.strip .tree` — **exact** text, e.g. `tree-free (TN93) — no branch lengths`,
  `tree-free (TN93) — no tree`.
- `.banner--warn` — contains `/interrupted/i` after an interrupted reload.
- `section#<name>` with `data-state` ∈ `pending|running|partial|done|cancelled|interrupted|failed|
  skipped|unavailable`, for `sites, gene, epistasis, attribution, filter, dms, phenotype`.
- `section#<name> h2` — **exact** `SECTION_TITLE[name]`: `Sites under episodic selection`,
  `Gene-level verdict`, `Epistasis and sectors`, `Attribution`, `Alignment-artifact filter`,
  `Digital deep mutational scan`, `Phenotype association`. **Section numbers must be CSS generated
  content, never markup.**
- On the report: `input[name="variant"]` count 0, and `getByRole('button', { name: 'Run', exact: true })`
  count 0 — **no control on the report may be labelled exactly "Run".**

**Sites**
- `#sites canvas[aria-label^="Predicted LRT by codon site"]`.
- `#sites .table .count` — **exact** `"351 of 351 sites"` / `"1097 of 1097 sites"` / `"96 of 96 sites"`;
  on the gallery route it is matched unscoped, so exactly one `.table .count` per page.
- `#sites table tbody tr.row` — clickable, opens the modal.
- `input[aria-label="Search sites"]`.

**Gene, epistasis, sectors**
- `#gene dl.stats dd.num` — the **first** one is p<sub>ACAT</sub> at four decimals (or `d.dde±dd`).
- `#epistasis p.lede strong` — the **first** one is the edge count, digits only.
- `p.pars`.

**DMS**
- `#dms progress`; `#dms .note--warn` contains `/Cancelled after/`;
  `#dms canvas[aria-label^="Digital DMS heatmap"]`; a button named `Cancel the scan`.

**Phenotype**
- `section#phenotype`; tabs by role and name: `Preset`, `Pick on the tree`, `Paste a list`,
  `Trait table`; `input[name="preset"]`, `input[name="preset"][value="marine"]`; `.preset--on`;
  `.preview__line`; fields by label `BH level α`, `Seed`, `Permulations B`; buttons
  `Run phenotype association` / `Run again`, `Cancel`; `.result .lede`, `.result table` (its **4th
  column is the score**, so column order is fixed), `.card .verdict`, `.card dl.stats dd.num`,
  `.plot__canvas > figure` (or `> svg`), `.plot__bar select` (option value `pars`), `.note--danger`
  (must be absent on success), downloads named `Phenotype (JSON)` and `Sites (CSV)`.

**Site-tree modal**
- `div.modal[role="dialog"]`, `p.treesource` (contains `Display only — your topology; branch lengths
  not estimated (model used TN93 distances)`, `/unit branch lengths drawn here are a convention, not a
  fit/i`, `/display only, built from the TN93 distances/i`), `.tree svg`, `.facts` (contains
  `/Codon site/`), `.notice--error` and `p.notice` (must be absent when a tree draws), a button named
  `Close`.

**Provenance and re-run**
- `dl.facts` / `.facts`; downloads by accessible name `Sites (hyphaeon meme JSON)`, `Report (JSON)`,
  `Sites (CSV)`, `Network (GraphML)`, `Tree (Newick)`.
- `details.rerun` with a `summary`, `input[name="rr-variant"][value="viral"]`, and a button named
  `Re-run everything`.

**/methods, /mcp, /evaluate**
- `/methods`: `section#model`, `#sites`, `#gene`, `#epistasis`, `#attribution`, `#filter`, `#dms`,
  `#phenotype`; body contains `/surrogate/i`; no `/to be written|TODO|lorem ipsum/i`.
- `/mcp`: the visible text `claude mcp add hyphaeon -- npx @veg/hyphaeon-mcp`; `@veg/hyphaeon-mcp <version>`;
  `with the N tools listed below`; `table.tools tbody tr` whose first row contains `hyphaeon_analyze`;
  `tr.tools__group` (group headings, excluded from the tool-row count); `table.tools` must not match
  `/\bRuns\b|bridged|python/i`; one row per registered tool with the tool name in `td:first-child`.
- `/evaluate` renders an `h1` and requests nothing off-origin.

**Also preserved because components read them**: `.container`, `.container--narrow`, `.button`,
`.button--secondary`, `.eyebrow`, `.lede`, `.note`, `.note--warn`, `.note--danger`, `.notice`,
`.notice--error`, `.banner`, `.banner--warn`, `.banner--danger`, `.skeleton`, `.runbar`, `.hint`,
`.mono`, `.num`, `.count`, `.sort`, `.arrow`, `.table__foot`, `.modes`, `.toggle`, `.toggle-group`,
`.pager`, `.legend`, `.tip`, `.tooltip`, `.snippet`, `.masked`, `.sig`, `.track`, `.band`, `.mark`,
`.downloads`, `.preview`, `.presets`, `.preset`, `.tabs`, `.panel`, `.transcript`, `.tools__group`,
`.pillar`, `.toc`, `.variants`, `.scroll`, `.grid`, `.field`, `.radio`, `.check`.

---

## 7. Acceptance

The port is not finished until a reviewer can see, in **both** schemes:

1. All eight report sections rendered from a real record (Smc6 and bat_oas1), including attribution,
   the artefact filter, a running Digital DMS, and phenotype before and after a run.
2. Every off-path state on one specimen page: a warning, a refusal, a skipped section, an interrupted
   banner, a waiting section, a running section with a count, a cancelled DMS, a disabled button, a
   segmented control in both states, a drag-over drop zone, an empty table, and a saturated-pairs note.
3. Figure 1 with its labelled threshold rule and residue-prefixed labels; Table 1 with its caption,
   its three black rules and its `.count` line reading "N of M sites".
4. `grep -rn 'border-radius\|box-shadow\|text-transform\|letter-spacing\|linear-gradient' web/src`
   returning only `--radius: 0`, the modal's shadow, and `letter-spacing: 0`.
5. The full Playwright suite green, with no spec edited to make it so.

---

## 8. As implemented

What the port did where it could not, or chose not to, follow the letter of §2–§5. Everything not
listed here is as specified; every §6 hook was kept and no spec was edited.

**Tokens and global CSS**

- `app.css` carries §2.1 and §2.2 verbatim, plus one token the spec does not name, `--link:
  var(--brand)`, which the landing and analyze routes read for their text-link buttons. It is an
  alias, not a hue.
- The §2.6 pass-A alias block was deleted at integration: the §2.6 grep returns nothing outside
  `app.css`, and `.button--accent` (kept during the port as a secondary-button fallback) had no
  remaining user, so it is gone too.
- `results/entropy.ts` lost its `AA_COLORS` table and `aaColor()`: `SparkBar` no longer reads it
  (the bar is grey, majority residue darkest, the residue printed beside it), and a twenty-hue map
  of hex literals had no other reader. The hex grep over `web/src` now returns only `app.css`,
  `viz/theme.ts`'s fallback map, and the `theme-color` meta in `app.html`.
- The one animation is written as `.section__body > *` rather than the spec's
  `.section > :not(.section__head)`; the body wrapper is the same set of nodes and the
  `prefers-reduced-motion: no-preference` guard is in place.

**Report**

- Tables wider than the 960 px column — the site table (14 columns), the pair table and the
  attribution table — scroll inside their own `.scroll` container (`overflow-x: auto`). At 1280 px
  the rightmost column (Epoch, `cesi`, Driver) is reached by scrolling the table; the page never
  scrolls horizontally. Narrowing the columns further would have broken tabular alignment.
- `EpistasisNetwork` fills a called node only when its parent passes the called set. `ReportView`
  now derives that set from the active call mode (the same `rows` the track, the table and the
  overview count read) and passes it through `EpistasisSection` as an optional `called` prop; the
  caption's "Filled nodes are called sites." sentence appears only when the set is present.
  `ResultsView` (the Phase 1 sites-only view) mounts no network and is unchanged.
- The artefact-filter section stated its patch count twice (a lede in `ReportView` and a lede in
  `FilterPanel`); the `ReportView` copy was removed, so the section has one lede.
- `DataStrip` no longer mounts `routes/analyze/BeforeYouRun.svelte`: expanded, it renders the
  Severity / Code / Message table from the same `panelModel` rows. The regime, plan, prescreen and
  cost blocks that `BeforeYouRun` adds on `/analyze` are therefore not repeated on the report.
- `ProvenancePanel` keeps the "verified" / "unverified" word beside the artefact hash; the
  unverified state takes the §3 warning treatment (orange square, `--warn` 700), because an
  unverified graph is a warning about the run, not a note.
- `DmsHeatmap` sets its row labels and axis ticks at 11 px, one point under §2.1's 12 px tick
  size, because a heatmap row is 12 px tall and a 12 px label overprints its neighbour.
- `phenotypePlots.ts` sets `grid: false` and `legend: false` at the source instead of hiding
  Plot's grid and swatch legend with scoped CSS; the caption carries the encoding.
- The sector coherence track draws the null band at mean ± 2 s.d. as §3 specifies; the previous
  build drew ± 1 s.d. The figure's aria-label and caption say ± 2 s.d.
- `TreePicker` and `SiteTreeModal` selected `g.node` for their post-render passes; phylotree v2
  classes ancestors `g.internal-node`, so the picker's clade handles and the modal's substitution
  marker had never been reached. Both now select `g.node, g.internal-node`. This is the one
  change in DOM-selection code; it changes no number.

**Prose routes**

- `/methods` renders each analysis's caveats as a numbered, hairline-ruled list (headline, detail,
  numbers, "Do:", source) rather than §3's "table with a Severity column": `caveats.json` carries
  no severity field, and inventing one would be a claim the data does not make. A `severity` in
  the schema is the prerequisite for the table.
- `/methods`'s `h1` is "Methods" (the former title moved into the metadata line); `/mcp`'s is
  "HyphAeon from Claude". Neither string is asserted.
- The phenotype `status` line on `/methods` is a plain `.note`, not an orange-railed box.

**Overview line**

- The six tile labels (Gene verdict, Called sites, Taxa, Variant, Surface, Elapsed) are the
  current ones, pinned by exact-text assertions; only the typography changed and a section that has
  not landed shows an em dash with the phase in the qualifier.

**Measured at integration** (`scratchpad/design/final/contrast.py` over the tokens in `app.css`)

| Scheme | Token | Hex | on `--bg` | on `--surface-2` |
|---|---|---|---|---|
| Light | `--text` | `#111111` | 18.88 | 17.17 |
| Light | `--text-muted` | `#555555` | 7.46 | 6.78 |
| Light | `--text-faint` | `#6E6E6E` | 5.10 | 4.64 |
| Light | `--brand` | `#5B3FA0` | 7.88 | 7.17 |
| Light | `--warn` | `#A85200` | 5.42 | 4.93 |
| Light | `--warn-mark` (mark) | `#D9721B` | 3.30 | 3.00 |
| Light | `--on-brand` on `--brand` | | 7.88 | |
| Dark | `--text` | `#EDEDED` | 16.13 | 14.71 |
| Dark | `--text-muted` | `#B0B0B0` | 8.71 | 7.94 |
| Dark | `--text-faint` | `#8A8A8A` | 5.47 | 4.99 |
| Dark | `--brand` | `#A48BE0` | 6.61 | 6.03 |
| Dark | `--warn` | `#E5A15A` | 8.61 | 7.86 |
| Dark | `--warn-mark` (mark) | `#D9721B` | 5.73 | 5.23 |
| Dark | `--on-brand` on `--brand` | | 6.61 | |

Every text token clears 4.5:1 on both grounds in both schemes; the orange mark clears 3:1.
`grep -rn 'border-radius\|box-shadow\|text-transform\|letter-spacing\|linear-gradient' web/src`
returns `--radius: 0` and the explicit `border-radius: 0` on inputs, `pre`, the button and three
Plot/table containers, `letter-spacing: 0` twice, and the modal's shadow — nothing else. No
`font-weight` other than 400 and 700 is specified anywhere. No off-origin request is made on any
route.
