#!/usr/bin/env node
'use strict';

// One-time migration: enrich existing data.json with per-season confidence
// scores and shape-drift tags. This is the post-build pass for repos that
// can't re-run the full build from raw IMDb TSVs.

const fs = require('fs');
const path = require('path');
const { shapeConfidence, tagShapeDrift } = require('./match.js');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

console.log('Reading data.json…');
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

console.log(`Enriching ${data.matches.length} seasons…`);
for (const m of data.matches) {
  m.confidence = shapeConfidence(m.episodes);
}

tagShapeDrift(data.matches);

// Count shape-drift tagged seasons
const driftCount = data.matches.filter((m) => m.shapes.includes('shape-drift')).length;
console.log(`shape-drift tagged: ${driftCount} seasons`);

// Update shapeCounts
data.shapeCounts['shape-drift'] = driftCount;

fs.writeFileSync(DATA_FILE, JSON.stringify(data) + '\n');
console.log('Done. data.json updated.');
