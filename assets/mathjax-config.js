/* Shared by imported lecture notes. MathJax itself is bundled during the build. */
window.MathJax = {
  loader: { load: ['[tex]/physics', '[tex]/mathtools', 'ui/safe'] },
  tex: {
    inlineMath: [['\\(', '\\)'], ['$', '$']],
    displayMath: [['\\[', '\\]'], ['$$', '$$']],
    packages: { '[+]': ['physics', 'mathtools'] },
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
