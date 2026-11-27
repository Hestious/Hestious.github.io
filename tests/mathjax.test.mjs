import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
globalThis.window = { addEventListener() {} };
require('../assets/mathjax-config.js');
const config = window.MathJax;
config.loader.load.unshift('input/tex', 'output/svg');
config.startup.typeset = false;
config.startup.pageReady = () => Promise.resolve();
const renderer = await require('mathjax').init(config);
const render = (source) => renderer.startup.adaptor.outerHTML(renderer.tex2svg(source));

test('dsfont identity stays double-struck rather than becoming a plain digit', () => {
  const svg = render(String.raw`(\mathcal{E}\otimes\mathds{1}_B)(\rho)`);
  assert.match(svg, />𝟙<\/text>/u);
  assert.doesNotMatch(svg, /data-mjx-error|mathcolor="red"|\\mathds/);
});

test('dsfont compatibility retains double-struck letters and other digits', () => {
  const svg = render(String.raw`\mathds{C}+\mathds{01}+\mathds1`);
  assert.match(svg, /data-c="2102"/); // Double-struck capital C.
  assert.match(svg, />𝟘<\/text>/u);
  assert.equal((svg.match(/>𝟙<\/text>/gu) || []).length, 2);
  assert.doesNotMatch(svg, /data-mjx-error|mathcolor="red"/);
});

test('unknown commands emit an error marker detected by the visible status', () => {
  const svg = render(String.raw`\unknownImportantCommand{x}`);
  assert.match(svg, /data-mjx-error="Undefined control sequence/);
  assert.doesNotMatch(svg, /mathcolor="red"/);
});
