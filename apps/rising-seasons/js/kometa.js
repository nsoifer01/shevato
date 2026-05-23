/* Rising Seasons → Plex + Kometa builder UI.
   Loads data.json (the same file the main app uses, so the browser cache
   carries over), and calls into window.RisingSeasonsIntegrations to build
   YAML / ID-list output on the fly as the user changes settings. */
'use strict';

(function () {
  const API = window.RisingSeasonsIntegrations;
  if (!API) {
    setStatusError('Integration library failed to load. Refresh the page.');
    return;
  }

  const DEFAULT_SELECTED = new Set(['rising', 'slow-burn', 'big-finale', 'rebound', 'saved-best-for-last']);
  const ALL_SHAPES = API.COLLECTION_SHAPES.slice();

  const els = {
    status: document.getElementById('kometaStatus'),
    grid: document.getElementById('builderGrid'),
    shapeList: document.getElementById('shapeList'),
    selectAll: document.getElementById('shapesSelectAll'),
    clearAll: document.getElementById('shapesClearAll'),
    defaults: document.getElementById('shapesDefaults'),
    confidence: document.getElementById('confidenceSlider'),
    confidenceValue: document.getElementById('confidenceValue'),
    floorEffect: document.getElementById('floorEffect'),
    outputModeRadios: document.getElementsByName('outputMode'),
    fileTabs: document.getElementById('fileTabs'),
    outputCode: document.getElementById('outputCode'),
    outputMeta: document.getElementById('outputMeta'),
    copyBtn: document.getElementById('copyBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
  };

  const state = {
    matches: null,
    selectedShapes: new Set(DEFAULT_SELECTED),
    confidence: 0.35,
    outputMode: 'collections',
    activeFile: null,
    files: [],  // [{ filename, contents, label, shape }]
  };

  function setStatusError(msg) {
    if (els.status) {
      els.status.textContent = msg;
      els.status.classList.add('is-error');
    }
  }

  loadDataset().then(() => {
    renderShapeList();
    wireEvents();
    rebuild();
    els.status.hidden = true;
    els.grid.hidden = false;
  }).catch((err) => {
    setStatusError(`Could not load data.json: ${err.message}`);
  });

  async function loadDataset() {
    // The page lives at /apps/rising-seasons/kometa/ but the dataset is at
    // /apps/rising-seasons/data.json — go up one directory.
    const resp = await fetch('../data.json', { cache: 'force-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.matches = data.matches;
    state.builtAt = data.builtAt;
  }

  function shapeStats() {
    // Per-shape "qualifying series" count at the current confidence floor —
    // shown next to each checkbox so the user can see what they'd get.
    const out = new Map();
    for (const shape of ALL_SHAPES) out.set(shape, 0);
    const seenForShape = new Map(); // shape -> Set<seriesId>
    for (const shape of ALL_SHAPES) seenForShape.set(shape, new Set());
    for (const m of state.matches) {
      if (!m.shapes) continue;
      for (const shape of m.shapes) {
        if (!seenForShape.has(shape)) continue;
        // Match the same logic integrations-lib uses internally.
        const isCategorical = shape === 'saved-best-for-last' || shape === 'shape-drift';
        const conf = isCategorical ? 1.0 : (m.confidence && m.confidence[shape]) || 0;
        if (conf < state.confidence) continue;
        const set = seenForShape.get(shape);
        if (set.has(m.seriesId)) continue;
        set.add(m.seriesId);
        out.set(shape, set.size);
      }
    }
    return out;
  }

  function renderShapeList() {
    const stats = shapeStats();
    els.shapeList.innerHTML = '';
    for (const shape of ALL_SHAPES) {
      const meta = API.SHAPE_META[shape];
      const count = stats.get(shape) || 0;
      const checked = state.selectedShapes.has(shape);
      const label = document.createElement('label');
      label.className = 'kometa-shape' + (checked ? ' is-checked' : '') + (count === 0 ? ' is-empty' : '');
      label.dataset.shape = shape;
      label.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''} ${count === 0 ? 'disabled' : ''}>
        <span class="kometa-shape-badge">${escapeHtml(meta.badge)}</span>
        <span class="kometa-shape-label">${escapeHtml(meta.title)}</span>
        <span class="kometa-shape-count">${count.toLocaleString()}</span>
      `;
      const input = label.querySelector('input');
      input.addEventListener('change', () => {
        if (input.checked) state.selectedShapes.add(shape);
        else state.selectedShapes.delete(shape);
        label.classList.toggle('is-checked', input.checked);
        rebuild({ skipShapeList: true });
      });
      els.shapeList.appendChild(label);
    }
  }

  function updateShapeListCounts() {
    const stats = shapeStats();
    for (const label of els.shapeList.querySelectorAll('.kometa-shape')) {
      const shape = label.dataset.shape;
      const count = stats.get(shape) || 0;
      label.querySelector('.kometa-shape-count').textContent = count.toLocaleString();
      label.classList.toggle('is-empty', count === 0);
      const input = label.querySelector('input');
      if (count === 0) {
        input.checked = false;
        state.selectedShapes.delete(shape);
        input.disabled = true;
        label.classList.remove('is-checked');
      } else {
        input.disabled = false;
      }
    }
  }

  function wireEvents() {
    els.selectAll.addEventListener('click', () => {
      const stats = shapeStats();
      for (const shape of ALL_SHAPES) {
        if ((stats.get(shape) || 0) > 0) state.selectedShapes.add(shape);
      }
      renderShapeList();
      rebuild({ skipShapeList: true });
    });
    els.clearAll.addEventListener('click', () => {
      state.selectedShapes.clear();
      renderShapeList();
      rebuild({ skipShapeList: true });
    });
    els.defaults.addEventListener('click', () => {
      state.selectedShapes = new Set(DEFAULT_SELECTED);
      renderShapeList();
      rebuild({ skipShapeList: true });
    });

    els.confidence.addEventListener('input', () => {
      state.confidence = parseFloat(els.confidence.value);
      els.confidenceValue.textContent = state.confidence.toFixed(2);
      updateShapeListCounts();
      rebuild({ skipShapeList: true });
    });

    for (const radio of els.outputModeRadios) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          state.outputMode = radio.value;
          state.activeFile = null;
          rebuild({ skipShapeList: true });
        }
      });
    }

    els.copyBtn.addEventListener('click', copyActive);
    els.downloadBtn.addEventListener('click', downloadActive);
    els.downloadAllBtn.addEventListener('click', downloadCombined);
  }

  function rebuild(opts = {}) {
    if (!opts.skipShapeList) updateShapeListCounts();

    const opts2 = {
      confidenceFloor: state.confidence,
      minSeries: 1, // Honor user picks even if a shape has few series.
    };
    let built;
    if (state.outputMode === 'collections') {
      built = API.buildKometaCollections(filteredMatches(), opts2)
        .map((c) => ({
          filename: c.filename,
          contents: c.contents,
          label: c.shape,
          shape: c.shape,
          metaCount: c.seriesCount,
          metaUnit: 'series',
        }));
    } else if (state.outputMode === 'overlays') {
      const overlays = API.buildSeasonOverlays(filteredMatches(), opts2);
      built = [{
        filename: 'season-overlays.yml',
        contents: overlays.contents,
        label: 'season-overlays',
        shape: null,
        metaCount: overlays.shapesEmitted,
        metaUnit: 'shape buckets',
      }];
    } else {
      built = API.buildIdLists(filteredMatches(), opts2)
        .map((l) => ({
          filename: l.filename,
          contents: l.contents,
          label: l.shape,
          shape: l.shape,
          metaCount: l.count,
          metaUnit: 'IDs',
        }));
    }

    state.files = built;
    if (state.files.length === 0) {
      els.fileTabs.innerHTML = '';
      els.outputCode.innerHTML = '';
      els.outputMeta.textContent = 'Pick at least one shape with non-zero series above the floor.';
      els.copyBtn.disabled = true;
      els.downloadBtn.disabled = true;
      els.downloadAllBtn.disabled = true;
      updateFloorEffect(0);
      return;
    }
    els.copyBtn.disabled = false;
    els.downloadBtn.disabled = false;
    els.downloadAllBtn.disabled = state.files.length < 2;

    // Preserve active tab across rebuilds when possible.
    if (!state.activeFile || !state.files.find((f) => f.filename === state.activeFile)) {
      state.activeFile = state.files[0].filename;
    }
    renderTabs();
    renderActiveFile();
    updateFloorEffect(state.files.reduce((s, f) => s + f.metaCount, 0));
  }

  function filteredMatches() {
    // Restrict to only the shapes the user picked so unselected shapes are
    // excluded from every output mode (collections, overlays, IDs).
    const wanted = state.selectedShapes;
    if (wanted.size === ALL_SHAPES.length) return state.matches;
    const out = [];
    for (const m of state.matches) {
      if (!m.shapes) continue;
      const intersect = m.shapes.filter((s) => wanted.has(s));
      if (intersect.length === 0) continue;
      // Project so downstream only sees the selected shapes for this match.
      out.push({ ...m, shapes: intersect });
    }
    return out;
  }

  function renderTabs() {
    els.fileTabs.innerHTML = '';
    for (const f of state.files) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kometa-output-tab' + (f.filename === state.activeFile ? ' is-active' : '');
      btn.textContent = f.filename;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', f.filename === state.activeFile ? 'true' : 'false');
      btn.addEventListener('click', () => {
        state.activeFile = f.filename;
        renderTabs();
        renderActiveFile();
      });
      els.fileTabs.appendChild(btn);
    }
  }

  function renderActiveFile() {
    const f = state.files.find((x) => x.filename === state.activeFile);
    if (!f) return;
    els.outputCode.innerHTML = highlightYaml(f.contents);
    const isYaml = f.filename.endsWith('.yml');
    const kind = state.outputMode === 'ids' ? 'IMDb IDs' : (state.outputMode === 'overlays' ? 'overlay shape buckets' : 'series');
    els.outputMeta.innerHTML = `
      <span><strong>${f.filename}</strong> — ${f.metaCount.toLocaleString()} ${f.metaUnit}</span>
      <span>${isYaml ? 'Kometa YAML' : 'plain text'} • confidence ≥ ${state.confidence.toFixed(2)}</span>
    `;
  }

  function updateFloorEffect(totalCount) {
    if (state.outputMode === 'collections') {
      els.floorEffect.textContent = `${state.selectedShapes.size} shape(s) → ${totalCount.toLocaleString()} series covered in the YAMLs.`;
    } else if (state.outputMode === 'overlays') {
      els.floorEffect.textContent = `${totalCount} shape buckets emit poster overlays at this floor.`;
    } else {
      els.floorEffect.textContent = `${state.selectedShapes.size} shape(s) → ${totalCount.toLocaleString()} unique IMDb IDs across the lists.`;
    }
  }

  function copyActive() {
    const f = state.files.find((x) => x.filename === state.activeFile);
    if (!f) return;
    navigator.clipboard.writeText(f.contents).then(
      () => toast('Copied ' + f.filename),
      () => toast('Copy failed — select the text manually'),
    );
  }

  function downloadActive() {
    const f = state.files.find((x) => x.filename === state.activeFile);
    if (!f) return;
    triggerDownload(f.filename, f.contents);
  }

  function downloadCombined() {
    // For multi-file outputs, the user often wants a single drop-in file
    // they can save to disk. We stitch the YAML files with comment headers.
    const parts = [];
    for (const f of state.files) {
      parts.push(`# === ${f.filename} (${f.metaCount.toLocaleString()} ${f.metaUnit}) ===`);
      parts.push(f.contents.trimEnd());
      parts.push('');
    }
    const isYaml = state.files.every((f) => f.filename.endsWith('.yml'));
    const ext = isYaml ? 'yml' : 'txt';
    const name = state.outputMode === 'ids' ? `rising-seasons-ids.${ext}` : `rising-seasons-${state.outputMode}.${ext}`;
    triggerDownload(name, parts.join('\n'));
  }

  function triggerDownload(filename, contents) {
    const mime = filename.endsWith('.yml') ? 'application/x-yaml' : 'text/plain';
    const blob = new Blob([contents], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Downloaded ' + filename);
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'copy-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 1800);
  }

  // Minimal YAML highlighter — comments, keys, strings, numbers, list bullets.
  // Plain text (ID lists) is rendered as-is.
  function highlightYaml(text) {
    if (state.outputMode === 'ids') return escapeHtml(text);
    return text.split('\n').map((line) => {
      const trimmed = line.trimStart();
      const indent = line.slice(0, line.length - trimmed.length);
      if (trimmed.startsWith('#')) {
        return `<span class="yaml-comment">${escapeHtml(line)}</span>`;
      }
      if (trimmed.startsWith('- ')) {
        const after = trimmed.slice(2);
        return `${escapeHtml(indent)}<span class="yaml-bullet">- </span>${highlightValue(after)}`;
      }
      const kvMatch = trimmed.match(/^([A-Za-z_][\w\s\-./()&]*?):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2];
        return `${escapeHtml(indent)}<span class="yaml-key">${escapeHtml(key)}</span>:${value ? ' ' + highlightValue(value) : ''}`;
      }
      return escapeHtml(line);
    }).join('\n');
  }

  function highlightValue(v) {
    if (!v) return '';
    if (/^".*"$/.test(v)) return `<span class="yaml-string">${escapeHtml(v)}</span>`;
    if (/^-?\d+(\.\d+)?$/.test(v)) return `<span class="yaml-number">${escapeHtml(v)}</span>`;
    return escapeHtml(v);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
