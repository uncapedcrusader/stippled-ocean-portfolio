/**
 * Temporary camera-calibration UI — loaded ONLY when ?cameraDebug=1.
 * Safe to delete after selected pose IDs are baked into production.
 */
const SESSION_KEY = "stippled-ocean-camera-debug-v1";
const STYLE_HREF = "./camera-debug.css";

function loadStyles() {
  if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_HREF;
  document.head.appendChild(link);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits);
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return { nextId: 1, poses: [], marks: {}, appliedId: null };
    const parsed = JSON.parse(raw);
    return {
      nextId: parsed.nextId || 1,
      poses: Array.isArray(parsed.poses) ? parsed.poses : [],
      marks: parsed.marks || {},
      appliedId: parsed.appliedId || null,
    };
  } catch (_) {
    return { nextId: 1, poses: [], marks: {}, appliedId: null };
  }
}

function saveSession(state) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch (_) {
    /* ignore quota */
  }
}

export function mount(api) {
  loadStyles();
  const session = loadSession();
  let panelHidden = false;
  let refObjectUrl = null;
  let syncing = false;
  let desiredHorizon = 0.56; // slightly below centre (0.5)

  const root = document.createElement("div");
  root.id = "camera-debug-root";
  root.innerHTML = `
    <div id="cam-guides" class="cam-guides" aria-hidden="true"></div>
    <div id="cam-ref-overlay" class="cam-ref-overlay is-hidden" aria-hidden="true">
      <img id="cam-ref-img" alt="" />
    </div>
    <aside id="cam-panel" class="cam-panel" aria-label="Camera calibration">
      <header class="cam-panel__head">
        <strong>Camera Calibration</strong>
        <button type="button" id="cam-hide-panel" class="cam-btn">Hide Panel</button>
      </header>
      <div class="cam-panel__body">
        <section class="cam-sec">
          <h3>Preview mode</h3>
          <div class="cam-row cam-row--wrap">
            <button type="button" class="cam-btn" data-mode="free">Free</button>
            <button type="button" class="cam-btn" data-mode="shot1">Shot 1</button>
            <button type="button" class="cam-btn" data-mode="freezeShot2">Freeze Intro at Shot 2</button>
            <button type="button" class="cam-btn" data-mode="jumpLanding">Jump to Final Landing</button>
            <button type="button" class="cam-btn" data-mode="shot2">Shot 2</button>
            <button type="button" class="cam-btn" data-mode="shot3">Shot 3</button>
            <button type="button" class="cam-btn" data-mode="landing">Landing</button>
            <button type="button" class="cam-btn" data-mode="intro">Play intro</button>
          </div>
        </section>

        <section class="cam-sec">
          <h3>Production bake match</h3>
          <pre class="cam-readout" id="cam-bake-match">—</pre>
        </section>

        <section class="cam-sec">
          <h3>Position</h3>
          ${["x", "y", "z"].map((a) => `
            <label class="cam-field">Pos ${a.toUpperCase()}
              <input type="number" step="0.1" data-pos="${a}" />
              <input type="range" min="-350" max="220" step="0.1" data-pos-range="${a}" />
            </label>`).join("")}
        </section>

        <section class="cam-sec">
          <h3>Look target</h3>
          ${["x", "y", "z"].map((a) => `
            <label class="cam-field">Target ${a.toUpperCase()}
              <input type="number" step="0.1" data-tgt="${a}" />
              <input type="range" min="-200" max="80" step="0.1" data-tgt-range="${a}" />
            </label>`).join("")}
        </section>

        <section class="cam-sec">
          <h3>Framing bias</h3>
          <label class="cam-field">Vertical (normalized)
            <input type="number" step="0.001" min="-0.25" max="0.25" id="cam-vbias" />
            <input type="range" min="-0.25" max="0.25" step="0.001" id="cam-vbias-range" />
          </label>
          <label class="cam-field">Horizontal (normalized)
            <input type="number" step="0.001" min="-0.25" max="0.25" id="cam-hbias" />
            <input type="range" min="-0.25" max="0.25" step="0.001" id="cam-hbias-range" />
          </label>
          <p class="cam-readout" id="cam-bias-px">bias px: —</p>
        </section>

        <section class="cam-sec">
          <h3>Derived</h3>
          <pre class="cam-readout" id="cam-derived">—</pre>
        </section>

        <section class="cam-sec">
          <h3>Guides</h3>
          <label class="cam-check"><input type="checkbox" data-guide="cross" checked /> Screen centre cross</label>
          <label class="cam-check"><input type="checkbox" data-guide="horizon" checked /> Desired horizon</label>
          <label class="cam-field">Horizon Y (0–1)
            <input type="number" step="0.01" min="0" max="1" id="cam-horizon" value="0.56" />
          </label>
          <label class="cam-check"><input type="checkbox" data-guide="nav" checked /> Top nav safe band</label>
          <label class="cam-check"><input type="checkbox" data-guide="text" checked /> Upper-left text safe area</label>
          <label class="cam-check"><input type="checkbox" data-guide="thirds" /> Rule of thirds</label>
          <label class="cam-check"><input type="checkbox" data-guide="dims" checked /> Viewport dims</label>
        </section>

        <section class="cam-sec">
          <h3>Reference overlay</h3>
          <input type="file" id="cam-ref-file" accept="image/*" />
          <label class="cam-field">Opacity
            <input type="range" id="cam-ref-opacity" min="0" max="100" value="40" />
          </label>
          <div class="cam-row">
            <label class="cam-check"><input type="checkbox" id="cam-ref-show" /> Show</label>
            <select id="cam-ref-fit">
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="exact">Exact viewport</option>
            </select>
          </div>
          <p class="cam-warn is-hidden" id="cam-ref-aspect-warn">Aspect ratio differs from reference.</p>
        </section>

        <section class="cam-sec">
          <h3>Capture</h3>
          <input type="text" id="cam-pose-name" placeholder="Name (e.g. Shot 3 close match)" />
          <button type="button" id="cam-capture" class="cam-btn cam-btn--accent">Capture Current Pose</button>
          <div id="cam-pose-list" class="cam-pose-list"></div>
          <div class="cam-row cam-row--wrap">
            <button type="button" id="cam-export" class="cam-btn">Export All Camera Poses</button>
            <button type="button" id="cam-copy-instruction" class="cam-btn">Copy Cursor Instruction</button>
          </div>
        </section>
      </div>
    </aside>
    <button type="button" id="cam-show-panel" class="cam-show-panel is-hidden">Show Panel</button>
  `;
  document.body.appendChild(root);

  const panel = root.querySelector("#cam-panel");
  const showBtn = root.querySelector("#cam-show-panel");
  const guidesEl = root.querySelector("#cam-guides");
  const refOverlay = root.querySelector("#cam-ref-overlay");
  const refImg = root.querySelector("#cam-ref-img");
  const poseList = root.querySelector("#cam-pose-list");

  function rebuildGuides() {
    const g = {
      cross: root.querySelector('[data-guide="cross"]').checked,
      horizon: root.querySelector('[data-guide="horizon"]').checked,
      nav: root.querySelector('[data-guide="nav"]').checked,
      text: root.querySelector('[data-guide="text"]').checked,
      thirds: root.querySelector('[data-guide="thirds"]').checked,
      dims: root.querySelector('[data-guide="dims"]').checked,
    };
    desiredHorizon = num(root.querySelector("#cam-horizon").value, 0.56);
    const w = window.innerWidth;
    const h = window.innerHeight;
    let html = "";
    if (g.cross) {
      html += `<div class="cam-guide-hline" style="top:50%"></div><div class="cam-guide-vline" style="left:50%"></div>`;
    }
    if (g.horizon) {
      html += `<div class="cam-guide-horizon" style="top:${desiredHorizon * 100}%"><span>desired horizon</span></div>`;
    }
    if (g.nav) {
      html += `<div class="cam-guide-nav"></div>`;
    }
    if (g.text) {
      html += `<div class="cam-guide-text"></div>`;
    }
    if (g.thirds) {
      html += `<div class="cam-guide-hline" style="top:33.33%"></div><div class="cam-guide-hline" style="top:66.66%"></div>`;
      html += `<div class="cam-guide-vline" style="left:33.33%"></div><div class="cam-guide-vline" style="left:66.66%"></div>`;
    }
    if (g.dims) {
      html += `<div class="cam-guide-dims">${w} × ${h} · dpr ${window.devicePixelRatio}</div>`;
    }
    guidesEl.innerHTML = html;
  }

  function pullFromApi() {
    syncing = true;
    const snap = api.snapshotPose();
    const framing = api.getFraming();
    const d = api.getDerived();
    ["x", "y", "z"].forEach((a) => {
      const p = root.querySelector(`[data-pos="${a}"]`);
      const pr = root.querySelector(`[data-pos-range="${a}"]`);
      const t = root.querySelector(`[data-tgt="${a}"]`);
      const tr = root.querySelector(`[data-tgt-range="${a}"]`);
      p.value = fmt(snap.camera.position[a], 3);
      pr.value = String(snap.camera.position[a]);
      t.value = fmt(snap.camera.target[a], 3);
      tr.value = String(snap.camera.target[a]);
    });
    root.querySelector("#cam-vbias").value = fmt(framing.verticalBias, 3);
    root.querySelector("#cam-vbias-range").value = String(framing.verticalBias);
    root.querySelector("#cam-hbias").value = fmt(framing.horizontalBias, 3);
    root.querySelector("#cam-hbias-range").value = String(framing.horizontalBias);
    root.querySelector("#cam-bias-px").textContent =
      `vertical ${fmt(d.verticalBiasPixels, 1)} px · horizontal ${fmt(d.horizontalBiasPixels, 1)} px`;
    root.querySelector("#cam-derived").textContent = [
      `distance  ${fmt(d.distance, 2)}`,
      `pitch     ${fmt(d.pitchDeg, 2)}°`,
      `yaw       ${fmt(d.yawDeg, 2)}°`,
      `fov       ${fmt(d.fov, 1)}° (locked)`,
      `aspect    ${fmt(d.aspect, 4)}`,
      `viewport  ${d.cssWidth} × ${d.cssHeight}`,
      `dpr       ${fmt(d.dpr, 2)}`,
      `mode      ${d.mode}`,
      `reproducible ${d.reproducible ? "yes" : "no"}`,
    ].join("\n");

    if (api.getBakedMatch) {
      const m = api.getBakedMatch();
      const ok = (v) => (v ? "MATCH" : "OFF");
      root.querySelector("#cam-bake-match").textContent = [
        `framing 0.137  ${ok(m.framing.match)}  (live ${fmt(m.framing.actualVertical, 3)})`,
        `pull ${fmt(m.responsivePull, 3)}  refVP ${m.atReferenceViewport ? "yes" : "no"}`,
        `CAM-002 @${m.shot2.atMs}ms  ${ok(m.shot2.match)}  posΔ ${fmt(m.shot2.positionError, 4)}  tgtΔ ${fmt(m.shot2.targetError, 4)}`,
        `CAM-001 live     ${ok(m.landing.match)}  posΔ ${fmt(m.landing.positionError, 4)}  tgtΔ ${fmt(m.landing.targetError, 4)}`,
        `CAM-001 handoff  ${ok(m.controllerHandoff.match)}  tgtPosΔ ${fmt(m.controllerHandoff.targetPositionError, 4)}  tgtLookΔ ${fmt(m.controllerHandoff.targetLookAtError, 4)}`,
        `introElapsed ${m.introElapsedMs == null ? "—" : fmt(m.introElapsedMs, 0) + " ms"}  completed ${m.introCompleted ? "yes" : "no"}`,
      ].join("\n");
    }
    syncing = false;
  }

  function pushPoseFromInputs() {
    if (syncing) return;
    api.setWorldPose({
      position: {
        x: num(root.querySelector('[data-pos="x"]').value),
        y: num(root.querySelector('[data-pos="y"]').value),
        z: num(root.querySelector('[data-pos="z"]').value),
      },
      target: {
        x: num(root.querySelector('[data-tgt="x"]').value),
        y: num(root.querySelector('[data-tgt="y"]').value),
        z: num(root.querySelector('[data-tgt="z"]').value),
      },
      syncTargets: true,
    });
    pullFromApi();
  }

  function pushFramingFromInputs() {
    if (syncing) return;
    api.setFramingBias({
      vertical: num(root.querySelector("#cam-vbias").value),
      horizontal: num(root.querySelector("#cam-hbias").value),
    });
    pullFromApi();
  }

  function nextId() {
    const id = `CAM-${String(session.nextId).padStart(3, "0")}`;
    session.nextId += 1;
    return id;
  }

  function renderPoseList() {
    poseList.innerHTML = session.poses
      .map((p) => {
        const marks = [];
        if (session.marks.shot2 === p.id) marks.push("Shot2");
        if (session.marks.shot3 === p.id) marks.push("Shot3");
        if (session.marks.landing === p.id) marks.push("Landing");
        const applied = session.appliedId === p.id ? " is-applied" : "";
        return `<article class="cam-pose${applied}" data-id="${p.id}">
          <header><strong>${p.id}</strong> ${p.name || ""}
            ${marks.map((m) => `<span class="cam-tag">${m}</span>`).join("")}
          </header>
          <div class="cam-row cam-row--wrap">
            <button type="button" data-act="apply">Apply</button>
            <button type="button" data-act="rename">Rename</button>
            <button type="button" data-act="dup">Duplicate</button>
            <button type="button" data-act="del">Delete</button>
            <button type="button" data-act="json">Copy JSON</button>
            <button type="button" data-act="js">Copy JS</button>
            <button type="button" data-act="mark2">Mark Shot 2</button>
            <button type="button" data-act="mark3">Mark Shot 3</button>
            <button type="button" data-act="markL">Mark Landing</button>
          </div>
        </article>`;
      })
      .join("");
  }

  function capturePose() {
    const name = root.querySelector("#cam-pose-name").value.trim();
    const id = nextId();
    const pose = { id, ...api.snapshotPose(name) };
    session.poses.push(pose);
    session.appliedId = id;
    saveSession(session);
    renderPoseList();
    root.querySelector("#cam-pose-name").value = "";
  }

  root.querySelector("#cam-hide-panel").addEventListener("click", () => {
    panelHidden = true;
    panel.classList.add("is-hidden");
    showBtn.classList.remove("is-hidden");
  });
  showBtn.addEventListener("click", () => {
    panelHidden = false;
    panel.classList.remove("is-hidden");
    showBtn.classList.add("is-hidden");
  });

  root.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      api.previewMode(btn.dataset.mode);
      pullFromApi();
    });
  });

  ["x", "y", "z"].forEach((a) => {
    const bind = (numSel, rangeSel, key) => {
      const nEl = root.querySelector(numSel);
      const rEl = root.querySelector(rangeSel);
      nEl.addEventListener("change", () => {
        rEl.value = nEl.value;
        pushPoseFromInputs();
      });
      rEl.addEventListener("input", () => {
        nEl.value = rEl.value;
        pushPoseFromInputs();
      });
    };
    bind(`[data-pos="${a}"]`, `[data-pos-range="${a}"]`);
    bind(`[data-tgt="${a}"]`, `[data-tgt-range="${a}"]`);
  });

  const linkBias = (numId, rangeId) => {
    const nEl = root.querySelector(numId);
    const rEl = root.querySelector(rangeId);
    nEl.addEventListener("change", () => {
      rEl.value = nEl.value;
      pushFramingFromInputs();
    });
    rEl.addEventListener("input", () => {
      nEl.value = rEl.value;
      pushFramingFromInputs();
    });
  };
  linkBias("#cam-vbias", "#cam-vbias-range");
  linkBias("#cam-hbias", "#cam-hbias-range");

  root.querySelectorAll("[data-guide]").forEach((el) => {
    el.addEventListener("change", rebuildGuides);
  });
  root.querySelector("#cam-horizon").addEventListener("change", rebuildGuides);

  root.querySelector("#cam-ref-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (refObjectUrl) URL.revokeObjectURL(refObjectUrl);
    refObjectUrl = URL.createObjectURL(file);
    refImg.src = refObjectUrl;
    refImg.onload = () => {
      const imgAspect = refImg.naturalWidth / Math.max(refImg.naturalHeight, 1);
      const viewAspect = window.innerWidth / Math.max(window.innerHeight, 1);
      const warn = root.querySelector("#cam-ref-aspect-warn");
      const mismatch = Math.abs(imgAspect - viewAspect) > 0.04;
      warn.classList.toggle("is-hidden", !mismatch);
      root.querySelector("#cam-ref-show").checked = true;
      updateRefOverlay();
    };
  });

  function updateRefOverlay() {
    const show = root.querySelector("#cam-ref-show").checked && !!refImg.src;
    const opacity = num(root.querySelector("#cam-ref-opacity").value, 40) / 100;
    const fit = root.querySelector("#cam-ref-fit").value;
    refOverlay.classList.toggle("is-hidden", !show);
    refOverlay.style.opacity = String(opacity);
    refImg.style.objectFit =
      fit === "cover" ? "cover" : fit === "contain" ? "contain" : "fill";
    if (fit === "exact") {
      refImg.style.width = "100%";
      refImg.style.height = "100%";
      refImg.style.objectFit = "fill";
    }
  }
  root.querySelector("#cam-ref-show").addEventListener("change", updateRefOverlay);
  root.querySelector("#cam-ref-opacity").addEventListener("input", updateRefOverlay);
  root.querySelector("#cam-ref-fit").addEventListener("change", updateRefOverlay);

  root.querySelector("#cam-capture").addEventListener("click", capturePose);

  poseList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    const card = e.target.closest("[data-id]");
    if (!btn || !card) return;
    const id = card.dataset.id;
    const pose = session.poses.find((p) => p.id === id);
    if (!pose) return;
    const act = btn.dataset.act;
    if (act === "apply") {
      api.applyCapturedPose(pose, { snapLive: true });
      session.appliedId = id;
      saveSession(session);
      renderPoseList();
      pullFromApi();
    } else if (act === "rename") {
      const name = prompt("Pose name", pose.name || "");
      if (name != null) {
        pose.name = name.trim();
        saveSession(session);
        renderPoseList();
      }
    } else if (act === "dup") {
      const copy = JSON.parse(JSON.stringify(pose));
      copy.id = nextId();
      copy.name = `${pose.name || pose.id} copy`;
      session.poses.push(copy);
      saveSession(session);
      renderPoseList();
    } else if (act === "del") {
      session.poses = session.poses.filter((p) => p.id !== id);
      Object.keys(session.marks).forEach((k) => {
        if (session.marks[k] === id) delete session.marks[k];
      });
      if (session.appliedId === id) session.appliedId = null;
      saveSession(session);
      renderPoseList();
    } else if (act === "json") {
      navigator.clipboard.writeText(JSON.stringify(pose, null, 2));
    } else if (act === "js") {
      navigator.clipboard.writeText(
        `const ${pose.id.replace(/-/g, "_")} = ${JSON.stringify(pose, null, 2)};`
      );
    } else if (act === "mark2") {
      session.marks.shot2 = id;
      saveSession(session);
      renderPoseList();
    } else if (act === "mark3") {
      session.marks.shot3 = id;
      session.marks.landing = id;
      saveSession(session);
      renderPoseList();
    } else if (act === "markL") {
      session.marks.landing = id;
      saveSession(session);
      renderPoseList();
    }
  });

  root.querySelector("#cam-export").addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      marks: session.marks,
      poses: session.poses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "stippled-ocean-camera-poses.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  root.querySelector("#cam-copy-instruction").addEventListener("click", () => {
    const m = session.marks;
    const lines = [];
    if (m.shot2) lines.push(`Use ${m.shot2} as Loading Shot 2.`);
    if (m.shot3) {
      lines.push(
        `Use ${m.shot3} as Loading Shot 3 and the canonical interactive landing pose.`
      );
    } else if (m.landing) {
      lines.push(`Use ${m.landing} as the canonical interactive landing pose.`);
    }
    const biasPose =
      session.poses.find((p) => p.id === m.shot3) ||
      session.poses.find((p) => p.id === m.landing);
    if (biasPose) {
      lines.push(
        `Use the global vertical framing bias captured in ${biasPose.id} (${biasPose.framing.verticalBiasNormalized}) throughout the intro, normal trackpad navigation, zoom, focus transitions and resize calculations.`
      );
    }
    const text =
      lines.join("\n") ||
      "Mark poses as Shot 2 / Shot 3 / Landing first, then copy again.";
    navigator.clipboard.writeText(text);
  });

  window.addEventListener("resize", () => {
    rebuildGuides();
    pullFromApi();
    updateRefOverlay();
  });

  // Keep trackpad/wheel on the panel from driving ocean navigation.
  panel.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
    },
    { passive: true }
  );

  // Lightweight readout refresh (not in the WebGL render loop).
  const timer = window.setInterval(pullFromApi, 250);
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    if (refObjectUrl) {
      URL.revokeObjectURL(refObjectUrl);
      refObjectUrl = null;
    }
  });

  rebuildGuides();
  renderPoseList();
  pullFromApi();
  console.info(
    "[camera-debug] Calibration UI ready. Hide panel to capture clean viewport screenshots."
  );
}
