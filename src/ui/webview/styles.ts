/**
 * The panel stylesheet, and a way to wear it outside VSCode.
 *
 * The React app is written against VSCode's theme variables, which is right:
 * inside the editor it inherits whatever theme you use. A browser defines none
 * of them, so the same components would render as unstyled HTML. Rather than
 * fork the CSS, `BROWSER_THEME` supplies the variables the app asks for, in
 * light and dark, so one stylesheet serves both hosts.
 */

export const STYLES = /* css */ `
  :root { color-scheme: light dark; }
  /*
   * Chart series and status colors. Validated (CVD + contrast, dataviz
   * six-checks) against white and #0f172a surfaces — which is why they are
   * fixed hexes rather than theme variables: an editor theme's palette makes
   * no colorblind-safety promises. Dark steps are selected, not a flip:
   * VS Code stamps body.vscode-dark; the browser shell stamps :root.dark.
   */
  :root {
    --viz-1: #4f46e5;
    --viz-2: #eb6834;
    --viz-3: #1baf7a;
    --viz-good: #0ca30c;
    --viz-warn: #fab219;
    --viz-serious: #ec835a;
    --viz-crit: #d03b3b;
  }
  body.vscode-dark, body.vscode-high-contrast {
    --viz-1: #6366f1;
    --viz-2: #d95926;
    --viz-3: #199e70;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  h2, h3 { font-weight: 600; margin: 4px 0 8px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .row { display: flex; gap: 6px; align-items: center; }
  .col { display: flex; flex-direction: column; gap: 6px; }
  .wrap { flex-wrap: wrap; }
  .spread { justify-content: space-between; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 0.85em; }
  input[type=text], input[type=search], select {
    width: 100%;
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  label.check { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--vscode-focusBorder); width: 14px; height: 14px; }
  /* Card grid: as many columns as the width honestly fits; one in a panel. */
  .grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
                gap: 10px; align-items: start; }
  .grid-cards > .card { margin-bottom: 0; height: 100%; }
  /* One row of controls above content: search box grows, button does not. */
  .toolbar { display: flex; gap: 6px; align-items: center; }
  .toolbar input { flex: 1; }
  /* Filters sit in one wrapping row and size to their content. */
  .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .filters select { width: auto; }
  a.danger { color: var(--vscode-errorForeground); }
  button {
    padding: 4px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .card.active { border-color: var(--vscode-focusBorder); }
  .badge {
    display: inline-block;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.8em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .tag {
    display: inline-block;
    padding: 0 5px;
    margin: 2px 2px 0 0;
    border-radius: 4px;
    font-size: 0.78em;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.15));
    color: var(--vscode-descriptionForeground);
  }
  .bar { height: 6px; border-radius: 3px; background: rgba(128,128,128,0.25); overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  pre.snippet {
    white-space: pre-wrap;
    word-break: break-all;
    padding: 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
  .empty { padding: 24px 8px; text-align: center; }
  .divider { height: 1px; background: var(--vscode-panel-border, rgba(128,128,128,0.25)); margin: 10px 0; }
`

/**
 * The desktop/browser theme: semantic design tokens, worn by VSCode variables.
 *
 * The React app is written against VSCode's theme variables and must stay
 * that way — inside the editor it inherits whatever theme you use. Outside
 * the editor we want the app-base design instead (indigo accent, deep-navy
 * rail, soft cards, light/dark via a \`.dark\` class on <html>), so the
 * semantic tokens are defined first and every \`--vscode-*\` variable the app
 * asks for is mapped onto them. One stylesheet, two skins, no fork.
 *
 * Dark mode is a class rather than a media query because the shell offers a
 * toggle; \`THEME_INIT_JS\` applies the persisted (or system) choice before
 * first paint.
 */
export const BROWSER_THEME = /* css */ `
  :root {
    /* One theme at a time: with "light dark" the UA styles any control the
       stylesheet missed for the OS preference, which put dark inputs on a
       light page. The .dark class is the only switch. */
    color-scheme: light;

    /* -- semantic tokens (light) ------------------------------------- */
    --bg: #f7f8fc;
    --surface: #ffffff;
    --surface-2: #eef2ff;
    --fg: #111827;
    --muted: #6b7280;
    --border: #e6e8ef;
    --hover: #f3f6fb;
    --accent: #4f46e5;
    --accent-fg: #ffffff;
    --chip: #eef2ff;
    --chip-fg: #4338ca;
    --success: #15803d;
    --error: #b91c1c;
    --warning: #b45309;
    /* Deep navy left rail, the same in both themes. */
    --sidebar: #101f4f;
    --sidebar-fg: #c7d2fe;

    /* -- fonts -------------------------------------------------------- */
    --vscode-font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, monospace;

    /* -- what the panel app asks for, answered by the tokens ---------- */
    --vscode-foreground: var(--fg);
    --vscode-descriptionForeground: var(--muted);
    --vscode-errorForeground: var(--error);
    --vscode-textLink-foreground: var(--accent);
    --vscode-focusBorder: var(--accent);
    --vscode-panel-border: var(--border);
    --vscode-editorWidget-border: var(--border);
    --vscode-editorWidget-background: var(--surface-2);
    --vscode-textCodeBlock-background: color-mix(in srgb, var(--fg) 6%, transparent);

    --vscode-input-foreground: var(--fg);
    --vscode-input-background: var(--surface);
    --vscode-input-border: var(--border);

    --vscode-button-foreground: var(--accent-fg);
    --vscode-button-background: var(--accent);
    --vscode-button-hoverBackground: color-mix(in srgb, var(--accent) 88%, #ffffff);
    --vscode-button-secondaryForeground: var(--fg);
    --vscode-button-secondaryBackground: var(--surface);
    --vscode-button-secondaryHoverBackground: var(--hover);

    --vscode-badge-background: var(--chip);
    --vscode-badge-foreground: var(--chip-fg);
    --vscode-progressBar-background: var(--accent);
    --vscode-charts-blue: var(--accent);
    --vscode-editorWarning-foreground: var(--warning);
    --vscode-testing-iconPassed: var(--success);

    /* Not a VSCode variable: the page chrome around the panel content. */
    --page-background: var(--bg);
    --page-elevated: var(--surface);
  }

  :root.dark {
    color-scheme: dark;
    --viz-1: #6366f1;
    --viz-2: #d95926;
    --viz-3: #199e70;
    --bg: #070b14;
    --surface: #0f172a;
    --surface-2: #111c34;
    --fg: #edf2f7;
    --muted: #9aa8bd;
    --border: #22304a;
    --hover: #17233a;
    --accent: #818cf8;
    --accent-fg: #ffffff;
    --chip: #1e2a44;
    --chip-fg: #c7d2fe;
    --success: #4ade80;
    --error: #f87171;
    --warning: #fbbf24;
    --sidebar: #070d1f;
    --sidebar-fg: #a8b5d8;
  }

  ::selection { background: color-mix(in srgb, var(--accent) 22%, transparent); }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`

/**
 * Applies the persisted theme (or the system preference) before first paint,
 * so a dark-mode user never sees a white flash. Inline this in <head>.
 */
export const THEME_INIT_JS = /* js */ `
  (function () {
    var stored = null;
    try { stored = localStorage.getItem('mlx-theme'); } catch (e) {}
    var dark = stored ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  })();
`

/**
 * The design's component skin, layered over STYLES for non-VSCode hosts only.
 *
 * The panel CSS above stays editor-shaped (small radii, theme-variable
 * colors) because it also renders inside VS Code webviews. These overrides
 * restyle the same class names — rounded-xl controls, soft-shadowed cards,
 * pill chips — and ship only in the pages the daemon serves, so the editor
 * panels keep their native look.
 */
export const BROWSER_UI = /* css */ `
  body {
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 10%, transparent), transparent 32rem),
      var(--bg);
    color: var(--fg);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 12px;
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 600;
    background: var(--accent);
    color: var(--accent-fg);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--accent) 20%, transparent);
    transition: filter 0.15s, background 0.15s, border-color 0.15s, transform 0.05s;
  }
  button:hover { background: var(--accent); filter: brightness(1.1); }
  button:active { transform: translateY(1px); }
  button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);
  }
  button.secondary {
    background: color-mix(in srgb, var(--surface) 90%, transparent);
    color: var(--fg);
    border: 1px solid var(--border);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
  }
  button.secondary:hover {
    background: var(--hover);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
    filter: none;
  }
  button:disabled { opacity: 0.5; transform: none; filter: none; }

  input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea {
    border-radius: 12px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 90%, transparent);
    color: var(--fg);
    padding: 7px 12px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:not([type=checkbox]):not([type=radio]):not([type=range]):hover, select:hover, textarea:hover {
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .card {
    border-radius: 16px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 90%, transparent);
    padding: 16px 20px;
    margin-bottom: 12px;
    box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
    backdrop-filter: blur(8px);
  }
  .card.active { border-color: var(--accent); }

  .badge {
    border-radius: 999px;
    padding: 1px 10px;
    font-weight: 600;
    border: 1px solid color-mix(in srgb, var(--accent) 10%, transparent);
    background: var(--chip);
    color: var(--chip-fg);
  }
  .tag {
    border-radius: 999px;
    padding: 0 8px;
    background: var(--chip);
    color: var(--chip-fg);
  }
  .bar { background: color-mix(in srgb, var(--fg) 12%, transparent); }
  pre.snippet { border-radius: 12px; }
  .divider { background: var(--border); }
`
