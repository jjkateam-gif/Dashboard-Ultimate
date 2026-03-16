const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, TableOfContents } = require('docx');
const fs = require('fs');

// ── helpers ──
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 }, children: [new TextRun({ text: t, bold: true, size: 36, font: "Arial" })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 160 }, children: [new TextRun({ text: t, bold: true, size: 28, font: "Arial" })] });
const h3 = t => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, bold: true, size: 24, font: "Arial" })] });
const p = (t, opts = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, size: 22, font: "Arial", ...opts })] });
const pb = () => new Paragraph({ children: [new PageBreak()] });
const code = t => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, size: 18, font: "Consolas" })] });
const bullet = (t, ref = "bullets") => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: t, size: 22, font: "Arial" })] });

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, opts = {}) {
  const width = opts.width || 2340;
  const shading = opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined;
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA }, shading,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), size: 20, font: "Arial", bold: !!opts.bold })] })]
  });
}

function makeRow(cells, opts = {}) {
  return new TableRow({ children: cells.map((c, i) => cell(c, { width: opts.widths?.[i], shading: opts.shading, bold: opts.bold })) });
}

function makeTable(headers, rows, widths) {
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      makeRow(headers, { widths, shading: "1a2235", bold: true }),
      ...rows.map(r => makeRow(r, { widths }))
    ]
  });
}

// ── Build document ──
const children = [];

// Title page
children.push(new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "DASHBOARD ULTIMATE", size: 56, bold: true, font: "Arial", color: "00d68f" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "UI/UX Design Guide", size: 40, font: "Arial", color: "94a3b8" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [new TextRun({ text: "Comprehensive Redesign Recommendations", size: 28, font: "Arial", color: "64748b" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "March 2026", size: 24, font: "Arial", color: "94a3b8" })] }));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "For review by: Claude, ChatGPT, Grok", size: 22, font: "Arial", italics: true, color: "64748b" })] }));
children.push(pb());

// TOC
children.push(h1("Table of Contents"));
children.push(new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 1: EXECUTIVE SUMMARY
// ═══════════════════════════════════════════
children.push(h1("1. Executive Summary"));
children.push(p("This document provides a comprehensive UI/UX redesign guide for the Dashboard Ultimate crypto trading platform. The dashboard is a monolithic single-page application (~20,500 lines) with 8 tabs: Backtester, Degen Scanner, Market Intel, Best Trades, Alerts, Paper Trade, Live Trading, and Predictions."));
children.push(p("The current UI is functional but has a developer-prototype aesthetic. This guide provides specific, implementable recommendations to transform it into a smooth, modern, premium trading experience."));
children.push(h2("1.1 Design Philosophy"));
children.push(p("Bloomberg Terminal depth meets modern fintech clarity. Information-dense but never cluttered, dark but never dull. The goal: smooth, modern, sexy -- but still functional for serious traders."));
children.push(h2("1.2 Key Themes"));
children.push(bullet("Reduce accent colors from 6+ to a strict 5-color palette"));
children.push(bullet("Replace blocky monospace headers with Inter + JetBrains Mono pairing"));
children.push(bullet("Consistent 8px border-radius on cards (slightly rounded, not bubbly)"));
children.push(bullet("4-tier background depth system for spatial hierarchy"));
children.push(bullet("Replace all emoji with Lucide SVG icons"));
children.push(bullet("Add micro-interactions: hover lift, value flash, skeleton loaders"));
children.push(bullet("Establish a rigid design system enforced across all 8 tabs"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 2: CURRENT STATE
// ═══════════════════════════════════════════
children.push(h1("2. Current State Analysis"));
children.push(p("The dashboard currently uses a dark theme (#0a0e17 background) with neon green (#00f5a0) as the primary accent. Multiple competing accent colors (cyan, pink/magenta, orange) fragment visual attention. Headers use large monospace/block fonts. Cards have thin 1px borders with sharp corners. Each tab uses a different highlight color."));
children.push(h2("2.1 Tab Descriptions from Screenshots"));

const tabDescs = [
  ["Backtester", "Left sidebar with config controls (dropdowns, inputs, date pickers), right area with Market Cycle Dashboard gauge (score 31), funding rate colored boxes (BTC -0.0028%, ETH -0.0042%, SOL -0.0088%, XRP -0.0009%), historical bear market comparison cards ($28K pattern, $22K avg, $16K pattern). Dense layout with sharp-cornered boxes."],
  ["Degen Scanner", "Sub-tabs row (By Return Tier, Live Feed, DNA Benchmarks, Watchlist, Bought, Perfect 100, 100x Club) as colored pill buttons. Auto-trade settings section with meme coin scanning. Loading spinner for results."],
  ["Market Intel", "Sub-tabs (Market Overview, Coin Screener, AI Top Picks, Astro Cycles, CTF Flows, Bees Feed). Stat cards at top (Total BTC Cap $2.5T, BTC Dominance 56.9%, Active Cryptos 18,283, Total Volume $578B, Cycle Day 694, BTC Price $70,950). Halving Cycle Position progress bar. Fear & Greed Index showing 15 (Extreme Fear). News Sentiment -35. Sector Performance Heatmap. Market Structure Signals. Macro Environment."],
  ["Best Trades", "Trade cards in horizontal row, each with probability arc gauges (55%-93%), market quality badges (A-Grade green, B-Grade yellow, No Trade red), R:R ratios (1.2:1 to 1.5:1), confidence ratings, SPOT/PERPS toggles. Auto-trade settings panel above with BloFin connection status."],
  ["Alerts", "Browser Notifications panel and Discord Webhook panel side by side. Empty state: 'No alerts yet - click New Alert to create your first one.'"],
  ["Paper Trade", "Left sidebar with strategy config (lookback 30 days, max daily trades 999, stop after 3 losses, Kill Switch DM). Center with empty strategy view. Bottom Trading Wallet section with Generate New Wallet, Import Keypair, Unlock Existing buttons."],
  ["Live Trading", "Left panel: Engine Status (Stopped, Credentials Locked), BloFin API Keys form (API Key, Secret Key, Passphrase, encryption password, Demo Mode checkbox, Store API Keys button). Center: Live Strategies, Open Positions, BloFin Futures (530+ pairs), Trade History sections. Left bottom: Safety Controls (max position $500, max leverage 29, daily loss limit $100, auto-close near liquidation 0%) + red Kill Switch button."],
  ["Predictions", "Left: Bot Status (Stopped), Strategy Config (bet size 10 USDC, edge threshold 10), Performance metrics (win rate, trades, total PnL, ROI all showing '--'). Center: Active Polymarket Markets (loading), Live Signals (waiting), Trade Log (no trades yet)."]
];

tabDescs.forEach(([tab, desc]) => {
  children.push(h3(`Tab: ${tab}`));
  children.push(p(desc));
});
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 3: COLOR PALETTE
// ═══════════════════════════════════════════
children.push(h1("3. Color Palette Refinement"));

children.push(h2("3.1 Primary Green -- Toned Down"));
children.push(p("Current #00f5a0 is oversaturated and causes eye strain. Shift to a premium emerald that still reads as 'crypto/fintech'."));
children.push(makeTable(
  ["Current", "Recommended", "Usage"],
  [
    ["#00f5a0 (neon)", "#00d68f (emerald)", "Primary accent, positive values, CTAs, active states"],
    ["--", "#00e8a2 (bright variant)", "Hover/highlight states ONLY, never resting state"],
  ],
  [2500, 2500, 4360]
));
children.push(p(""));

children.push(h2("3.2 Strict 5-Color Palette"));
children.push(p("Drop cyan and magenta entirely. They fragment visual attention in data-heavy interfaces."));
children.push(makeTable(
  ["Role", "Color", "Hex", "Usage"],
  [
    ["Primary Accent", "Emerald Green", "#00d68f", "Positive values, primary CTAs, active states"],
    ["Loss/Danger", "Soft Red", "#ff6b6b", "Negative values, errors, Kill Switch"],
    ["Warning/Caution", "Amber", "#f0b232", "Warnings, B-grade badges, locked states"],
    ["Info/Secondary", "Steel Blue", "#5b8def", "Links, secondary actions, info badges"],
    ["Neutral Highlight", "Cool Gray", "#8b95a5", "Tertiary info, disabled states, borders"],
  ],
  [1800, 1800, 1400, 4360]
));
children.push(p(""));

children.push(h2("3.3 Background Depth System (4-Tier)"));
children.push(p("Layer depth using a surface hierarchy, not gradients on the main background:"));
children.push(makeTable(
  ["Variable", "Hex", "Purpose"],
  [
    ["--bg-base", "#0a0e17", "Deepest layer -- page background"],
    ["--bg-surface", "#111827", "Cards, panels"],
    ["--bg-elevated", "#1a2235", "Modals, dropdowns, hover states"],
    ["--bg-hover", "#222d42", "Row hovers, interactive highlights"],
  ],
  [2400, 2400, 4560]
));
children.push(p(""));

children.push(h2("3.4 Text Hierarchy"));
children.push(p("Use color intensity as the primary differentiator, not font-size alone:"));
children.push(makeTable(
  ["Variable", "Hex/Value", "Usage"],
  [
    ["--text-primary", "#e2e8f0", "Key values, numbers you act on"],
    ["--text-secondary", "#94a3b8", "Labels, descriptions"],
    ["--text-tertiary", "#64748b", "Timestamps, metadata, footnotes"],
    ["--text-disabled", "#475569", "Disabled controls"],
  ],
  [2400, 2400, 4560]
));
children.push(p(""));

children.push(h2("3.5 Profit/Loss Colors"));
children.push(p("Raw #00ff00 and #ff0000 are amateur. Use desaturated, warm-shifted variants:"));
children.push(bullet("Profit: #00d68f with background rgba(0, 214, 143, 0.1)"));
children.push(bullet("Loss: #ff6b6b with background rgba(255, 107, 107, 0.1)"));
children.push(bullet("Use left-border accent (2px solid) on P&L rows for instant visual scanning"));

children.push(h2("3.6 Market Quality Badges"));
children.push(p("Replace saturated fills with subtle tinted pill badges:"));
children.push(bullet("A-Grade: color #00d68f, background rgba(0, 214, 143, 0.12), border rgba(0, 214, 143, 0.2)"));
children.push(bullet("B-Grade: color #f0b232, background rgba(240, 178, 50, 0.12), border rgba(240, 178, 50, 0.2)"));
children.push(bullet("C-Grade: color #94a3b8, background rgba(148, 163, 184, 0.1) -- use GRAY, not orange"));
children.push(bullet("No-Trade: color #64748b, background rgba(100, 116, 139, 0.08) -- gray and quiet, NOT red"));

children.push(h2("3.7 Border Colors"));
children.push(makeTable(
  ["Variable", "Value", "Usage"],
  [
    ["--border-subtle", "rgba(255,255,255,0.06)", "Card borders"],
    ["--border-default", "rgba(255,255,255,0.10)", "Dividers, input borders"],
    ["--border-strong", "rgba(255,255,255,0.16)", "Focused inputs, active cards"],
  ],
  [2800, 3200, 3360]
));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 4: TYPOGRAPHY
// ═══════════════════════════════════════════
children.push(h1("4. Typography"));

children.push(h2("4.1 Font Pairing"));
children.push(p("Replace all-monospace with a dual-font system:"));
children.push(bullet("UI/Headers: Inter (or Plus Jakarta Sans) -- clean geometric sans-serif"));
children.push(bullet("Data Values/Numbers: JetBrains Mono (or IBM Plex Mono) -- refined monospace with tabular figures"));

children.push(h2("4.2 Type Scale"));
children.push(makeTable(
  ["Token", "Size", "Usage"],
  [
    ["--text-xs", "11px", "Tiny badges, tooltips, uppercase labels"],
    ["--text-sm", "13px", "Body text, labels, descriptions"],
    ["--text-base", "14px", "Default body, card content"],
    ["--text-lg", "16px", "Section headers"],
    ["--text-xl", "20px", "Key metric values"],
    ["--text-2xl", "24px", "Featured numbers, gauge values"],
  ],
  [2400, 1600, 5360]
));
children.push(p(""));

children.push(h2("4.3 Header Treatment"));
children.push(p("Current large monospace block fonts ('CRYPTO BACKTESTER PRO') are aggressive and amateur. Replace with:"));
children.push(bullet("Page titles: Inter, 18px (not 28-32px), font-weight 600, letter-spacing 0.02em, color #e2e8f0"));
children.push(bullet("Section headers: Inter, 13px, font-weight 600, uppercase, letter-spacing 0.06em, color #8b95a5 (muted)"));
children.push(bullet("Card titles: Inter, 15px, font-weight 500, color #c9d1d9"));

children.push(h2("4.4 Number Formatting"));
children.push(bullet("All numeric values use font-variant-numeric: tabular-nums (columns align vertically)"));
children.push(bullet("Large numbers: letter-spacing -0.02em for tighter, premium feel"));
children.push(bullet("Uppercase labels: letter-spacing 0.06em"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 5: BORDER RADIUS & CARDS
// ═══════════════════════════════════════════
children.push(h1("5. Border Radius & Card Design"));

children.push(h2("5.1 Border Radius Scale"));
children.push(p("Sharp corners = legacy terminal. Overly round (20px+) = consumer app. Sweet spot for trading: 8px on cards."));
children.push(makeTable(
  ["Token", "Value", "Usage"],
  [
    ["--radius-xs", "4px", "Tooltips, tiny badges"],
    ["--radius-sm", "6px", "Buttons, inputs, dropdowns"],
    ["--radius-md", "8px", "Cards, panels, sections"],
    ["--radius-lg", "12px", "Modals, popovers, dialogs"],
    ["--radius-pill", "20px", "Status pills, tags, tab indicators"],
    ["--radius-full", "9999px", "Avatars, circular icons"],
  ],
  [2400, 1600, 5360]
));
children.push(p(""));

children.push(h2("5.2 Card Treatment"));
children.push(p("Replace thin 1px wireframe borders with layered surfaces and subtle elevation:"));
children.push(code("background: var(--bg-surface);  /* #111827 */"));
children.push(code("border: 1px solid rgba(255, 255, 255, 0.06);"));
children.push(code("border-radius: 8px;"));
children.push(code("box-shadow: 0 1px 3px rgba(0,0,0,0.3);"));
children.push(code("/* Subtle top-border highlight for depth illusion */"));
children.push(code("/* via ::before pseudo-element with gradient */"));
children.push(p("This single-pixel top highlight is how dYdX and modern DeFi dashboards create depth without blur effects."));

children.push(h2("5.3 Glass Morphism -- Use Sparingly"));
children.push(p("Use on no more than 2-3 featured elements per tab (e.g., modal headers, featured stat cards):"));
children.push(code("background: rgba(13, 18, 32, 0.7);"));
children.push(code("backdrop-filter: blur(12px);"));
children.push(code("border: 1px solid rgba(255, 255, 255, 0.08);"));
children.push(p("Overuse makes everything feel blurry and unfocused. Most cards should be solid surface-1."));

children.push(h2("5.4 Gradients -- Strict Rules"));
children.push(p("Use gradients in exactly 3 places:"));
children.push(bullet("Primary CTA buttons: linear-gradient(135deg, #00d68f, #00b377)"));
children.push(bullet("Chart area fills: rgba(0, 214, 143, 0.15) fading to transparent"));
children.push(bullet("Probability gauge arcs"));
children.push(p("Everywhere else, use flat colors."));

children.push(h2("5.5 Glow Effects -- Strict Rules"));
children.push(p("Glow appropriate in exactly 2 cases:"));
children.push(bullet("Active/connected status dots: box-shadow 0 0 6px rgba(0, 214, 143, 0.4)"));
children.push(bullet("Kill Switch button: box-shadow 0 0 12px rgba(255, 107, 107, 0.3)"));
children.push(p("Never use glow on: card borders, text, section headers, badges, or inactive elements."));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 6: SPACING & GRID
// ═══════════════════════════════════════════
children.push(h1("6. Spacing & Grid System"));

children.push(h2("6.1 Spacing Scale"));
children.push(makeTable(
  ["Token", "Value", "Common Usage"],
  [
    ["--space-1", "4px", "Icon gaps, tight internal spacing"],
    ["--space-2", "8px", "Badge padding, compact gaps"],
    ["--space-3", "12px", "Label margins, field spacing"],
    ["--space-4", "16px", "Card gaps, internal section padding"],
    ["--space-5", "20px", "Card padding (internal)"],
    ["--space-6", "24px", "Section gaps, page margins"],
    ["--space-7", "32px", "Major section dividers"],
    ["--space-8", "48px", "Page-level spacing"],
    ["--space-9", "64px", "Hero/empty state spacing"],
  ],
  [2200, 1600, 5560]
));
children.push(p(""));

children.push(h2("6.2 Grid Layout"));
children.push(bullet("Card grids: grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px"));
children.push(bullet("Sidebar + main (Backtester, Paper, Live): grid-template-columns: 300px 1fr; gap: 24px"));
children.push(bullet("Stat rows (Market Intel top cards): repeat(auto-fit, minmax(200px, 1fr)); gap: 16px"));

children.push(h2("6.3 Section Dividers"));
children.push(p("When sections run together, the eye cannot parse groupings. Use labeled dividers:"));
children.push(code("display: flex; align-items: center; gap: 12px;"));
children.push(code("font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;"));
children.push(code("color: rgba(255,255,255,0.4);"));
children.push(code("/* with ::after gradient line */"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 7: COMPONENT PATTERNS
// ═══════════════════════════════════════════
children.push(h1("7. Component Patterns"));

children.push(h2("7.1 Tab Navigation (Main)"));
children.push(p("Current: 8 tabs with emoji prefixes and per-tab colored highlights. This creates visual clutter."));
children.push(p("Recommended: Contained pill-style navigator (like Linear/Vercel). Drop emoji prefixes. Use one active color."));
children.push(bullet("Active tab: color var(--accent-primary), background rgba(0,214,143,0.15), with 2px bottom indicator"));
children.push(bullet("Inactive: color rgba(255,255,255,0.45), transparent background"));
children.push(bullet("Hover: color rgba(255,255,255,0.75), background rgba(255,255,255,0.04)"));
children.push(bullet("Consider grouping: 'Analysis' (Backtester, Scanner, Intel, Trades, Predictions) + 'Execution' (Paper, Live, Alerts)"));

children.push(h2("7.2 Sub-tabs"));
children.push(p("Used in Degen Scanner and Market Intel. Style as monochrome pills inside a tinted container:"));
children.push(bullet("Container: background var(--bg-elevated), border-radius 8px, padding 4px"));
children.push(bullet("Active pill: color white, background var(--accent-primary), border-radius 20px, subtle box-shadow"));
children.push(bullet("Inactive: color rgba(255,255,255,0.5), transparent, border-radius 20px"));

children.push(h2("7.3 Buttons (4-Tier System)"));
children.push(makeTable(
  ["Tier", "Style", "Usage"],
  [
    ["Primary", "Green gradient, dark text, glow shadow, hover lift", "Run Backtest, Start Scan, Execute Trade"],
    ["Secondary", "rgba(255,255,255,0.06) bg, subtle border", "Save, Export, Configure"],
    ["Ghost", "Transparent, muted text", "Cancel, Reset, View Details"],
    ["Danger", "Red tinted bg, red text, red border", "Kill Switch, Stop, Delete"],
  ],
  [1800, 4200, 3360]
));
children.push(p(""));
children.push(bullet("All buttons: height 36px, border-radius 6px, font-weight 600, transition 0.2s"));
children.push(bullet(":active state: transform scale(0.97) for tactile press feel"));
children.push(bullet("Primary hover: translateY(-1px) + stronger glow shadow"));

children.push(h2("7.4 Form Controls"));
children.push(p("Every input, select, and dropdown should follow one pattern:"));
children.push(bullet("Height: 36px, padding: 0 12px, border-radius: 8px"));
children.push(bullet("Background: var(--bg-elevated) #1a2235, border: 1px solid rgba(255,255,255,0.08)"));
children.push(bullet("Focus: border-color var(--accent-primary), box-shadow 0 0 0 3px rgba(0,214,143,0.15)"));
children.push(bullet("Replace native <select> with custom dropdowns using consistent styling"));
children.push(bullet("Custom checkboxes: 16x16px, rounded 4px, checked = blue-500 fill with white checkmark"));

children.push(h2("7.5 Data Cards (Best Trades)"));
children.push(p("The most impactful visual component. Recommendations:"));
children.push(bullet("Card: border-radius 16px, padding 20px, shadow-sm default, shadow-lg on hover"));
children.push(bullet("Hover: translateY(-2px), increased shadow, border-color brightens"));
children.push(bullet("Header: asset name + direction badge, separated by bottom border"));
children.push(bullet("Direction badges: pill-shaped, tinted background (green for long, red for short)"));
children.push(bullet("Market quality badge: 28x28px square, rounded 6px, tinted background"));
children.push(bullet("SPOT/PERPS toggle: pill-shaped segmented control in surface-3 container"));
children.push(bullet("Stat rows: separated by subtle 1px borders, label left (tertiary), value right (primary)"));

children.push(h2("7.6 Probability Arc Gauges"));
children.push(p("High-impact visual component. Premium treatment:"));
children.push(bullet("Stroke-width: 6px (thicker than current), stroke-linecap: round"));
children.push(bullet("Add filter: drop-shadow(0 0 6px currentColor) on the fill arc"));
children.push(bullet("Track background: rgba(255,255,255,0.05)"));
children.push(bullet("Animate stroke-dashoffset on mount so arc sweeps in"));
children.push(bullet("Center: percentage number (22px, weight 800) + small 'PROB' label underneath"));
children.push(bullet("Three-stop gradient: red #ff6b6b (0-33%) / amber #f0b232 (34-66%) / green #00d68f (67-100%)"));

children.push(h2("7.7 Stat Boxes"));
children.push(p("For Market Intel top cards, Backtester metrics, etc:"));
children.push(bullet("Card: surface-1, border-radius 12px, padding 16px, min-width 140px"));
children.push(bullet("Label: 11px, uppercase, letter-spacing 0.06em, text-tertiary color"));
children.push(bullet("Value: 20px, weight 700, tabular-nums, text-primary color"));
children.push(bullet("Funding rates: replace full colored backgrounds with left-border accent (3px solid)"));
children.push(bullet("Add tiny trend arrow (up/down chevron) next to value for dynamic metrics"));

children.push(h2("7.8 Tables"));
children.push(bullet("Sticky headers: position sticky, surface-1 background, z-index 1"));
children.push(bullet("Header cells: 11px, uppercase, letter-spacing 0.06em, text-tertiary"));
children.push(bullet("Row hover: background var(--bg-elevated) with fast transition"));
children.push(bullet("All numeric columns: font-variant-numeric tabular-nums"));
children.push(bullet("Replace emoji rank medals with styled number pills (gold/silver/bronze tinted)"));

children.push(h2("7.9 Status Indicators"));
children.push(bullet("Wrap dot + text in a subtle tinted pill badge"));
children.push(bullet("Connected: green dot with pulsing ring animation + 'Connected' text"));
children.push(bullet("Disconnected: static red dot, no pulse + 'Disconnected' text"));
children.push(bullet("Status dot: 8px diameter, border-radius 50%, box-shadow glow"));

children.push(h2("7.10 Empty States"));
children.push(p("Current 'No alerts yet' is plain text. Standardize:"));
children.push(bullet("Center layout: icon (32px, rgba 0.15 opacity) + title (16px, medium) + description (13px, tertiary)"));
children.push(bullet("Optional CTA button below"));
children.push(bullet("Padding: 48px vertical, 24px horizontal"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 8: MICRO-INTERACTIONS
// ═══════════════════════════════════════════
children.push(h1("8. Micro-Interactions & Animations"));

children.push(h2("8.1 Transition Standards"));
children.push(makeTable(
  ["Token", "Value", "Usage"],
  [
    ["--ease-out", "cubic-bezier(0.16, 1, 0.3, 1)", "Most transitions"],
    ["--ease-spring", "cubic-bezier(0.34, 1.56, 0.64, 1)", "Card transforms, bouncy feedback"],
    ["--duration-fast", "120ms", "Color changes, border transitions"],
    ["--duration-normal", "200ms", "Transform, shadow transitions"],
    ["--duration-slow", "350ms", "Gauge fills, content reveals"],
  ],
  [2400, 3600, 3360]
));
children.push(p(""));

children.push(h2("8.2 Card Hover"));
children.push(code("transform: translateY(-2px);  /* max -2px, anything more feels exaggerated */"));
children.push(code("box-shadow: shadow-lg;"));
children.push(code("border-color: var(--border-default);"));
children.push(code(":active { transform: translateY(0) scale(0.99); }  /* press down effect */"));

children.push(h2("8.3 Live Data Pulse"));
children.push(p("When real-time values update, flash the accent color then fade to normal:"));
children.push(code("@keyframes value-update { 0% { color: #00d68f; } 100% { color: #e2e8f0; } }"));
children.push(code("animation: value-update 1.2s ease;"));

children.push(h2("8.4 Status Dot Pulse"));
children.push(code("@keyframes pulse-live { 0%,100% { opacity:1 } 50% { opacity:0.4 } }"));
children.push(code("animation: pulse-live 2s ease-in-out infinite;"));

children.push(h2("8.5 Loading States"));
children.push(p("Replace spinning loaders with skeleton shimmer cards. Spinners feel slow; skeletons feel fast."));
children.push(code("background: linear-gradient(90deg, surface-2 25%, surface-3 50%, surface-2 75%);"));
children.push(code("background-size: 200% 100%;"));
children.push(code("animation: shimmer 1.5s ease-in-out infinite;"));

children.push(h2("8.6 Tab Content Transitions"));
children.push(code("/* Fade + slide in from below */"));
children.push(code("opacity: 0 -> 1; transform: translateY(4px) -> translateY(0);"));
children.push(code("transition: 0.2s ease;"));

children.push(h2("8.7 Per-Tab Recommendations"));
children.push(bullet("Degen Scanner: Replace loading spinner with skeleton shimmer cards"));
children.push(bullet("Market Intel: Fear & Greed gauge should have smooth needle transition, not jumps"));
children.push(bullet("Best Trades: Cards scale(1.02) on hover to indicate interactivity"));
children.push(bullet("Live Trading: Kill Switch button continuous glow pulse"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 9: ICONS
// ═══════════════════════════════════════════
children.push(h1("9. Icons & Emoji Replacement"));
children.push(p("Current: heavy emoji usage in section headers and tabs. Emoji render differently across OS/browsers, are visually heavy, and look informal in a trading context. No serious platform uses emoji in their UI."));
children.push(h2("9.1 Recommended: Lucide Icons"));
children.push(p("24x24 SVG, 1.5px stroke weight, MIT licensed, full fintech coverage."));
children.push(makeTable(
  ["Current Emoji", "Lucide Replacement", "Context"],
  [
    ["Target/crosshair emoji", "Target / Crosshair", "Trade signals"],
    ["Chart emoji", "BarChart3", "Analytics sections"],
    ["Brain emoji", "Brain / Sparkles", "AI/prediction sections"],
    ["Bell emoji", "Bell", "Alerts"],
    ["Shield emoji", "Shield / ShieldCheck", "Risk management"],
    ["Activity emoji", "Activity / Zap", "Live data, trading"],
    ["Trending emoji", "TrendingUp / TrendingDown", "Directional indicators"],
    ["Dice emoji", "Dices / Percent", "Predictions"],
    ["Paper emoji", "FileText", "Paper trading"],
    ["Settings emoji", "Settings / Sliders", "Configuration"],
  ],
  [2400, 3200, 3760]
));
children.push(p(""));
children.push(h2("9.2 Icon Styling Rules"));
children.push(bullet("Icons match adjacent label text color (never bright accent)"));
children.push(bullet("Size: 16x16px for inline, 20x20px for section headers"));
children.push(bullet("Stroke: 1.5px, color var(--text-tertiary)"));
children.push(bullet("Only active/selected section icon gets accent color"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 10: DESIGN SYSTEM RULES
// ═══════════════════════════════════════════
children.push(h1("10. Design System Rules (Non-Negotiable)"));

children.push(h2("Rule 1: Surface Hierarchy"));
children.push(p("Every element belongs to one of 4 surface levels (0-3). Never skip a level. A card on surface-0 is surface-1. A nested element inside that card is surface-2."));

children.push(h2("Rule 2: One Primary Action Per View"));
children.push(p("Each tab should have exactly one primary green button. Everything else is secondary or ghost. If a tab has three green buttons, it has no hierarchy."));

children.push(h2("Rule 3: Consistent Empty States"));
children.push(p("Every empty state follows the same pattern: center icon + title + description + optional CTA."));

children.push(h2("Rule 4: Input Styling"));
children.push(p("Every input, select, and dropdown follows one pattern. No native browser controls."));

children.push(h2("Rule 5: Scrollbar Styling"));
children.push(p("Dark dashboards with default light scrollbars look broken. Custom scrollbars: 6px width, rgba(255,255,255,0.1) thumb, transparent track."));

children.push(h2("Rule 6: Number Formatting"));
children.push(p("All numeric values use font-variant-numeric: tabular-nums. Positive = green, negative = red, neutral = white. Always."));

children.push(h2("Rule 7: Section Anatomy"));
children.push(p("Every section: section-header (title + optional actions on right) then section-content. No exceptions."));

children.push(h2("Rule 8: Remove Per-Tab Color Coding"));
children.push(p("Use one active color (primary green), one inactive color (gray). Tabs should not each have their own accent."));

children.push(h2("Rule 9: No-Trade = Gray, Not Red"));
children.push(p("Red means danger/error/loss. 'No Trade' means 'skip this' -- it should be the most visually recessive badge, not alarming."));

children.push(h2("Rule 10: Gradient Discipline"));
children.push(p("Gradients on primary CTA buttons and chart fills only. Flat colors everywhere else."));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 11: SHADOW SYSTEM
// ═══════════════════════════════════════════
children.push(h1("11. Shadow System"));
children.push(makeTable(
  ["Token", "Value", "Usage"],
  [
    ["--shadow-xs", "0 1px 2px rgba(0,0,0,0.3)", "Subtle depth, inactive cards"],
    ["--shadow-sm", "0 2px 4px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.2)", "Default card depth"],
    ["--shadow-md", "0 4px 12px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.25)", "Elevated cards, active states"],
    ["--shadow-lg", "0 8px 24px rgba(0,0,0,0.45), 0 4px 8px rgba(0,0,0,0.3)", "Hover states, modals"],
    ["--shadow-xl", "0 16px 48px rgba(0,0,0,0.5), 0 8px 16px rgba(0,0,0,0.35)", "Popovers, overlays"],
    ["--shadow-glow-green", "0 0 20px rgba(0,255,136,0.15)", "Active primary buttons"],
    ["--shadow-glow-red", "0 0 20px rgba(255,68,68,0.15)", "Danger buttons, kill switch"],
    ["--shadow-inset", "inset 0 1px 3px rgba(0,0,0,0.3)", "Input fields"],
  ],
  [2600, 4800, 1960]
));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 12: IMPLEMENTATION PRIORITY
// ═══════════════════════════════════════════
children.push(h1("12. Implementation Priority"));
children.push(p("If implementing incrementally, this order yields the most visual impact per change:"));

children.push(makeTable(
  ["Priority", "Change", "Impact"],
  [
    ["1", "CSS custom properties -- define all variables in :root", "Foundation for everything"],
    ["2", "Typography -- load Inter + JetBrains Mono, apply font rules", "Immediate premium feel"],
    ["3", "Card styling -- new surfaces, border-radius, box-shadow", "Kills wireframe look"],
    ["4", "Spacing standardization -- consistent spacing scale", "Eliminates cramped feeling"],
    ["5", "Tab bar redesign -- uniform active state", "Stops 'each tab is different app' feel"],
    ["6", "Button hierarchy -- 4-tier button system", "Creates clear action hierarchy"],
    ["7", "Color consolidation -- remove pink/magenta, enforce 5-color palette", "Visual coherence"],
    ["8", "Input styling -- consistent form controls", "Professional consistency"],
    ["9", "Replace emoji with Lucide SVG icons", "Professional, consistent icons"],
    ["10", "Micro-interactions -- transitions, hover states, skeletons", "Premium polish"],
    ["11", "Scrollbar + number formatting polish", "Finishing touches"],
  ],
  [1200, 5200, 2960]
));
children.push(p(""));
children.push(p("The single highest-impact change is items 1-3 together. Those three alone will transform the dashboard from 'developer prototype' to 'professional trading platform'.", { bold: true }));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 13: REFERENCE PLATFORMS
// ═══════════════════════════════════════════
children.push(h1("13. Reference Platforms"));
children.push(p("Modern trading/fintech platforms to reference for each component:"));
children.push(makeTable(
  ["Component", "Reference Platform", "What They Do Well"],
  [
    ["Tab navigation", "Linear, Vercel", "Contained pill nav, subtle active states"],
    ["Data tables", "TradingView, Stripe", "Sticky headers, row hover, number alignment"],
    ["Stat cards", "CoinGecko, Dune Analytics", "Clean label+value hierarchy, trend indicators"],
    ["Trade cards", "Robinhood, Phantom Wallet", "Card hover, clean info hierarchy"],
    ["Gauges/scores", "Gauntlet, Messari", "Ring gauges with glow, clean scoring"],
    ["Input/form styling", "Raycast, Arc browser", "Consistent dark inputs with focus rings"],
    ["Status indicators", "Vercel, Railway", "Pulsing dots in tinted pill badges"],
    ["Alert config", "Grafana, PagerDuty", "Channel cards with service branding"],
    ["Wallet/security", "Phantom, MetaMask, Ledger", "Lock/shield iconography, deliberate layout"],
    ["Button system", "Linear, Stripe", "Tiered hierarchy, hover lift, press feedback"],
    ["Color palette", "dYdX, Bybit", "Restricted palette, blue-tinted darks"],
    ["Overall aesthetic", "TradingView dark + dYdX", "Data-dense but visually clean"],
  ],
  [2200, 3200, 3960]
));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 14: MOBILE CONSIDERATIONS
// ═══════════════════════════════════════════
children.push(h1("14. Mobile Responsiveness"));
children.push(h2("14.1 Tab Navigation"));
children.push(bullet("Horizontal scroll with hidden scrollbars on mobile"));
children.push(bullet("-webkit-overflow-scrolling: touch for momentum scrolling"));

children.push(h2("14.2 Grid Breakpoints"));
children.push(bullet("Stat boxes: 2-column grid on tablet (768px), 1-column on phone (480px)"));
children.push(bullet("Trade cards: single column stack on mobile (640px)"));
children.push(bullet("Tables: horizontal scroll wrapper with border-radius"));

children.push(h2("14.3 Touch Targets"));
children.push(p("All interactive elements must be minimum 44px height on mobile (Apple HIG standard):"));
children.push(bullet("Buttons: height 44px, min-width 44px"));
children.push(bullet("Inputs/selects: height 44px"));
children.push(bullet("Tab items: padding increased to 12px 16px"));
children.push(pb());

// ═══════════════════════════════════════════
// CHAPTER 15: CSS VARIABLES MASTER LIST
// ═══════════════════════════════════════════
children.push(h1("15. CSS Variables Master Reference"));
children.push(p("Complete :root variable set for implementation:"));
children.push(p(""));
children.push(code(":root {"));
children.push(code("  /* Colors */"));
children.push(code("  --accent-primary: #00d68f;"));
children.push(code("  --accent-primary-dim: rgba(0, 214, 143, 0.15);"));
children.push(code("  --color-loss: #ff6b6b;"));
children.push(code("  --color-warning: #f0b232;"));
children.push(code("  --color-info: #5b8def;"));
children.push(code("  --color-neutral: #8b95a5;"));
children.push(code(""));
children.push(code("  /* Surfaces */"));
children.push(code("  --bg-base: #0a0e17;"));
children.push(code("  --bg-surface: #111827;"));
children.push(code("  --bg-elevated: #1a2235;"));
children.push(code("  --bg-hover: #222d42;"));
children.push(code(""));
children.push(code("  /* Text */"));
children.push(code("  --text-primary: #e2e8f0;"));
children.push(code("  --text-secondary: #94a3b8;"));
children.push(code("  --text-tertiary: #64748b;"));
children.push(code("  --text-disabled: #475569;"));
children.push(code(""));
children.push(code("  /* Borders */"));
children.push(code("  --border-subtle: rgba(255,255,255,0.06);"));
children.push(code("  --border-default: rgba(255,255,255,0.10);"));
children.push(code("  --border-strong: rgba(255,255,255,0.16);"));
children.push(code(""));
children.push(code("  /* Radius */"));
children.push(code("  --radius-xs: 4px;  --radius-sm: 6px;  --radius-md: 8px;"));
children.push(code("  --radius-lg: 12px; --radius-xl: 16px; --radius-pill: 20px;"));
children.push(code("  --radius-full: 9999px;"));
children.push(code(""));
children.push(code("  /* Spacing */"));
children.push(code("  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;"));
children.push(code("  --space-4: 16px; --space-5: 20px; --space-6: 24px;"));
children.push(code("  --space-7: 32px; --space-8: 48px; --space-9: 64px;"));
children.push(code(""));
children.push(code("  /* Typography */"));
children.push(code("  --font-ui: 'Inter', -apple-system, sans-serif;"));
children.push(code("  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;"));
children.push(code("  --text-xs: 11px; --text-sm: 13px; --text-base: 14px;"));
children.push(code("  --text-lg: 16px; --text-xl: 20px; --text-2xl: 24px;"));
children.push(code(""));
children.push(code("  /* Transitions */"));
children.push(code("  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);"));
children.push(code("  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);"));
children.push(code("  --duration-fast: 120ms;"));
children.push(code("  --duration-normal: 200ms;"));
children.push(code("  --duration-slow: 350ms;"));
children.push(code("}"));

// ═══════════════════════════════════════════
// Build & save
// ═══════════════════════════════════════════
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: "00d68f" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: "e2e8f0" },
        paragraph: { spacing: { before: 300, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: "94a3b8" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }
      ] }
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, children: [
          new TextRun({ text: "Dashboard Ultimate -- UI/UX Design Guide", size: 18, font: "Arial", color: "64748b" })
        ] })
      ] })
    },
    footers: {
      default: new Footer({ children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new TextRun({ text: "Page ", size: 18, font: "Arial", color: "64748b" }),
          new TextRun({ children: [PageNumber.CURRENT], size: 18, font: "Arial", color: "64748b" }),
        ] })
      ] })
    },
    children
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "C:/Users/jjkat/OneDrive/Desktop/AI Projects/Dashboard ultimate/Dashboard_Design_Guide.docx";
  fs.writeFileSync(out, buf);
  console.log(`Written ${(buf.length/1024).toFixed(0)} KB to ${out}`);
});
