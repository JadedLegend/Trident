#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) throw new Error('usage: ua-tour-analyze.js <input> <output>');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const layers = data.layers || [];
  const ids = new Set(nodes.map(n => n.id));
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  // Roll function-level endpoints up to their owning file node.
  const roll = (id) => {
    if (ids.has(id)) return id;
    const m = /^(?:function|class|method):(.+?):[^:]+$/.exec(id);
    if (m && ids.has('file:' + m[1])) return 'file:' + m[1];
    return null;
  };

  const structural = new Set(['contains', 'exports']);
  const fileEdges = [];
  const seenE = new Set();
  for (const e of edges) {
    if (structural.has(e.type)) continue;
    const s = roll(e.source), t = roll(e.target);
    if (!s || !t || s === t) continue;
    const key = s + '|' + t + '|' + e.type;
    if (seenE.has(key)) continue;
    seenE.add(key);
    fileEdges.push({ source: s, target: t, type: e.type });
  }

  const inSet = {}, outSet = {};
  for (const n of nodes) { inSet[n.id] = new Set(); outSet[n.id] = new Set(); }
  for (const e of fileEdges) { outSet[e.source].add(e.target); inSet[e.target].add(e.source); }
  const fanIn = id => inSet[id].size, fanOut = id => outSet[id].size;

  const rank = (fn, key) => nodes.map(n => ({ id: n.id, [key]: fn(n.id), name: n.name }))
    .filter(r => r[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 20);
  const fanInRanking = rank(fanIn, 'fanIn');
  const fanOutRanking = rank(fanOut, 'fanOut');

  // Entry points
  const entryNames = new Set(['index.ts','index.js','main.ts','main.js','app.ts','app.js','server.ts','server.js','server.mjs','index.mjs','main.mjs','app.mjs','mod.rs','main.go','main.py','main.rs','manage.py','app.py','wsgi.py','asgi.py','run.py','__main__.py','Application.java','Main.java','Program.cs','config.ru','index.php','App.swift','Application.kt','main.cpp','main.c']);
  const codeNodes = nodes.filter(n => n.type === 'file');
  const outs = codeNodes.map(n => fanOut(n.id)).sort((a, b) => a - b);
  const ins = codeNodes.map(n => fanIn(n.id)).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
  const top10Out = q(outs, 0.9), bottom25In = q(ins, 0.25);
  const candidates = [];
  for (const n of nodes) {
    let score = 0;
    const fp = n.filePath || '';
    const depth = fp.split('/').length - 1;
    if (n.type === 'file') {
      if (entryNames.has(n.name)) score += 3;
      if (depth <= 1) score += 1;
      if (fanOut(n.id) > 0 && fanOut(n.id) >= top10Out) score += 1;
      if (fanIn(n.id) <= bottom25In) score += 1;
    } else if (n.type === 'document') {
      if (depth === 0 && /^readme\.md$/i.test(n.name)) score += 5;
      else if (depth === 0 && /\.md$/i.test(n.name)) score += 2;
    }
    if (score > 0) candidates.push({ id: n.id, score, name: n.name, type: n.type, summary: n.summary });
  }
  candidates.sort((a, b) => b.score - a.score);
  const entryPointCandidates = candidates.slice(0, 5);

  // BFS from top code entry point over imports/calls
  const start = candidates.find(c => c.type === 'file');
  const bfs = { startNode: start ? start.id : null, order: [], depthMap: {}, byDepth: {} };
  if (start) {
    const adj = {};
    for (const e of fileEdges) if (e.type === 'imports' || e.type === 'calls') (adj[e.source] = adj[e.source] || new Set()).add(e.target);
    const queue = [start.id];
    bfs.depthMap[start.id] = 0;
    while (queue.length) {
      const cur = queue.shift();
      bfs.order.push(cur);
      const d = bfs.depthMap[cur];
      (bfs.byDepth[d] = bfs.byDepth[d] || []).push(cur);
      for (const nx of (adj[cur] || [])) if (!(nx in bfs.depthMap)) { bfs.depthMap[nx] = d + 1; queue.push(nx); }
    }
  }

  // Non-code inventory
  const pick = n => ({ id: n.id, name: n.name, type: n.type, summary: n.summary });
  const nonCodeFiles = {
    documentation: nodes.filter(n => n.type === 'document').map(pick),
    infrastructure: nodes.filter(n => ['service', 'pipeline', 'resource'].includes(n.type)).map(pick),
    data: nodes.filter(n => ['table', 'schema', 'endpoint'].includes(n.type)).map(pick),
    config: nodes.filter(n => n.type === 'config').map(pick),
  };

  // Clusters: bidirectional pairs, else strongly connected neighbours, expanded
  const undirected = {};
  const pairCount = {};
  for (const e of fileEdges) {
    const k = [e.source, e.target].sort().join('|');
    pairCount[k] = (pairCount[k] || 0) + 1;
    (undirected[e.source] = undirected[e.source] || new Set()).add(e.target);
    (undirected[e.target] = undirected[e.target] || new Set()).add(e.source);
  }
  const seeds = [];
  for (const e of fileEdges) if ((e.type === 'imports' || e.type === 'calls') && outSet[e.target].has(e.source)) seeds.push([e.source, e.target].sort().join('|'));
  // Fallback seeds: pairs with an import/call edge among code files (strongest pairs first)
  const fallback = Object.entries(pairCount).sort((a, b) => b[1] - a[1]).map(([k]) => k)
    .filter(k => k.split('|').every(id => byId[id].type === 'file'));
  const seedKeys = [...new Set(seeds.length ? seeds : fallback)];
  const clusters = [];
  const used = new Set();
  for (const k of seedKeys) {
    const members = new Set(k.split('|'));
    if ([...members].every(m => used.has(m))) continue;
    let grew = true;
    while (grew && members.size < 5) {
      grew = false;
      for (const n of nodes) {
        if (members.has(n.id) || members.size >= 5) continue;
        let c = 0;
        for (const m of members) if (undirected[n.id] && undirected[n.id].has(m)) c++;
        if (c >= 2) { members.add(n.id); grew = true; }
      }
    }
    const arr = [...members];
    let edgeCount = 0;
    for (const e of fileEdges) if (members.has(e.source) && members.has(e.target)) edgeCount++;
    clusters.push({ nodes: arr, edgeCount });
    arr.forEach(m => used.add(m));
    if (clusters.length >= 10) break;
  }
  clusters.sort((a, b) => b.edgeCount - a.edgeCount);

  const nodeSummaryIndex = {};
  for (const n of nodes) nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary };

  const out = {
    scriptCompleted: true,
    entryPointCandidates, fanInRanking, fanOutRanking, bfsTraversal: bfs, nonCodeFiles,
    clusters,
    layers: { count: layers.length, list: layers.map(l => ({ id: l.id, name: l.name, description: l.description })) },
    nodeSummaryIndex,
    totalNodes: nodes.length, totalEdges: edges.length,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
}

try { main(); process.exit(0); } catch (err) { console.error(err && err.stack || err); process.exit(1); }
