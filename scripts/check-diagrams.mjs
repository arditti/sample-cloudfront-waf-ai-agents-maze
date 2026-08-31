// AI Maze — static checks for the mermaid diagrams in the docs.
//
//   node scripts/check-diagrams.mjs
//
// Rendering is not correctness. A diagram where the same node id is given two
// different labels renders perfectly and means something else entirely: this repo
// shipped one where `W` was both "AWS WAF ordered detection" and the beacon node, so
// an edge drawn to the beacons actually pointed at the WAF box, and `M` was both the
// model-validation step and the dashboard. Mermaid has no reason to complain, and a
// render check never will.
//
// So these are the checks a render cannot make. To also confirm the diagrams draw,
// pipe each block through @mermaid-js/mermaid-cli — that needs a browser, which is why
// it is not done here.
//
// Exits non-zero on any finding.

import { readFileSync } from 'node:fs';

const FILES = ['README.md'];

// `id[label]`, `id{label}`, `id(label)` — the forms used in these docs.
const NODE = /(?<![\w"])([A-Za-z][A-Za-z0-9_]*)\s*[[{(]+\s*"?(.*?)"?\s*[\]})]+/g;
// Edges, once their labels are out of the way. Matching them WITH labels in place is
// how a first version of this reported `No`, `block` and `text/*` as undeclared nodes:
// the words inside `-- No -->` and `|"text"|` look exactly like node ids.
const EDGE = /(?<![\w"])([A-Za-z][A-Za-z0-9_]*)\s*(?:-->|-\.->|==>)\s*([A-Za-z][A-Za-z0-9_]*)/g;

/** Strip edge labels so only `ID --> ID` pairs remain. */
function withoutEdgeLabels(block) {
  return block
    .replace(/\|[^|]*\|/g, ' ')                 // -->|"label"|
    .replace(/--\s*[^->][^>]*?\s*-->/g, ' --> ') // -- label -->
    .replace(/-\.\s*[^->]*?\s*\.->/g, ' -.-> '); // -. label .->
}

/** Entities legitimately contain ';' — &lt; and &gt; are how a label shows brackets. */
function withoutEntities(label) {
  return label.replace(/&[a-zA-Z]+;|&#\d+;/g, '');
}

let findings = 0;
const fail = (where, msg) => {
  console.error(`FAIL ${where}: ${msg}`);
  findings++;
};

for (const file of FILES) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // a doc that does not exist is not a diagram problem
  }

  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) continue;

  blocks.forEach((block, i) => {
    const where = `${file} diagram ${i}`;
    const labels = new Map();
    for (const m of block.matchAll(NODE)) {
      const [, id, label] = m;
      if (!labels.has(id)) labels.set(id, new Set());
      labels.get(id).add(label.trim());
    }

    // 1. One id, two labels — the bug a render cannot see.
    for (const [id, set] of labels) {
      if (set.size > 1) {
        fail(where, `node id "${id}" is given ${set.size} different labels:\n` +
          [...set].map((l) => `       - ${l}`).join('\n'));
      }
    }

    // 2. An edge naming a node that is never given a label. Mermaid invents an empty
    //    box, which looks like a diagram bug rather than a typo in an id.
    const declared = new Set(labels.keys());
    const KEYWORDS = new Set([
      'flowchart', 'graph', 'subgraph', 'end', 'style', 'classDef', 'class',
      'linkStyle', 'direction', 'LR', 'RL', 'TB', 'BT', 'TD', 'click',
    ]);
    // A subgraph id is declared by `subgraph ID["..."]` and may carry no label.
    const subgraphIds = new Set([...block.matchAll(/subgraph\s+(\w+)/g)].map((m) => m[1]));
    const seen = new Set();
    for (const m of withoutEdgeLabels(block).matchAll(EDGE)) {
      for (const id of [m[1], m[2]]) {
        if (declared.has(id) || KEYWORDS.has(id) || seen.has(id)) continue;
        if (subgraphIds.has(id)) continue;
        seen.add(id);
        fail(where, `edge references "${id}", which is never given a label`);
      }
    }

    // 3. A label containing an unquoted arrow or a semicolon breaks parsing — both
    //    have bitten this repo, and the failure surfaces as a console "Syntax error in
    //    text" rather than anything pointing at the line.
    for (const [id, set] of labels) {
      for (const label of set) {
        if (withoutEntities(label).includes(';')) {
          fail(where, `label for "${id}" contains ';', a mermaid statement separator`);
        }
        if (/--?>/.test(label)) fail(where, `label for "${id}" contains an arrow, which breaks parsing`);
      }
    }
  });

  console.log(`ok   ${file}: ${blocks.length} diagram(s)`);
}

if (findings) {
  console.error(`\n${findings} diagram problem(s)`);
  process.exit(1);
}
console.log('\nall diagrams pass the static checks (ids, edges, labels)');
