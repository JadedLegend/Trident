const fs = require('fs');
try {
  const [, , inp, out] = process.argv;
  if (!inp || !out) throw new Error('usage: node ua-arch-analyze.js <input> <output>');
  const d = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const nodes = d.fileNodes || [], imps = d.importEdges || [], all = d.allEdges || [];
  const paths = nodes.map(n => (n.filePath || n.id.replace(/^[a-z]+:/, '')).replace(/\\/g, '/'));

  // A. directory grouping with common prefix
  let pre = null;
  for (const p of paths) {
    const segs = p.split('/').slice(0, -1);
    if (pre === null) pre = segs;
    else { let i = 0; while (i < pre.length && i < segs.length && pre[i] === segs[i]) i++; pre = pre.slice(0, i); }
  }
  pre = pre || [];
  const groupOf = {}, dirGroups = {};
  nodes.forEach((n, i) => {
    const segs = paths[i].split('/').slice(pre.length);
    const g = segs.length > 1 ? segs[0] : 'root';
    groupOf[n.id] = g;
    (dirGroups[g] = dirGroups[g] || []).push(n.id);
  });

  // B. node types
  const typeGroups = {};
  nodes.forEach(n => (typeGroups[n.type] = typeGroups[n.type] || []).push(n.id));
  const typeOf = Object.fromEntries(nodes.map(n => [n.id, n.type]));

  // C/E/F. adjacency, fan in/out, inter/intra group
  const fanIn = {}, fanOut = {}, ig = {}, intra = {};
  for (const g in dirGroups) intra[g] = { internalEdges: 0, totalEdges: 0 };
  for (const e of imps) {
    fanOut[e.source] = (fanOut[e.source] || 0) + 1;
    fanIn[e.target] = (fanIn[e.target] || 0) + 1;
    const a = groupOf[e.source], b = groupOf[e.target];
    if (!a || !b) continue;
    if (a === b) { intra[a].internalEdges++; intra[a].totalEdges++; }
    else { intra[a].totalEdges++; intra[b].totalEdges++; const k = a + '->' + b; ig[k] = (ig[k] || 0) + 1; }
  }
  for (const g in intra) intra[g].density = intra[g].totalEdges ? +(intra[g].internalEdges / intra[g].totalEdges).toFixed(3) : 0;
  const interGroupImports = Object.entries(ig).map(([k, c]) => { const [f, t] = k.split('->'); return { from: f, to: t, count: c }; });

  // D. cross-category
  const cc = {};
  for (const e of all) { const k = `${typeOf[e.source]}|${typeOf[e.target]}|${e.type}`; cc[k] = (cc[k] || 0) + 1; }
  const crossCategoryEdges = Object.entries(cc).map(([k, c]) => { const [f, t, y] = k.split('|'); return { fromType: f, toType: t, edgeType: y, count: c }; });

  // G. patterns
  const pm = {
    api: ['routes', 'api', 'controllers', 'endpoints', 'handlers', 'serializers', 'controller', 'routers', 'blueprints'],
    service: ['services', 'core', 'lib', 'domain', 'logic', 'signals', 'internal', 'composables', 'mailers', 'jobs', 'channels'],
    data: ['models', 'db', 'data', 'persistence', 'repository', 'entities', 'migrations', 'entity', 'sql', 'database', 'schema'],
    ui: ['components', 'views', 'pages', 'ui', 'layouts', 'screens'],
    middleware: ['middleware', 'plugins', 'interceptors', 'guards'],
    utility: ['utils', 'helpers', 'common', 'shared', 'tools', 'templatetags', 'pkg'],
    config: ['config', 'constants', 'env', 'settings', 'management', 'commands'],
    test: ['__tests__', 'test', 'tests', 'spec', 'specs'],
    types: ['types', 'interfaces', 'schemas', 'contracts', 'dtos', 'dto', 'request', 'response'],
    hooks: ['hooks'], state: ['store', 'state', 'reducers', 'actions', 'slices'],
    assets: ['assets', 'static', 'public'], entry: ['cmd', 'bin'],
    documentation: ['docs', 'documentation', 'wiki'],
    infrastructure: ['deploy', 'deployment', 'infra', 'infrastructure', 'k8s', 'kubernetes', 'helm', 'charts', 'terraform', 'tf', 'docker'],
    'ci-cd': ['.github', '.gitlab', '.circleci']
  };
  const patternMatches = {};
  for (const g in dirGroups) for (const [l, ns] of Object.entries(pm)) if (ns.includes(g.toLowerCase())) { patternMatches[g] = l; break; }
  const filePatterns = {};
  nodes.forEach((n, i) => {
    const p = paths[i], b = p.split('/').pop(); let l = null;
    if (/\.(test|spec)\.|^test_.*\.py$|_test\.go$|Test\.java$|_spec\.rb$/.test(b)) l = 'test';
    else if (/\.d\.ts$/.test(b)) l = 'types';
    else if (/^(index\.(ts|js)|__init__\.py)$/.test(b)) l = 'entry';
    else if (/^Dockerfile|^docker-compose|\.tf(vars)?$|^Makefile$/.test(b)) l = 'infrastructure';
    else if (/^\.github\/workflows\//.test(p) || /\.gitlab-ci\.yml$|Jenkinsfile/.test(b)) l = 'ci-cd';
    else if (/\.sql$/.test(b)) l = 'data';
    else if (/\.(graphql|gql|proto)$/.test(b)) l = 'types';
    else if (/\.(md|rst)$/.test(b)) l = 'documentation';
    if (l) filePatterns[n.id] = l;
  });

  // H. deployment
  const infraFiles = paths.filter(p => /(^|\/)(Dockerfile|docker-compose[^/]*)$|\.tf$|k8s\/|\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile/.test(p));
  const deploymentTopology = {
    hasDockerfile: paths.some(p => /(^|\/)Dockerfile/.test(p)), hasCompose: paths.some(p => /docker-compose/.test(p)),
    hasK8s: paths.some(p => /k8s\/|kubernetes\/|helm\//.test(p)), hasTerraform: paths.some(p => /\.tf$/.test(p)),
    hasCI: paths.some(p => /\.github\/workflows\/|\.gitlab-ci|Jenkinsfile/.test(p)), infraFiles
  };

  // I. data pipeline
  const has = (n, re) => re.test((n.summary || '') + ' ' + (n.tags || []).join(' '));
  const dataPipeline = {
    schemaFiles: paths.filter(p => /\.(sql|graphql|gql|proto|prisma)$/.test(p)),
    migrationFiles: paths.filter(p => /migrations?\//.test(p)),
    dataModelFiles: nodes.filter((n, i) => /models?\/|entities\//.test(paths[i]) || has(n, /sqlite|schema creation|store kept|persist/i)).map(n => n.filePath),
    apiHandlerFiles: nodes.filter((n, i) => /routes?\/|api\/|controllers?\//.test(paths[i]) || has(n, /http server|api-handler/i)).map(n => n.filePath)
  };

  // J. doc coverage
  const docGroups = new Set();
  nodes.forEach((n, i) => { if (n.type === 'document' || /readme\.md$/i.test(paths[i])) docGroups.add(groupOf[n.id]); });
  for (const e of all) if (e.type === 'documents' && groupOf[e.target]) docGroups.add(groupOf[e.target]);
  const groups = Object.keys(dirGroups);
  const und = groups.filter(g => !docGroups.has(g));
  const docCoverage = { groupsWithDocs: groups.length - und.length, totalGroups: groups.length, coverageRatio: +((groups.length - und.length) / groups.length).toFixed(2), undocumentedGroups: und };

  // K. dependency direction
  const dependencyDirection = [], seen = new Set();
  for (const { from, to, count } of interGroupImports) {
    const k = [from, to].sort().join('|'); if (seen.has(k)) continue; seen.add(k);
    const rev = ig[to + '->' + from] || 0;
    if (count >= rev) dependencyDirection.push({ dependent: from, dependsOn: to, forward: count, reverse: rev });
    else dependencyDirection.push({ dependent: to, dependsOn: from, forward: rev, reverse: count });
  }

  const res = {
    scriptCompleted: true, commonPrefix: pre.join('/'), directoryGroups: dirGroups, nodeTypeGroups: typeGroups,
    crossCategoryEdges, interGroupImports, intraGroupDensity: intra, patternMatches, filePatterns,
    deploymentTopology, dataPipeline, docCoverage, dependencyDirection,
    fileStats: {
      totalFileNodes: nodes.length,
      filesPerGroup: Object.fromEntries(groups.map(g => [g, dirGroups[g].length])),
      nodeTypeCounts: Object.fromEntries(Object.entries(typeGroups).map(([k, v]) => [k, v.length]))
    },
    fileFanIn: fanIn, fileFanOut: fanOut,
    importAdjacency: imps.reduce((m, e) => ((m[e.source] = m[e.source] || []).push(e.target), m), {}),
    nonImportEdges: all.filter(e => e.type !== 'imports').map(e => `${e.source} -${e.type}-> ${e.target}`)
  };
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  process.exit(0);
} catch (e) { console.error(e.stack || e); process.exit(1); }
