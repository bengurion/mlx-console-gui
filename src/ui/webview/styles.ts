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
 * VSCode's theme variables, approximated for a browser.
 *
 * Values follow Dark+ and Light+ so the dashboard looks like the panel it
 * mirrors rather than like a different application. Dark is chosen by the
 * system preference; nothing here needs JavaScript.
 */
export const BROWSER_THEME = /* css */ `
  :root {
    --vscode-font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, monospace;

    --vscode-foreground: #3b3b3b;
    --vscode-descriptionForeground: #61616c;
    --vscode-errorForeground: #e51400;
    --vscode-textLink-foreground: #005fb8;
    --vscode-focusBorder: #005fb8;
    --vscode-panel-border: rgba(0, 0, 0, 0.12);
    --vscode-editorWidget-border: rgba(0, 0, 0, 0.12);
    --vscode-editorWidget-background: #f8f8f8;
    --vscode-textCodeBlock-background: rgba(0, 0, 0, 0.05);

    --vscode-input-foreground: #3b3b3b;
    --vscode-input-background: #ffffff;
    --vscode-input-border: rgba(0, 0, 0, 0.16);

    --vscode-button-foreground: #ffffff;
    --vscode-button-background: #005fb8;
    --vscode-button-hoverBackground: #0258a8;
    --vscode-button-secondaryForeground: #3b3b3b;
    --vscode-button-secondaryBackground: #e5e5e5;
    --vscode-button-secondaryHoverBackground: #cccccc;

    --vscode-badge-background: #cccccc;
    --vscode-badge-foreground: #3b3b3b;
    --vscode-progressBar-background: #005fb8;
    --vscode-charts-blue: #1a85ff;
    --vscode-editorWarning-foreground: #bf8803;
    --vscode-testing-iconPassed: #1a7f37;

    /* Not a VSCode variable: the page chrome around the panel content. */
    --page-background: #ffffff;
    --page-elevated: #f3f3f3;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --vscode-foreground: #cccccc;
      --vscode-descriptionForeground: #9d9d9d;
      --vscode-errorForeground: #f85149;
      --vscode-textLink-foreground: #4daafc;
      --vscode-focusBorder: #0078d4;
      --vscode-panel-border: rgba(255, 255, 255, 0.14);
      --vscode-editorWidget-border: rgba(255, 255, 255, 0.14);
      --vscode-editorWidget-background: #252526;
      --vscode-textCodeBlock-background: rgba(255, 255, 255, 0.06);

      --vscode-input-foreground: #cccccc;
      --vscode-input-background: #313131;
      --vscode-input-border: rgba(255, 255, 255, 0.18);

      --vscode-button-foreground: #ffffff;
      --vscode-button-background: #0078d4;
      --vscode-button-hoverBackground: #026ec1;
      --vscode-button-secondaryForeground: #cccccc;
      --vscode-button-secondaryBackground: #313131;
      --vscode-button-secondaryHoverBackground: #3c3c3c;

      --vscode-badge-background: #616161;
      --vscode-badge-foreground: #f8f8f8;
      --vscode-progressBar-background: #0078d4;
      --vscode-charts-blue: #3794ff;
      --vscode-editorWarning-foreground: #cca700;
      --vscode-testing-iconPassed: #3fb950;

      --page-background: #1f1f1f;
      --page-elevated: #181818;
    }
  }
`
