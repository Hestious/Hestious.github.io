/* Shared by imported lecture notes. MathJax itself is bundled during the build. */
window.MathJax = {
  loader: { load: ['[tex]/physics', '[tex]/mathtools', '[tex]/unicode', 'ui/safe'] },
  tex: {
    inlineMath: [['\\(', '\\)'], ['$', '$']],
    displayMath: [['\\[', '\\]'], ['$$', '$$']],
    packages: { '[+]': ['physics', 'mathtools', 'unicode'], '[-]': ['noundefined'] },
    macros: { mathds: ['\\mathbb{#1}', 1] },
    tags: 'ams',
    processEscapes: true,
    maxBuffer: 65536,
    maxMacros: 10000
  },
  svg: { fontCache: 'local' },
  options: {
    safeOptions: {
      allow: { URLs: 'safe', classes: 'safe', cssIDs: 'safe', styles: 'safe' },
      safeProtocols: { http: true, https: true, file: false, javascript: false, data: false }
    }
  },
  startup: {
    ready() {
      MathJax.startup.defaultReady();
      MathJax.startup.input[0].preFilters.add(({math}) => {
        // MathJax's TeX font has double-struck letters but no double-struck
        // digits. Keep dsfont identity operators as their actual Unicode glyphs.
        math.math = math.math.replace(/\\mathds\s*(?:\{\s*([0-9]+)\s*\}|([0-9]))/g, (_, braced, digit) =>
          '{' + [...(braced || digit)].map(value => '\\unicode{x' + (0x1D7D8 + Number(value)).toString(16) + '}').join('') + '}');
      });
    },
    pageReady() {
      return MathJax.startup.defaultPageReady().then(() => {
        const status = document.getElementById('math-status');
        if (status) {
          const failed = document.querySelector('mjx-merror, [data-mjx-error]');
          status.textContent = failed
            ? 'Some formulas could not be rendered. Review the highlighted expressions against your LaTeX source.'
            : 'Formulas rendered.';
          status.hidden = !failed;
        }
      }).catch((error) => {
        const status = document.getElementById('math-status');
        if (status) { status.hidden = false; status.textContent = 'Formula rendering failed. The original TeX is shown where available; please reload or check the source.'; }
        console.error('Math rendering failed', error);
      });
    }
  }
};
window.addEventListener('error', (event) => {
  if (event.target?.tagName === 'SCRIPT' && /mathjax/i.test(event.target.src || '')) {
    const status = document.getElementById('math-status');
    if (status) { status.hidden = false; status.textContent = 'The formula renderer could not load. Please reload this page.'; }
  }
}, true);
