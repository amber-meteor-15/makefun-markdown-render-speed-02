// The harness driver: read every case from the input set, render each one
// on its own with parse() from ./parse.js, and write the HTML strings, in
// the cases' order, as a JSON array. Runs as `node /bot/main.ts` on
// Node 22; outside the grading container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR point at the input and output directories instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
