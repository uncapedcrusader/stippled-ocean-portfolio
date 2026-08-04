import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

(() => {
  "use strict";

  const MAX_SPLASHES = 48;
  // Base field was 1.98M; master is 4× so density 1..8 can reveal more without reshuffling
  const OCEAN_BASE_COUNT = 1980000;
  const OCEAN_MASTER_MULT = 4;
  const PARTICLE_COUNT = OCEAN_BASE_COUNT * OCEAN_MASTER_MULT;
  const OCEAN_RADIUS = 126;
  // Keep the near rim close to the camera; the disk extends 3× farther out
  const OCEAN_CENTER_Z = -100;

  // ─── Floating homepage models (solid GLBs) ───────────────────────────
  const FLOAT_TILT_STRENGTH = 0.22;
  const FLOAT_SLOPE_SAMPLE_EPS = 1.8;

  const PROJECTS_URL = "assets/models/projects-float.glb";
  const ABOUT_URL = "assets/models/about-shaardul.glb";
  const INTERESTS_URL = "assets/models/interests-shelf.glb";

  // Authoritative locked composition (exact values from final approved screenshots).
  const FINAL_COMPOSITION = {
    projects: {
      x: -35,
      z: -100,
      scale: 11.63,
      immersion: 0.3,
      immersionOffset: 0,
      bob: 6,
      maxTiltDeg: 6,
      rotXDeg: 1,
      rotYDeg: -65,
      rotZDeg: 5,
    },
    about: {
      x: 2.7,
      z: -91.3,
      scale: 15.6,
      immersion: 0.45,
      immersionOffset: 0,
      bob: 4.75,
      maxTiltDeg: 5,
      rotXDeg: -71,
      rotYDeg: 0,
      rotZDeg: 6,
    },
    interests: {
      x: 46,
      z: -92,
      scale: 12.81,
      immersion: 0.12,
      immersionOffset: 0,
      bob: 6,
      maxTiltDeg: 4,
      rotXDeg: -5,
      rotYDeg: -84,
      rotZDeg: -7,
    },
  };

  const COMPOSITION_STORAGE_KEY = "stippled-ocean-float-tune-v4";
  const COMPOSITION_SEED_KEY = "stippled-ocean-preset-seed";
  const COMPOSITION_SEED_VALUE = "final-composition-v2";
  const ABOUT_PLACEMENT_SEED_KEY = "stippled-ocean-about-placement-v045";

  // One-time clear of older/incorrect saved tuning so the corrected preset can take effect
  if (localStorage.getItem(COMPOSITION_SEED_KEY) !== COMPOSITION_SEED_VALUE) {
    [
      "stippled-ocean-float-tune",
      "stippled-ocean-float-tune-v1",
      "stippled-ocean-float-tune-v2",
      "stippled-ocean-float-tune-v3",
      COMPOSITION_STORAGE_KEY,
    ].forEach((key) => localStorage.removeItem(key));
    localStorage.setItem(COMPOSITION_SEED_KEY, COMPOSITION_SEED_VALUE);
  }

  // Targeted About placement migration (immersion 0.45) — does not wipe other models
  function migrateAboutPlacement(comp) {
    if (!comp?.about) return comp;
    const a = FINAL_COMPOSITION.about;
    comp.about = {
      ...comp.about,
      x: a.x,
      z: a.z,
      scale: a.scale,
      immersion: a.immersion,
      immersionOffset: a.immersionOffset,
      bob: a.bob,
      maxTiltDeg: a.maxTiltDeg,
      rotXDeg: a.rotXDeg,
      rotYDeg: a.rotYDeg,
      rotZDeg: a.rotZDeg,
    };
    return comp;
  }

  function cloneComposition(src) {
    return JSON.parse(JSON.stringify(src));
  }

  function loadStoredComposition() {
    try {
      const raw = localStorage.getItem(COMPOSITION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.projects && parsed?.about && parsed?.interests) return parsed;
    } catch (_) {
      /* ignore corrupt storage */
    }
    return null;
  }

  const storedComposition = loadStoredComposition();
  let activeComposition = storedComposition || cloneComposition(FINAL_COMPOSITION);
  if (localStorage.getItem(ABOUT_PLACEMENT_SEED_KEY) !== "1") {
    activeComposition = migrateAboutPlacement(activeComposition);
    localStorage.setItem(COMPOSITION_STORAGE_KEY, JSON.stringify(activeComposition));
    localStorage.setItem(ABOUT_PLACEMENT_SEED_KEY, "1");
  }
  if (!storedComposition) {
    localStorage.setItem(COMPOSITION_STORAGE_KEY, JSON.stringify(activeComposition));
  }

  const canvas = document.getElementById("ocean");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  // Softly dissolve distant / perimeter particles into the void when zoomed out
  scene.fog = new THREE.FogExp2(0x000000, 0.00183);

  const camera = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    600
  );

  // Low-angle view so the ocean fills roughly the lower 2/5 of the frame
  const cameraState = {
    position: new THREE.Vector3(0, 7.5, 28),
    lookAt: new THREE.Vector3(0, 0.8, -8),
    targetPosition: new THREE.Vector3(0, 7.5, 28),
    targetLookAt: new THREE.Vector3(0, 0.8, -8),
  };
  camera.position.copy(cameraState.position);
  camera.lookAt(cameraState.lookAt);

  // ─── Dual view: Perspective (existing) + Top (ortho composition) ─────
  // TEMP: remove with view-bar / comp-labels markup when composition is locked
  let activeView = "perspective"; // "perspective" | "top"
  let activeCamera = camera;

  const perspectiveSnapshot = {
    position: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
    targetPosition: new THREE.Vector3(),
    targetLookAt: new THREE.Vector3(),
  };

  const topView = {
    centerX: 0,
    centerZ: OCEAN_CENTER_Z,
    halfExtent: 36,
    defaultCenterX: 0,
    defaultCenterZ: OCEAN_CENTER_Z,
    defaultHalfExtent: 36,
    minHalfExtent: 6,
    maxHalfExtent: 220, // enough to Fit All across Z ≈ -160…+80
    height: 220,
  };

  const topCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 800);
  // Looking straight down: screen +X = world +X, screen up = world −Z (so +Z runs vertically down the screen)
  topCamera.up.set(0, 0, -1);
  topCamera.position.set(topView.centerX, topView.height, topView.centerZ);
  topCamera.lookAt(topView.centerX, 0, topView.centerZ);

  function updateTopCameraFrustum() {
    const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const halfH = topView.halfExtent;
    const halfW = halfH * aspect;
    topCamera.left = -halfW;
    topCamera.right = halfW;
    topCamera.top = halfH;
    topCamera.bottom = -halfH;
    topCamera.position.set(topView.centerX, topView.height, topView.centerZ);
    topCamera.lookAt(topView.centerX, 0, topView.centerZ);
    topCamera.updateProjectionMatrix();
  }

  function syncTopZoomSlider() {
    const slider = document.getElementById("view-top-zoom");
    const out = document.getElementById("view-top-zoom-val");
    if (!slider) return;
    const t =
      1 -
      (topView.halfExtent - topView.minHalfExtent) /
        (topView.maxHalfExtent - topView.minHalfExtent);
    const pct = Math.round(THREE.MathUtils.clamp(t, 0, 1) * 100);
    slider.value = String(pct);
    if (out) out.textContent = String(pct);
  }

  function setTopHalfExtentFromZoomSlider(pct) {
    const t = THREE.MathUtils.clamp(pct / 100, 0, 1);
    topView.halfExtent = THREE.MathUtils.lerp(
      topView.maxHalfExtent,
      topView.minHalfExtent,
      t
    );
    updateTopCameraFrustum();
  }

  function savePerspectiveSnapshot() {
    perspectiveSnapshot.position.copy(cameraState.position);
    perspectiveSnapshot.lookAt.copy(cameraState.lookAt);
    perspectiveSnapshot.targetPosition.copy(cameraState.targetPosition);
    perspectiveSnapshot.targetLookAt.copy(cameraState.targetLookAt);
  }

  function restorePerspectiveSnapshot() {
    cameraState.position.copy(perspectiveSnapshot.position);
    cameraState.lookAt.copy(perspectiveSnapshot.lookAt);
    cameraState.targetPosition.copy(perspectiveSnapshot.targetPosition);
    cameraState.targetLookAt.copy(perspectiveSnapshot.targetLookAt);
    camera.position.copy(cameraState.position);
    camera.lookAt(cameraState.lookAt);
  }

  function fitTopToAllModels() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let any = false;

    floatingModels.forEach((m) => {
      const r = Math.max(m.halfHeight * m.scale * 1.35, 2.5);
      minX = Math.min(minX, m.x - r);
      maxX = Math.max(maxX, m.x + r);
      minZ = Math.min(minZ, m.z - r);
      maxZ = Math.max(maxZ, m.z + r);
      any = true;
    });

    if (!any) {
      topView.centerX = 0;
      topView.centerZ = OCEAN_CENTER_Z;
      topView.halfExtent = topView.defaultHalfExtent;
    } else {
      topView.centerX = (minX + maxX) * 0.5;
      topView.centerZ = (minZ + maxZ) * 0.5;
      const spanX = Math.max(maxX - minX, 4);
      const spanZ = Math.max(maxZ - minZ, 4);
      const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
      const pad = 1.35;
      topView.halfExtent = Math.max(spanZ * 0.5 * pad, (spanX * 0.5 * pad) / aspect);
      topView.halfExtent = THREE.MathUtils.clamp(
        topView.halfExtent,
        topView.minHalfExtent,
        topView.maxHalfExtent
      );
    }

    updateTopCameraFrustum();
    syncTopZoomSlider();
  }

  function resetTopView() {
    topView.centerX = topView.defaultCenterX;
    topView.centerZ = topView.defaultCenterZ;
    topView.halfExtent = topView.defaultHalfExtent;
    updateTopCameraFrustum();
    syncTopZoomSlider();
  }

  function setCompositionAidsVisible(visible) {
    const labels = document.getElementById("comp-labels");
    const axes = document.getElementById("comp-axes");
    if (labels) {
      labels.classList.toggle("is-hidden", !visible);
      labels.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (axes) {
      axes.classList.toggle("is-hidden", !visible);
      axes.setAttribute("aria-hidden", visible ? "false" : "true");
    }
  }

  function setActiveView(mode) {
    if (mode === activeView) return;

    if (mode === "top") {
      savePerspectiveSnapshot();
      activeView = "top";
      activeCamera = topCamera;
      updateTopCameraFrustum();
      syncTopZoomSlider();
      setCompositionAidsVisible(true);
    } else {
      activeView = "perspective";
      activeCamera = camera;
      restorePerspectiveSnapshot();
      setCompositionAidsVisible(false);
    }

    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === activeView);
    });
    const topTools = document.getElementById("view-top-tools");
    if (topTools) topTools.classList.toggle("is-enabled", activeView === "top");
  }

  const _labelProj = new THREE.Vector3();
  function updateCompositionLabels() {
    if (activeView !== "top") return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    floatingModels.forEach((m) => {
      const el = document.querySelector(`.comp-label[data-model="${m.id}"]`);
      if (!el) return;
      _labelProj.set(m.x, m.group.position.y + Math.max(1.2, m.halfHeight * m.scale * 0.35), m.z);
      _labelProj.project(topCamera);
      if (_labelProj.z > 1) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${(_labelProj.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-_labelProj.y * 0.5 + 0.5) * h}px`;
    });
  }

  updateTopCameraFrustum();

  // ─── Noise helpers (CPU, for raycast height sampling) ───────────────
  function hash2(x, z) {
    const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function valueNoise(x, z) {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = fade(x - x0);
    const fz = fade(z - z0);
    const n00 = hash2(x0, z0);
    const n10 = hash2(x0 + 1, z0);
    const n01 = hash2(x0, z0 + 1);
    const n11 = hash2(x0 + 1, z0 + 1);
    return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fz);
  }

  function fbm(x, z, octaves) {
    // Shared with the GPU ocean shader: always 4 octaves (GLSL fbm loops i < 4).
    // The octaves argument is kept for call-site clarity but capped/forced to 4 so
    // CPU sampleWaveHeight matches the rendered surface height.
    let value = 0;
    let amp = 0.5;
    let freq = 1;
    let max = 0;
    const n = 4;
    for (let i = 0; i < n; i++) {
      value += valueNoise(x * freq, z * freq) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2.02;
    }
    return value / max;
  }

  // ─── Shared ocean surface height (CPU ↔ GPU) ─────────────────────────
  // Must stay in sync with GLSL waveHeight() in the points ShaderMaterial.
  // Same drift, frequencies, amplitudes, crest term, and crest-chop noise.
  // Used for raycast hits AND buoyant float placement so the object rides
  // the actual rendered waves (not a separate sine bob).
  // Positive drift along Z in noise space moves crests toward -Z (away from the camera).
  function sampleWaveHeight(x, z, time) {
    const driftX = time * 0.17;
    const driftZ = time * 0.2;

    let h = 0;
    // Energetic rolling swells — between the calm and the old spiky look
    h += (fbm(x * 0.07 + driftX, z * 0.07 + driftZ, 4) - 0.5) * 2.95;
    h += (fbm(x * 0.18 + driftX * 1.3, z * 0.18 + driftZ * 1.1, 3) - 0.5) * 1.15;
    h += (fbm(x * 0.34 - driftX * 0.55, z * 0.34 + driftZ * 1.25, 2) - 0.5) * 0.32;

    // Moderate crest lift (well below the old crest^2 that made needles)
    const crest = Math.max(0, h);
    h += crest * crest * 0.28;

    if (h > 1.35) {
      const chop = valueNoise(x * 1.6 + time * 0.45, z * 1.6 + time * 0.3);
      h += (h - 1.35) * chop * 0.55;
    }

    return h;
  }

  // Interaction splash vertical scale: previous single-splash peak ≈ 11.68
  // (ring+core)×envelope×maxStrength×(2/3) with strength≈1.6.
  // Was halved (0.5 → max ≈ 5.84); now 1.5× that ceiling (0.75 → max ≈ 8.76).
  const SPLASH_DISP_SCALE = 0.75;
  const SPLASH_PREV_MAX_HEIGHT = 11.68;
  const SPLASH_MAX_HEIGHT = SPLASH_PREV_MAX_HEIGHT * SPLASH_DISP_SCALE;

  function softCapSplashHeight(extra) {
    if (!(extra > 0)) return 0;
    // Smooth asymptotic ceiling — no flat plateau clipping
    return SPLASH_MAX_HEIGHT * (1 - Math.exp(-extra / SPLASH_MAX_HEIGHT));
  }

  function sampleSplashHeight(x, z, time, splashes) {
    let extra = 0;
    for (let i = 0; i < splashes.length; i++) {
      const s = splashes[i];
      const age = time - s.time;
      if (age < 0 || age > s.duration) continue;
      const dx = x - s.x;
      const dz = z - s.z;
      // Stretch the splash away from the camera (-Z) so it reads as spraying outward
      const dist = Math.sqrt(dx * dx + Math.max(dz, 0) * Math.max(dz, 0) * 2.4 + Math.min(dz, 0) * Math.min(dz, 0) * 0.55);
      const radius = s.radius;
      if (dist > radius * 1.4) continue;

      const life = age / s.duration;
      const envelope = Math.sin(Math.PI * Math.min(life * 1.15, 1)) * (1 - life * 0.35);
      const ring = Math.exp(-((dist - life * radius * 0.85) ** 2) / (radius * 0.22) ** 2);
      const core = Math.exp(-(dist * dist) / (radius * 0.35) ** 2) * (1 - life);
      extra += (ring * 2.8 + core * 4.5) * envelope * s.strength * (2 / 3);
    }
    extra *= SPLASH_DISP_SCALE;
    return softCapSplashHeight(extra);
  }

  // ─── Shared GPU wave surface (lockstep with CPU sampleWaveHeight) ─────
  // Injected into ocean displacement AND body underwater clipping shaders.
  const WAVE_SURFACE_GLSL = /* glsl */ `
    float waveHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float waveNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = waveHash(i);
      float b = waveHash(i + vec2(1.0, 0.0));
      float c = waveHash(i + vec2(0.0, 1.0));
      float d = waveHash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }

    float waveFbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      float f = 1.0;
      float m = 0.0;
      for (int i = 0; i < 4; i++) {
        v += waveNoise(p * f) * a;
        m += a;
        a *= 0.5;
        f *= 2.02;
      }
      return v / m;
    }

    float waveHeight(vec2 xz, float t) {
      float driftX = t * 0.17;
      float driftZ = t * 0.2;
      float h = 0.0;
      h += (waveFbm(xz * 0.07 + vec2(driftX, driftZ)) - 0.5) * 2.95;
      h += (waveFbm(xz * 0.18 + vec2(driftX * 1.3, driftZ * 1.1)) - 0.5) * 1.15;
      h += (waveFbm(xz * 0.34 + vec2(-driftX * 0.55, driftZ * 1.25)) - 0.5) * 0.32;
      float crest = max(h, 0.0);
      h += crest * crest * 0.28;
      if (h > 1.35) {
        float chop = waveNoise(xz * 1.6 + vec2(t * 0.45, t * 0.3));
        h += (h - 1.35) * chop * 0.55;
      }
      return h;
    }

    float splashHeight(vec2 xz, float t) {
      float extra = 0.0;
      for (int i = 0; i < ${MAX_SPLASHES}; i++) {
        vec3 c = uSplashCenters[i];
        if (c.y < -100.0) continue;
        float sTime = uSplashData[i * 4 + 0];
        float strength = uSplashData[i * 4 + 1];
        float radius = uSplashData[i * 4 + 2];
        float duration = uSplashData[i * 4 + 3];
        float age = t - sTime;
        if (age < 0.0 || age > duration) continue;
        vec2 d = xz - c.xz;
        float toward = max(d.y, 0.0);
        float away = min(d.y, 0.0);
        float dist = sqrt(d.x * d.x + toward * toward * 2.4 + away * away * 0.55);
        if (dist > radius * 1.45) continue;
        float life = age / duration;
        float envelope = sin(3.14159265 * min(life * 1.15, 1.0)) * (1.0 - life * 0.35);
        float ring = exp(-pow(dist - life * radius * 0.85, 2.0) / pow(radius * 0.22, 2.0));
        float core = exp(-(dist * dist) / pow(radius * 0.35, 2.0)) * (1.0 - life);
        extra += (ring * 2.8 + core * 4.5) * envelope * strength * (2.0 / 3.0);
      }
      // Halve splash vertical contribution + soft accumulated ceiling (lockstep with CPU)
      extra *= ${SPLASH_DISP_SCALE.toFixed(4)};
      float splashCap = ${SPLASH_MAX_HEIGHT.toFixed(4)};
      if (extra > 0.0) {
        extra = splashCap * (1.0 - exp(-extra / splashCap));
      }
      return extra;
    }

    float oceanSurfaceY(vec2 xz, float t) {
      return waveHeight(xz, t) + splashHeight(xz, t);
    }
  `;

  const WAVE_CLIP_BIAS = 0.035;

  // Early deterministic RNG (ocean master field is built before contour helpers)
  function makeSeededUnitRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─── Particle geometry (circular disk) ──────────────────────────────
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const seeds = new Float32Array(PARTICLE_COUNT);
  const oceanRnd = makeSeededUnitRandom(0x0cea11);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Uniform disk sampling (sqrt keeps density even across the circle)
    const r = Math.sqrt(oceanRnd()) * OCEAN_RADIUS;
    const theta = oceanRnd() * Math.PI * 2;
    const x = Math.cos(theta) * r;
    const z = OCEAN_CENTER_Z + Math.sin(theta) * r;
    positions[i * 3] = x;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = z;
    seeds[i] = oceanRnd();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const splashCenters = Array.from({ length: MAX_SPLASHES }, () => new THREE.Vector3(0, -999, 0));
  const splashData = new Float32Array(MAX_SPLASHES * 4); // time, strength, radius, duration

  const baseUniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uOceanCenter: { value: new THREE.Vector2(0, OCEAN_CENTER_Z) },
    uOceanRadius: { value: OCEAN_RADIUS },
    uSplashCenters: { value: splashCenters },
    uSplashData: { value: splashData },
    // Runtime initial ocean grain colour (was hardcoded vec3(1.0, 0.97, 0.9))
    uWaveColor: { value: new THREE.Color(1.0, 0.97, 0.9) },
    uWaveOpacity: { value: 1 },
    uWaveDotScale: { value: 1 },
    uWaveParticleDensity: { value: 1 },
    uWaveRidgeEmphasis: { value: 0 },
    uWaveRidgeWidth: { value: 1 },
    uOceanMasterMult: { value: OCEAN_MASTER_MULT },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, baseUniforms]),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    opacity: 1,
    fog: true,
    vertexShader: /* glsl */ `
      attribute float aSeed;

      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec2 uOceanCenter;
      uniform float uOceanRadius;
      uniform vec3 uSplashCenters[${MAX_SPLASHES}];
      uniform float uSplashData[${MAX_SPLASHES * 4}];
      uniform float uWaveDotScale;
      uniform float uWaveParticleDensity;
      uniform float uWaveRidgeEmphasis;
      uniform float uWaveRidgeWidth;
      uniform float uOceanMasterMult;

      varying float vAlpha;
      varying float vBright;

      #include <fog_pars_vertex>

      ${WAVE_SURFACE_GLSL}

      void main() {
        vec3 pos = position;
        float t = uTime;

        float h = waveHeight(pos.xz, t);
        float splash = splashHeight(pos.xz, t);
        pos.y = h + splash;

        // Splash throws particles away from the viewer (-Z), not toward them
        if (splash > 0.01) {
          pos.z -= splash * (0.45 + aSeed * 0.35);
          pos.x += (aSeed - 0.5) * splash * 0.25;
        }

        // Lateral churn — lively but controlled
        pos.x += sin(h * 1.5 + t * 0.85 + aSeed * 6.28) * 0.075;
        pos.z += cos(h * 1.2 + t * 0.65 + aSeed * 4.1) * 0.05 - max(h, 0.0) * 0.08;

        // Crest spray — present for dynamism, capped so it can't form needles
        float crestLift = max(h - 1.55, 0.0);
        pos.y += crestLift * (0.28 + aSeed * 0.35);
        pos.z -= crestLift * (0.35 + aSeed * 0.45);

        // Splash keeps the sharp vertical throw (scaled with splash height)
        if (splash > 0.01) {
          pos.y += splash * splash * 0.053;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        #include <fog_vertex>

        float heightNorm = clamp((h + splash + 1.5) / 5.0, 0.0, 1.0);

        // Soft circular rim so the disk reads as a round ocean, not a hard cut
        float radial = length(pos.xz - uOceanCenter);
        float edgeFade = 1.0 - smoothstep(uOceanRadius * 0.62, uOceanRadius * 0.98, radial);
        float depthFade = smoothstep(uOceanCenter.y - uOceanRadius * 0.95, uOceanCenter.y + uOceanRadius * 0.35, pos.z);

        // Stipple density: troughs sparse, crests dense/bright
        float densityGate = mix(0.12, 1.0, pow(heightNorm, 1.65));
        densityGate *= mix(0.55, 1.0, depthFade) * edgeFade;

        // Ridge / fold emphasis from wave-height derivatives (does not alter displacement)
        float eps = 0.55;
        float hx = waveHeight(pos.xz + vec2(eps, 0.0), t) - waveHeight(pos.xz - vec2(eps, 0.0), t);
        float hz = waveHeight(pos.xz + vec2(0.0, eps), t) - waveHeight(pos.xz - vec2(0.0, eps), t);
        float slope = length(vec2(hx, hz)) / max(2.0 * eps, 1e-4);
        float widthK = max(uWaveRidgeWidth, 0.25);
        float ridge = smoothstep(0.12 * widthK, 0.95 * widthK, slope);
        ridge = max(ridge, smoothstep(0.55, 1.85, max(h, 0.0)) * 0.55);
        ridge *= clamp(uWaveRidgeEmphasis, 0.0, 4.0) * 0.28;
        densityGate = clamp(densityGate + ridge, 0.0, 1.35);

        // Ranked master field: density 1 ≈ legacy keep rate on base count
        float dens = max(uWaveParticleDensity, 0.01);
        float keepThresh = clamp((densityGate / 0.92) * (dens / max(uOceanMasterMult, 1.0)), 0.0, 1.0);
        float keep = step(aSeed, keepThresh);

        vBright = mix(0.55, 1.0, pow(heightNorm, 1.15));
        // Base opacity kept in the 0.4–0.6 range so stacked splashes don't blow out
        vAlpha = keep * mix(0.4, 0.58, heightNorm) * mix(0.5, 1.0, depthFade) * edgeFade;

        float size = mix(1.0, 2.35, pow(heightNorm, 1.4));
        size *= mix(0.7, 1.1, depthFade) * mix(0.55, 1.0, edgeFade);
        size += splash * 0.18;
        size *= mix(1.0, 1.15, clamp(ridge * 2.0, 0.0, 1.0));
        float pr = uPixelRatio;
        gl_PointSize = size * pr * (45.0 / -mvPosition.z) * uWaveDotScale;
        // Upper bound scales with dot scale so density≠size and high scale is not silently clamped away
        gl_PointSize = clamp(gl_PointSize, 0.35 * pr, max(4.5, 4.5 * uWaveDotScale) * pr);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vBright;
      uniform vec3 uWaveColor;
      uniform float uWaveOpacity;

      #include <fog_pars_fragment>

      void main() {
        if (vAlpha < 0.02) discard;

        // Soft circular point — stipple grain, not hard squares
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float soft = 1.0 - smoothstep(0.15, 0.5, d);

        // RGB = selected wave colour (no strength multiply). Opacity via alpha only.
        vec3 col = uWaveColor;
        float alpha = vAlpha * soft * vBright * uWaveOpacity;
        gl_FragColor = vec4(col, alpha);

        #include <fog_fragment>
      }
    `,
  });

  const uniforms = material.uniforms;
  const ocean = new THREE.Points(geometry, material);
  // Keep particle ocean slightly preferred in depth vs any depth-helper geometry
  ocean.renderOrder = 1;
  scene.add(ocean);

  // ─── Continuous water-depth prepass (invisible; beauty stays particles) ─
  const WATER_DEPTH_BIAS = 0.12;
  const waterDepthRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  waterDepthRT.texture.name = "waterDepthViewZ";

  const waterDepthUniforms = {
    uTime: uniforms.uTime,
    uSplashCenters: uniforms.uSplashCenters,
    uSplashData: uniforms.uSplashData,
    uOceanCenter: uniforms.uOceanCenter,
    uOceanRadius: uniforms.uOceanRadius,
  };

  const waterDepthMaterial = new THREE.ShaderMaterial({
    uniforms: waterDepthUniforms,
    colorWrite: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSplashCenters[${MAX_SPLASHES}];
      uniform float uSplashData[${MAX_SPLASHES * 4}];
      uniform vec2 uOceanCenter;
      uniform float uOceanRadius;
      varying float vViewZ;
      varying float vEdgeKeep;
      ${WAVE_SURFACE_GLSL}
      void main() {
        vec3 pos = position;
        // PlaneGeometry is XZ after rotateX; position.y is 0
        vec2 xz = pos.xz + vec2(0.0, 0.0);
        // Mesh is positioned at ocean centre in Z already — use world xz after modelMatrix
        vec4 world = modelMatrix * vec4(pos.x, 0.0, pos.z, 1.0);
        float y = oceanSurfaceY(world.xz, uTime);
        world.y = y;
        float radial = length(world.xz - vec2(uOceanCenter.x, uOceanCenter.y));
        vEdgeKeep = 1.0 - step(uOceanRadius * 0.995, radial);
        vec4 mv = viewMatrix * world;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        if (vEdgeKeep < 0.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vViewZ;
      varying float vEdgeKeep;
      void main() {
        if (vEdgeKeep < 0.5) discard;
        // Store linear view-space distance (same convention as contour capture)
        gl_FragColor = vec4(vViewZ, 0.0, 0.0, 1.0);
      }
    `,
  });

  const waterDepthGeom = new THREE.PlaneGeometry(
    OCEAN_RADIUS * 2.02,
    OCEAN_RADIUS * 2.02,
    180,
    180
  );
  waterDepthGeom.rotateX(-Math.PI / 2);
  const waterDepthMesh = new THREE.Mesh(waterDepthGeom, waterDepthMaterial);
  waterDepthMesh.position.set(0, 0, OCEAN_CENTER_Z);
  waterDepthMesh.frustumCulled = false;
  const waterDepthScene = new THREE.Scene();
  waterDepthScene.add(waterDepthMesh);

  function resizeWaterDepthTarget() {
    const w = Math.max(1, Math.floor(window.innerWidth * renderer.getPixelRatio()));
    const h = Math.max(1, Math.floor(window.innerHeight * renderer.getPixelRatio()));
    waterDepthRT.setSize(w, h);
  }
  resizeWaterDepthTarget();

  function renderWaterDepthPass() {
    renderer.setRenderTarget(waterDepthRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(waterDepthScene, activeCamera);
    renderer.setRenderTarget(null);
    if (typeof applyBackgroundColour === "function") {
      applyBackgroundColour(getAppearanceColours().background);
    }
  }

  function makeWaterDepthUniforms() {
    return {
      tWaterDepth: { value: waterDepthRT.texture },
      uWaterDepthRes: {
        value: new THREE.Vector2(waterDepthRT.width, waterDepthRT.height),
      },
      uWaterDepthBias: { value: WATER_DEPTH_BIAS },
    };
  }

  const WATER_DEPTH_UNIFORMS_GLSL = /* glsl */ `
    uniform sampler2D tWaterDepth;
    uniform vec2 uWaterDepthRes;
    uniform float uWaterDepthBias;
  `;

  const WATER_DEPTH_OCCLUDE_GLSL = /* glsl */ `
    bool behindWaterCrest(float viewZ) {
      vec2 uv = gl_FragCoord.xy / max(uWaterDepthRes, vec2(1.0));
      float wZ = texture2D(tWaterDepth, uv).r;
      return (wZ > 0.02 && viewZ > wZ + uWaterDepthBias);
    }
  `;

  function syncWaterDepthUniformTargets(targetUniforms) {
    if (!targetUniforms) return;
    if (targetUniforms.tWaterDepth) {
      targetUniforms.tWaterDepth.value = waterDepthRT.texture;
    }
    if (targetUniforms.uWaterDepthRes) {
      targetUniforms.uWaterDepthRes.value.set(
        waterDepthRT.width,
        waterDepthRT.height
      );
    }
  }

  // Shared references so body clipping stays lockstep with ocean displacement
  function makeWaveClipUniforms() {
    return {
      uTime: uniforms.uTime,
      uSplashCenters: uniforms.uSplashCenters,
      uSplashData: uniforms.uSplashData,
      uWaveClipBias: { value: WAVE_CLIP_BIAS },
    };
  }

  const WAVE_CLIP_UNIFORMS_GLSL = /* glsl */ `
    uniform float uTime;
    uniform vec3 uSplashCenters[${MAX_SPLASHES}];
    uniform float uSplashData[${MAX_SPLASHES * 4}];
    uniform float uWaveClipBias;
  `;

  // Basic lights so the solid GLB is visible (ocean shader is unlit)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(6, 12, 8);
  scene.add(keyLight);

  // ─── Shared contour stipple (appearance only; composition untouched) ──
  // Hybrid layers: (A) screen-space depth/normal contours → stippled
  //                (B) sparse dim surface dots
  //                (C) invisible mesh depth for occlusion
  // Same shaders / RT / settings for Projects, About and Interests.

  const CONTOUR_LAYER = 1;
  const CONTOUR_STORAGE_KEY = "stippled-ocean-proj-contour-stipple-v1";
  // Legacy base sample count; master is 8× ranked so surface density 1..8 reveals stably
  const CONTOUR_SURFACE_BASE = 5500;
  const CONTOUR_SURFACE_MASTER_MULT = 8;
  const CONTOUR_SURFACE_COUNT = CONTOUR_SURFACE_BASE * CONTOUR_SURFACE_MASTER_MULT;
  const CONTOUR_SURFACE_BASE_FRAC = 0.55; // prior Contour Stipple "surface density" default
  // Per-model surface seeds (Projects keeps the accepted grain sample set)
  const CONTOUR_SURFACE_SEEDS = {
    projects: 0xc07a01,
    about: 0xc07a02,
    interests: 0xc07a03,
  };

  [
    "stippled-ocean-proj-stipple-proto-v1",
    "stippled-ocean-proj-adaptive-stipple-v1",
  ].forEach((k) => localStorage.removeItem(k));

  const CONTOUR_DEFAULTS = {
    mode: "contour", // "solid" | "contour"
    silhouette: 0.9,
    internal: 0.55,
    edgeThreshold: 0.45,
    stippleSpacing: 2.2,
    contourCssPx: 0.9,
    surfaceStrength: 0.25,
    surfaceCssPx: 0.65,
    surfaceDensity: 0.55,
    contourColor: "#f4efe6",
    surfaceColor: "#d8d2c8",
    debug: "final", // final | depth | normals | edges
  };

  let sharedContourSettings = null;
  const contourModels = []; // floating-model states with contour attached

  function getSharedContourSettings() {
    if (!sharedContourSettings) {
      sharedContourSettings = loadContourSettings();
    }
    return sharedContourSettings;
  }

  function loadContourSettings() {
    try {
      const raw = localStorage.getItem(CONTOUR_STORAGE_KEY);
      if (!raw) return { ...CONTOUR_DEFAULTS };
      const p = JSON.parse(raw);
      const debugOk = ["final", "depth", "normals", "edges"].includes(p.debug);
      return {
        mode: p.mode === "solid" ? "solid" : "contour",
        silhouette: THREE.MathUtils.clamp(Number(p.silhouette) ?? 0.9, 0, 1.5),
        internal: THREE.MathUtils.clamp(Number(p.internal) ?? 0.55, 0, 1.5),
        edgeThreshold: THREE.MathUtils.clamp(
          Number(p.edgeThreshold) ?? 0.45,
          0.05,
          1.5
        ),
        stippleSpacing: THREE.MathUtils.clamp(
          Number(p.stippleSpacing) ?? 2.2,
          1.2,
          5
        ),
        contourCssPx: THREE.MathUtils.clamp(
          Number(p.contourCssPx) ?? 0.9,
          0.5,
          1.3
        ),
        surfaceStrength: THREE.MathUtils.clamp(
          Number(p.surfaceStrength) ?? 0.25,
          0,
          0.8
        ),
        surfaceCssPx: THREE.MathUtils.clamp(
          Number(p.surfaceCssPx) ?? 0.65,
          0.4,
          0.9
        ),
        surfaceDensity: THREE.MathUtils.clamp(
          Number(p.surfaceDensity) ?? 0.55,
          0.15,
          1
        ),
        contourColor:
          typeof p.contourColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.contourColor)
            ? p.contourColor
            : CONTOUR_DEFAULTS.contourColor,
        surfaceColor:
          typeof p.surfaceColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.surfaceColor)
            ? p.surfaceColor
            : CONTOUR_DEFAULTS.surfaceColor,
        debug: debugOk ? p.debug : "final",
      };
    } catch (_) {
      return { ...CONTOUR_DEFAULTS };
    }
  }

  function saveContourSettings(settings) {
    localStorage.setItem(CONTOUR_STORAGE_KEY, JSON.stringify(settings));
  }

  // ─── Global appearance colours (separate from composition storage) ───
  const COLOUR_STORAGE_KEY = "stippled-ocean-appearance-colours-v1";
  // Detected from runtime before this feature — do not invent new look
  const COLOUR_ORIGINALS = Object.freeze({
    background: "#000000",
    bodies: CONTOUR_DEFAULTS.contourColor, // was contour stipple base hue
    waves: "#" + uniforms.uWaveColor.value.getHexString(), // was vec3(1,0.97,0.9)
  });

  function normalizeHexColour(value, fallback) {
    if (typeof value !== "string") return fallback;
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
    return fallback;
  }

  function deriveSurfaceHexFromBodies(bodiesHex) {
    // Same authoritative Bodies hue — ghost hierarchy is alpha (surface strength), not a darker hex
    return bodiesHex;
  }

  function loadAppearanceColours() {
    try {
      const raw = localStorage.getItem(COLOUR_STORAGE_KEY);
      if (!raw) return { ...COLOUR_ORIGINALS };
      const p = JSON.parse(raw);
      return {
        background: normalizeHexColour(p.background, COLOUR_ORIGINALS.background),
        bodies: normalizeHexColour(p.bodies, COLOUR_ORIGINALS.bodies),
        waves: normalizeHexColour(p.waves, COLOUR_ORIGINALS.waves),
      };
    } catch (_) {
      return { ...COLOUR_ORIGINALS };
    }
  }

  function saveAppearanceColours(colours) {
    localStorage.setItem(COLOUR_STORAGE_KEY, JSON.stringify(colours));
  }

  let appearanceColours = loadAppearanceColours();

  function getAppearanceColours() {
    return appearanceColours;
  }

  function applyBackgroundColour(hex) {
    const c = new THREE.Color(hex);
    renderer.setClearColor(c, 1);
    if (scene.fog) scene.fog.color.copy(c);
    document.documentElement.style.background = hex;
    document.body.style.background = hex;
  }

  function applyBodiesColour(hex) {
    contourCompositeUniforms.uContourColor.value.set(hex);
    contourModels.forEach((state) => {
      if (state.surfaceMaterial?.uniforms?.uColor) {
        state.surfaceMaterial.uniforms.uColor.value.set(hex);
      }
    });
    const s = getSharedContourSettings();
    if (s.contourColor !== hex || s.surfaceColor !== hex) {
      sharedContourSettings = {
        ...s,
        contourColor: hex,
        surfaceColor: hex,
      };
    }
  }

  function applyWavesColour(hex) {
    uniforms.uWaveColor.value.set(hex);
  }

  function applyAppearanceColours(colours) {
    appearanceColours = {
      background: normalizeHexColour(colours.background, COLOUR_ORIGINALS.background),
      bodies: normalizeHexColour(colours.bodies, COLOUR_ORIGINALS.bodies),
      waves: normalizeHexColour(colours.waves, COLOUR_ORIGINALS.waves),
    };
    applyBackgroundColour(appearanceColours.background);
    applyBodiesColour(appearanceColours.bodies);
    applyWavesColour(appearanceColours.waves);
    if (typeof updatePresetUI === "function") updatePresetUI();
  }

  // ─── Global visibility (appearance-only; separate from composition) ───
  const VISIBILITY_STORAGE_KEY = "stippled-ocean-appearance-visibility-v1";
  const VISIBILITY_ORIGINALS = Object.freeze({
    bodiesOpacity: 1,
    silhouette: CONTOUR_DEFAULTS.silhouette,
    internal: CONTOUR_DEFAULTS.internal,
    surfaceStrength: CONTOUR_DEFAULTS.surfaceStrength,
    wavesOpacity: 1,
    contrastGuide: false,
  });

  const REFERENCE_LIGHT_COLOURS = Object.freeze({
    background: "#f3e9d6",
    bodies: "#bb4121",
    waves: "#023b69",
  });

  function loadVisibilitySettings() {
    try {
      const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
      if (!raw) {
        // First run: inherit existing contour strengths so look stays unchanged
        const c = getSharedContourSettings();
        return {
          ...VISIBILITY_ORIGINALS,
          silhouette: c.silhouette,
          internal: c.internal,
          surfaceStrength: c.surfaceStrength,
        };
      }
      const p = JSON.parse(raw);
      return {
        bodiesOpacity: THREE.MathUtils.clamp(Number(p.bodiesOpacity) ?? 1, 0, 1),
        silhouette: THREE.MathUtils.clamp(Number(p.silhouette) ?? 0.9, 0, 1.5),
        internal: THREE.MathUtils.clamp(Number(p.internal) ?? 0.55, 0, 1.5),
        surfaceStrength: THREE.MathUtils.clamp(
          Number(p.surfaceStrength) ?? 0.25,
          0,
          0.8
        ),
        wavesOpacity: THREE.MathUtils.clamp(Number(p.wavesOpacity) ?? 1, 0, 1),
        contrastGuide: p.contrastGuide === true,
      };
    } catch (_) {
      return { ...VISIBILITY_ORIGINALS };
    }
  }

  function saveVisibilitySettings(settings) {
    localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(settings));
  }

  let appearanceVisibility = loadVisibilitySettings();

  function getVisibilitySettings() {
    return appearanceVisibility;
  }

  // ─── Mark-making (density / spacing / irregularity — appearance only) ─
  const MARK_STORAGE_KEY = "stippled-ocean-appearance-mark-making-v1";
  const MARK_ORIGINALS = Object.freeze({
    surfaceDensity: 1,
    contourDensity: 1,
    contourWidth: 0.9,
    organicIrregularity: 0,
    bodyDotScale: 1,
    waveParticleDensity: 1,
    waveRidgeEmphasis: 0,
    waveRidgeWidth: 1,
    waveDotScale: 1,
  });

  const REFERENCE_TEXTURE = Object.freeze({
    visibility: {
      bodiesOpacity: 1,
      silhouette: 1.25,
      internal: 1,
      surfaceStrength: 0.45,
      wavesOpacity: 1,
      contrastGuide: false,
    },
    mark: {
      surfaceDensity: 1.75,
      contourDensity: 2.25,
      contourWidth: 1.5,
      organicIrregularity: 0.35,
      bodyDotScale: 1.75,
      waveParticleDensity: 2.25,
      waveRidgeEmphasis: 2.25,
      waveRidgeWidth: 1.4,
      waveDotScale: 1.8,
    },
  });

  function loadMarkSettings() {
    try {
      const raw = localStorage.getItem(MARK_STORAGE_KEY);
      // Migrate prior visibility-stored dot scales once
      let migratedDots = null;
      try {
        const visRaw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
        if (visRaw) {
          const vp = JSON.parse(visRaw);
          if (vp && (vp.bodyDotScale != null || vp.waveDotScale != null)) {
            migratedDots = {
              bodyDotScale: Number(vp.bodyDotScale) || 1,
              waveDotScale: Number(vp.waveDotScale) || 1,
            };
          }
        }
      } catch (_) {
        /* ignore */
      }
      if (!raw) {
        return {
          ...MARK_ORIGINALS,
          ...(migratedDots
            ? {
                bodyDotScale: THREE.MathUtils.clamp(
                  migratedDots.bodyDotScale,
                  0.25,
                  8
                ),
                waveDotScale: THREE.MathUtils.clamp(
                  migratedDots.waveDotScale,
                  0.25,
                  8
                ),
              }
            : null),
        };
      }
      const p = JSON.parse(raw);
      return {
        surfaceDensity: THREE.MathUtils.clamp(Number(p.surfaceDensity) ?? 1, 0.25, 8),
        contourDensity: THREE.MathUtils.clamp(Number(p.contourDensity) ?? 1, 0.25, 8),
        contourWidth: THREE.MathUtils.clamp(Number(p.contourWidth) ?? 0.9, 0.5, 4),
        organicIrregularity: THREE.MathUtils.clamp(
          Number(p.organicIrregularity) ?? 0,
          0,
          1
        ),
        bodyDotScale: THREE.MathUtils.clamp(Number(p.bodyDotScale) ?? 1, 0.25, 8),
        waveParticleDensity: THREE.MathUtils.clamp(
          Number(p.waveParticleDensity) ?? 1,
          0.25,
          8
        ),
        waveRidgeEmphasis: THREE.MathUtils.clamp(
          Number(p.waveRidgeEmphasis) ?? 0,
          0,
          4
        ),
        waveRidgeWidth: THREE.MathUtils.clamp(Number(p.waveRidgeWidth) ?? 1, 0.25, 4),
        waveDotScale: THREE.MathUtils.clamp(Number(p.waveDotScale) ?? 1, 0.25, 8),
      };
    } catch (_) {
      return { ...MARK_ORIGINALS };
    }
  }

  function saveMarkSettings(settings) {
    localStorage.setItem(MARK_STORAGE_KEY, JSON.stringify(settings));
  }

  let appearanceMark = loadMarkSettings();

  function getMarkSettings() {
    return appearanceMark;
  }

  // Colour presets (immutable). Applying goes through applyAppearanceColours only.
  const COLOUR_PRESETS = Object.freeze({
    "black-white": Object.freeze({
      background: "#000000",
      bodies: "#f4efe6",
      waves: "#fffcf3",
    }),
    "cream-orange": Object.freeze({
      background: "#f8e8ce",
      bodies: "#d14a21",
      waves: "#0873b5",
    }),
    "cyan-future": Object.freeze({
      background: "#000000",
      bodies: "#20cccf",
      waves: "#ffffff",
    }),
    "sunset-blaze": Object.freeze({
      background: "#f75636",
      bodies: "#ffffff",
      waves: "#2c152d",
    }),
  });

  // Settings presets — visibility + mark-making + shared contour appearance only.
  // Original Mono recovered from VISIBILITY_ORIGINALS, MARK_ORIGINALS, and
  // CONTOUR_DEFAULTS (identical in aa420c4 / abf8565 / bd83b33 checkpoints).
  const SETTINGS_PRESETS = Object.freeze({
    "original-mono": Object.freeze({
      visibility: Object.freeze({ ...VISIBILITY_ORIGINALS }),
      mark: Object.freeze({ ...MARK_ORIGINALS }),
      contour: Object.freeze({
        mode: "contour",
        edgeThreshold: CONTOUR_DEFAULTS.edgeThreshold,
        contourCssPx: CONTOUR_DEFAULTS.contourCssPx,
        surfaceCssPx: CONTOUR_DEFAULTS.surfaceCssPx,
        debug: "final",
        stippleSpacing: CONTOUR_DEFAULTS.stippleSpacing,
        surfaceDensity: CONTOUR_DEFAULTS.surfaceDensity,
      }),
    }),
    "current-screenshot": Object.freeze({
      visibility: Object.freeze({
        bodiesOpacity: 1,
        silhouette: 0.9,
        internal: 0.55,
        surfaceStrength: 0.25,
        wavesOpacity: 1,
        contrastGuide: false,
      }),
      mark: Object.freeze({
        surfaceDensity: 1.15,
        contourDensity: 1.95,
        contourWidth: 0.9,
        organicIrregularity: 0.12,
        bodyDotScale: 1.3,
        waveParticleDensity: 6,
        waveRidgeEmphasis: 0,
        waveRidgeWidth: 1,
        waveDotScale: 1.5,
      }),
      contour: Object.freeze({
        mode: "contour",
        edgeThreshold: 0.45,
        contourCssPx: 0.9,
        surfaceCssPx: 0.65,
        debug: "final",
        stippleSpacing: CONTOUR_DEFAULTS.stippleSpacing,
        surfaceDensity: CONTOUR_DEFAULTS.surfaceDensity,
      }),
    }),
    "refined-hierarchy": Object.freeze({
      visibility: Object.freeze({
        bodiesOpacity: 1,
        silhouette: 1.15,
        internal: 0.7,
        surfaceStrength: 0.25,
        wavesOpacity: 1,
        contrastGuide: false,
      }),
      mark: Object.freeze({
        surfaceDensity: 1.75,
        contourDensity: 2.75,
        contourWidth: 1.2,
        organicIrregularity: 0.28,
        bodyDotScale: 1.35,
        waveParticleDensity: 3.75,
        waveRidgeEmphasis: 2.1,
        waveRidgeWidth: 1.35,
        waveDotScale: 1.35,
      }),
      contour: Object.freeze({
        mode: "contour",
        edgeThreshold: 0.45,
        contourCssPx: 0.9,
        surfaceCssPx: 0.65,
        debug: "final",
        stippleSpacing: CONTOUR_DEFAULTS.stippleSpacing,
        surfaceDensity: CONTOUR_DEFAULTS.surfaceDensity,
      }),
    }),
  });

  function coloursMatchPreset(colours, preset) {
    return (
      normalizeHexColour(colours.background, "") === preset.background &&
      normalizeHexColour(colours.bodies, "") === preset.bodies &&
      normalizeHexColour(colours.waves, "") === preset.waves
    );
  }

  function nearEq(a, b, eps = 0.001) {
    return Math.abs(Number(a) - Number(b)) <= eps;
  }

  function settingsMatchPreset(vis, mark, contour, preset) {
    const pv = preset.visibility;
    const pm = preset.mark;
    const pc = preset.contour;
    const visOk =
      nearEq(vis.bodiesOpacity, pv.bodiesOpacity) &&
      nearEq(vis.silhouette, pv.silhouette) &&
      nearEq(vis.internal, pv.internal) &&
      nearEq(vis.surfaceStrength, pv.surfaceStrength) &&
      nearEq(vis.wavesOpacity, pv.wavesOpacity) &&
      !!vis.contrastGuide === !!pv.contrastGuide;
    const markOk =
      nearEq(mark.surfaceDensity, pm.surfaceDensity) &&
      nearEq(mark.contourDensity, pm.contourDensity) &&
      nearEq(mark.contourWidth, pm.contourWidth) &&
      nearEq(mark.organicIrregularity, pm.organicIrregularity) &&
      nearEq(mark.bodyDotScale, pm.bodyDotScale) &&
      nearEq(mark.waveParticleDensity, pm.waveParticleDensity) &&
      nearEq(mark.waveRidgeEmphasis, pm.waveRidgeEmphasis) &&
      nearEq(mark.waveRidgeWidth, pm.waveRidgeWidth) &&
      nearEq(mark.waveDotScale, pm.waveDotScale);
    const contourOk =
      contour.mode === pc.mode &&
      nearEq(contour.edgeThreshold, pc.edgeThreshold) &&
      nearEq(contour.contourCssPx, pc.contourCssPx) &&
      nearEq(contour.surfaceCssPx, pc.surfaceCssPx) &&
      contour.debug === pc.debug;
    return visOk && markOk && contourOk;
  }

  function detectColourPresetId() {
    const colours = getAppearanceColours();
    for (const [id, preset] of Object.entries(COLOUR_PRESETS)) {
      if (coloursMatchPreset(colours, preset)) return id;
    }
    return "custom";
  }

  function detectSettingsPresetId() {
    const vis = getVisibilitySettings();
    const mark = getMarkSettings();
    const contour = getSharedContourSettings();
    for (const [id, preset] of Object.entries(SETTINGS_PRESETS)) {
      if (settingsMatchPreset(vis, mark, contour, preset)) return id;
    }
    return "custom";
  }

  function updatePresetUI() {
    const colourId = detectColourPresetId();
    const settingsId = detectSettingsPresetId();
    document.querySelectorAll("[data-colour-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.colourPreset === colourId);
    });
    document.querySelectorAll("[data-settings-preset]").forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        btn.dataset.settingsPreset === settingsId
      );
    });
    const cStatus = document.getElementById("colour-preset-status");
    const sStatus = document.getElementById("settings-preset-status");
    if (cStatus) {
      cStatus.textContent =
        colourId === "custom"
          ? "Custom"
          : btnLabelForColourPreset(colourId);
    }
    if (sStatus) {
      sStatus.textContent =
        settingsId === "custom"
          ? "Custom"
          : btnLabelForSettingsPreset(settingsId);
    }
  }

  function btnLabelForColourPreset(id) {
    return (
      {
        "black-white": "Black & White",
        "cream-orange": "Cream & Orange",
        "cyan-future": "Cyan Future",
        "sunset-blaze": "Sunset Blaze",
      }[id] || id
    );
  }

  function btnLabelForSettingsPreset(id) {
    return (
      {
        "original-mono": "Original Mono",
        "current-screenshot": "Current Screenshot",
        "refined-hierarchy": "Refined Hierarchy",
      }[id] || id
    );
  }

  function syncColourFieldsFromState() {
    const colours = getAppearanceColours();
    ["background", "bodies", "waves"].forEach((key) => {
      const swatch = document.getElementById("colour-" + key);
      const hexField = document.getElementById("colour-" + key + "-hex");
      if (swatch) swatch.value = colours[key];
      if (hexField) hexField.value = colours[key];
    });
  }

  function syncVisibilityFieldsFromState() {
    const vis = getVisibilitySettings();
    const set = (id, outId, value, digits) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (el) el.value = String(value);
      if (out) out.textContent = Number(value).toFixed(digits);
    };
    set("vis-bodies-opacity", "vis-bodies-opacity-val", vis.bodiesOpacity, 2);
    set("vis-silhouette", "vis-silhouette-val", vis.silhouette, 2);
    set("vis-internal", "vis-internal-val", vis.internal, 2);
    set("vis-surface", "vis-surface-val", vis.surfaceStrength, 2);
    set("vis-waves-opacity", "vis-waves-opacity-val", vis.wavesOpacity, 2);
    document.querySelectorAll("[data-contrast-guide]").forEach((btn) => {
      const on = btn.dataset.contrastGuide === "on";
      btn.classList.toggle("is-active", on === vis.contrastGuide);
    });
  }

  function syncMarkFieldsFromState() {
    const mark = getMarkSettings();
    const set = (id, outId, value, digits) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (el) el.value = String(value);
      if (out) out.textContent = Number(value).toFixed(digits);
    };
    set("mark-surface-density", "mark-surface-density-val", mark.surfaceDensity, 2);
    set("mark-contour-density", "mark-contour-density-val", mark.contourDensity, 2);
    set("mark-contour-width", "mark-contour-width-val", mark.contourWidth, 2);
    set("mark-organic", "mark-organic-val", mark.organicIrregularity, 2);
    set("mark-body-dot-scale", "mark-body-dot-scale-val", mark.bodyDotScale, 2);
    set("mark-wave-density", "mark-wave-density-val", mark.waveParticleDensity, 2);
    set("mark-wave-ridge", "mark-wave-ridge-val", mark.waveRidgeEmphasis, 2);
    set("mark-wave-ridge-width", "mark-wave-ridge-width-val", mark.waveRidgeWidth, 2);
    set("mark-wave-dot-scale", "mark-wave-dot-scale-val", mark.waveDotScale, 2);
    updateMarkPerfWarnings();
  }

  function syncContourAppearanceFieldsFromState() {
    const s = getSharedContourSettings();
    const map = [
      ["tune-proj-contour-thresh", "tune-proj-contour-thresh-val", "edgeThreshold", 2],
      ["tune-proj-contour-csize", "tune-proj-contour-csize-val", "contourCssPx", 1],
      ["tune-proj-contour-ssize", "tune-proj-contour-ssize-val", "surfaceCssPx", 2],
    ];
    map.forEach(([id, outId, key, digits]) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (el) el.value = String(s[key]);
      if (out) out.textContent = Number(s[key]).toFixed(digits);
    });
    document.querySelectorAll("[data-contour-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.contourMode === s.mode);
    });
    document.querySelectorAll("[data-contour-debug]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.contourDebug === s.debug);
    });
  }

  function applySettingsPreset(id) {
    const preset = SETTINGS_PRESETS[id];
    if (!preset) return;
    const visNext = { ...getVisibilitySettings(), ...preset.visibility };
    const markNext = { ...preset.mark };
    const contourNext = {
      ...getSharedContourSettings(),
      ...preset.contour,
    };
    saveVisibilitySettings(visNext);
    applyVisibilitySettings(visNext);
    saveMarkSettings(markNext);
    applyMarkSettings(markNext);
    sharedContourSettings = contourNext;
    saveContourSettings(contourNext);
    syncContourUniformsAll();
    applyContourDisplayModeAll();
    syncVisibilityFieldsFromState();
    syncMarkFieldsFromState();
    syncContourAppearanceFieldsFromState();
    updateContrastGuideUI();
    updatePresetUI();
  }

  function applyColourPreset(id) {
    const preset = COLOUR_PRESETS[id];
    if (!preset) return;
    const next = {
      background: preset.background,
      bodies: preset.bodies,
      waves: preset.waves,
    };
    saveAppearanceColours(next);
    applyAppearanceColours(next);
    syncColourFieldsFromState();
    updateContrastGuideUI();
    updatePresetUI();
  }

  function setupPresetControls() {
    document.querySelectorAll("[data-colour-preset]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyColourPreset(btn.dataset.colourPreset);
      });
    });
    document.querySelectorAll("[data-settings-preset]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applySettingsPreset(btn.dataset.settingsPreset);
      });
    });
    const loadBw = document.getElementById("load-original-bw");
    if (loadBw) {
      loadBw.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyColourPreset("black-white");
        applySettingsPreset("original-mono");
      });
    }
    updatePresetUI();
  }

  // Colour-space: THREE r160 enables ColorManagement by default. THREE.Color.set(hex)
  // stores linear working values. All custom body/ocean ShaderMaterials share that
  // uniform path (no extra per-shader sRGB encode). Renderer colour-management is
  // left unchanged so Background / Bodies / Waves stay mutually consistent.

  function srgbChannelToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function relativeLuminanceFromHex(hex) {
    // Prefer CSS hex digits (sRGB) rather than Three's linear .r for diagnostic guide
    const raw = normalizeHexColour(hex, "#000000").slice(1);
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return (
      0.2126 * srgbChannelToLinear(r) +
      0.7152 * srgbChannelToLinear(g) +
      0.0722 * srgbChannelToLinear(b)
    );
  }

  function contrastRatio(l1, l2) {
    const a = Math.max(l1, l2);
    const b = Math.min(l1, l2);
    return (a + 0.05) / (b + 0.05);
  }

  function contrastStatus(ratio) {
    if (ratio >= 3) return "Clear";
    if (ratio >= 2) return "Marginal";
    return "Low";
  }

  function mixHexApprox(bgHex, fgHex, alpha) {
    const a = THREE.MathUtils.clamp(alpha, 0, 1);
    // Blend in sRGB byte space for a simple diagnostic composite estimate
    const bgH = normalizeHexColour(bgHex, "#000000").slice(1);
    const fgH = normalizeHexColour(fgHex, "#000000").slice(1);
    const mixCh = (i) => {
      const b = parseInt(bgH.slice(i, i + 2), 16);
      const f = parseInt(fgH.slice(i, i + 2), 16);
      return Math.round(f * a + b * (1 - a));
    };
    const toHex = (n) => n.toString(16).padStart(2, "0");
    return `#${toHex(mixCh(0))}${toHex(mixCh(2))}${toHex(mixCh(4))}`;
  }

  function updateContrastGuideUI() {
    const panel = document.getElementById("contrast-guide-panel");
    if (!panel) return;
    const vis = getVisibilitySettings();
    panel.hidden = !vis.contrastGuide;
    if (!vis.contrastGuide) return;

    const colours = getAppearanceColours();
    const bgL = relativeLuminanceFromHex(colours.background);
    const wavesL = relativeLuminanceFromHex(colours.waves);
    const bodiesL = relativeLuminanceFromHex(colours.bodies);

    // Effective contour mark vs background: blend with typical silhouette coverage
    const effectiveAlpha = THREE.MathUtils.clamp(
      vis.bodiesOpacity * vis.silhouette * 0.85,
      0,
      1
    );
    const effectiveBodiesHex = mixHexApprox(
      colours.background,
      colours.bodies,
      effectiveAlpha
    );
    const effectiveBodiesL = relativeLuminanceFromHex(effectiveBodiesHex);

    const rows = [
      ["contrast-bodies-bg", contrastRatio(effectiveBodiesL, bgL)],
      ["contrast-waves-bg", contrastRatio(wavesL, bgL)],
      ["contrast-bodies-waves", contrastRatio(bodiesL, wavesL)],
    ];
    rows.forEach(([id, ratio]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const status = contrastStatus(ratio);
      el.textContent = `${status} (${ratio.toFixed(1)}:1)`;
      el.dataset.status = status.toLowerCase();
    });
  }

  function setupVisibilityControls() {
    const root = document.getElementById("appearance-visibility");
    if (!root) return;

    const syncFields = (vis) => {
      const set = (id, outId, value, digits) => {
        const el = document.getElementById(id);
        const out = document.getElementById(outId);
        if (el) el.value = String(value);
        if (out) out.textContent = Number(value).toFixed(digits);
      };
      set("vis-bodies-opacity", "vis-bodies-opacity-val", vis.bodiesOpacity, 2);
      set("vis-silhouette", "vis-silhouette-val", vis.silhouette, 2);
      set("vis-internal", "vis-internal-val", vis.internal, 2);
      set("vis-surface", "vis-surface-val", vis.surfaceStrength, 2);
      set("vis-waves-opacity", "vis-waves-opacity-val", vis.wavesOpacity, 2);
      document.querySelectorAll("[data-contrast-guide]").forEach((btn) => {
        const on = btn.dataset.contrastGuide === "on";
        btn.classList.toggle("is-active", on === vis.contrastGuide);
      });
      updateContrastGuideUI();
    };

    const bind = (id, outId, key, min, max, digits) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (!el) return;
      el.addEventListener("input", () => {
        const value = THREE.MathUtils.clamp(parseFloat(el.value) || min, min, max);
        if (out) out.textContent = value.toFixed(digits);
        const next = { ...getVisibilitySettings(), [key]: value };
        saveVisibilitySettings(next);
        applyVisibilitySettings(next);
        syncFields(getVisibilitySettings());
      });
    };

    bind("vis-bodies-opacity", "vis-bodies-opacity-val", "bodiesOpacity", 0, 1, 2);
    bind("vis-silhouette", "vis-silhouette-val", "silhouette", 0, 1.5, 2);
    bind("vis-internal", "vis-internal-val", "internal", 0, 1.5, 2);
    bind("vis-surface", "vis-surface-val", "surfaceStrength", 0, 0.8, 2);
    bind("vis-waves-opacity", "vis-waves-opacity-val", "wavesOpacity", 0, 1, 2);

    document.querySelectorAll("[data-contrast-guide]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const on = btn.dataset.contrastGuide === "on";
        const next = { ...getVisibilitySettings(), contrastGuide: on };
        saveVisibilitySettings(next);
        applyVisibilitySettings(next);
        syncFields(getVisibilitySettings());
      });
    });

    const resetBtn = document.getElementById("visibility-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = { ...VISIBILITY_ORIGINALS };
        saveVisibilitySettings(next);
        applyVisibilitySettings(next);
        syncFields(next);
      });
    }

    syncFields(getVisibilitySettings());
  }

  function updateMarkPerfWarnings() {
    const mark = getMarkSettings();
    const setWarn = (id, show) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !show;
    };
    setWarn("mark-warn-surface", mark.surfaceDensity >= 4);
    setWarn("mark-warn-contour", mark.contourDensity >= 4);
    setWarn("mark-warn-wave", mark.waveParticleDensity >= 3);
  }

  function setupMarkMakingControls() {
    const root = document.getElementById("appearance-mark-making");
    if (!root) return;

    const syncFields = (mark) => {
      const set = (id, outId, value, digits) => {
        const el = document.getElementById(id);
        const out = document.getElementById(outId);
        if (el) el.value = String(value);
        if (out) out.textContent = Number(value).toFixed(digits);
      };
      set("mark-surface-density", "mark-surface-density-val", mark.surfaceDensity, 2);
      set("mark-contour-density", "mark-contour-density-val", mark.contourDensity, 2);
      set("mark-contour-width", "mark-contour-width-val", mark.contourWidth, 2);
      set("mark-organic", "mark-organic-val", mark.organicIrregularity, 2);
      set("mark-body-dot-scale", "mark-body-dot-scale-val", mark.bodyDotScale, 2);
      set("mark-wave-density", "mark-wave-density-val", mark.waveParticleDensity, 2);
      set("mark-wave-ridge", "mark-wave-ridge-val", mark.waveRidgeEmphasis, 2);
      set("mark-wave-ridge-width", "mark-wave-ridge-width-val", mark.waveRidgeWidth, 2);
      set("mark-wave-dot-scale", "mark-wave-dot-scale-val", mark.waveDotScale, 2);
      updateMarkPerfWarnings();
    };

    const bind = (id, outId, key, min, max, digits, step) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (!el) return;
      const commit = () => {
        const value = THREE.MathUtils.clamp(parseFloat(el.value) || min, min, max);
        if (out) out.textContent = value.toFixed(digits);
        const next = { ...getMarkSettings(), [key]: value };
        saveMarkSettings(next);
        applyMarkSettings(next);
        syncFields(getMarkSettings());
      };
      el.addEventListener("input", commit);
      if (step) el.step = String(step);
    };

    bind("mark-surface-density", "mark-surface-density-val", "surfaceDensity", 0.25, 8, 2);
    bind("mark-contour-density", "mark-contour-density-val", "contourDensity", 0.25, 8, 2);
    bind("mark-contour-width", "mark-contour-width-val", "contourWidth", 0.5, 4, 2);
    bind("mark-organic", "mark-organic-val", "organicIrregularity", 0, 1, 2);
    bind("mark-body-dot-scale", "mark-body-dot-scale-val", "bodyDotScale", 0.25, 8, 2, 0.05);
    bind("mark-wave-density", "mark-wave-density-val", "waveParticleDensity", 0.25, 8, 2);
    bind("mark-wave-ridge", "mark-wave-ridge-val", "waveRidgeEmphasis", 0, 4, 2);
    bind("mark-wave-ridge-width", "mark-wave-ridge-width-val", "waveRidgeWidth", 0.25, 4, 2);
    bind("mark-wave-dot-scale", "mark-wave-dot-scale-val", "waveDotScale", 0.25, 8, 2, 0.05);

    const resetBtn = document.getElementById("mark-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = { ...MARK_ORIGINALS };
        saveMarkSettings(next);
        applyMarkSettings(next);
        syncFields(next);
      });
    }

    const refBtn = document.getElementById("mark-reference-texture");
    if (refBtn) {
      refBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const visNext = {
          ...getVisibilitySettings(),
          ...REFERENCE_TEXTURE.visibility,
        };
        const markNext = { ...REFERENCE_TEXTURE.mark };
        saveVisibilitySettings(visNext);
        applyVisibilitySettings(visNext);
        saveMarkSettings(markNext);
        applyMarkSettings(markNext);
        syncFields(markNext);
        const syncVis = (id, outId, value, digits) => {
          const el = document.getElementById(id);
          const out = document.getElementById(outId);
          if (el) el.value = String(value);
          if (out) out.textContent = Number(value).toFixed(digits);
        };
        syncVis("vis-bodies-opacity", "vis-bodies-opacity-val", visNext.bodiesOpacity, 2);
        syncVis("vis-silhouette", "vis-silhouette-val", visNext.silhouette, 2);
        syncVis("vis-internal", "vis-internal-val", visNext.internal, 2);
        syncVis("vis-surface", "vis-surface-val", visNext.surfaceStrength, 2);
        syncVis("vis-waves-opacity", "vis-waves-opacity-val", visNext.wavesOpacity, 2);
      });
    }

    syncFields(getMarkSettings());
  }

  function setupColourControls() {
    const root = document.getElementById("appearance-colours");
    if (!root) return;

    const bind = (key, swatchId, hexId) => {
      const swatch = document.getElementById(swatchId);
      const hexField = document.getElementById(hexId);
      if (!swatch || !hexField) return;

      const syncFields = (hex) => {
        swatch.value = hex;
        hexField.value = hex;
      };
      syncFields(appearanceColours[key]);

      const commit = (raw) => {
        const hex = normalizeHexColour(raw, appearanceColours[key]);
        syncFields(hex);
        const next = { ...getAppearanceColours(), [key]: hex };
        saveAppearanceColours(next);
        applyAppearanceColours(next);
        updateContrastGuideUI();
      };

      swatch.addEventListener("input", () => commit(swatch.value));
      hexField.addEventListener("input", () => {
        const raw = hexField.value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(raw)) commit(raw);
      });
      hexField.addEventListener("change", () => commit(hexField.value));
      hexField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(hexField.value);
        }
      });
    };

    bind("background", "colour-background", "colour-background-hex");
    bind("bodies", "colour-bodies", "colour-bodies-hex");
    bind("waves", "colour-waves", "colour-waves-hex");

    const resetBtn = document.getElementById("colour-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = { ...COLOUR_ORIGINALS };
        saveAppearanceColours(next);
        applyAppearanceColours(next);
        ["background", "bodies", "waves"].forEach((key) => {
          const swatch = document.getElementById(`colour-${key}`);
          const hexField = document.getElementById(`colour-${key}-hex`);
          if (swatch) swatch.value = next[key];
          if (hexField) hexField.value = next[key];
        });
        updateContrastGuideUI();
      });
    }

    const refBtn = document.getElementById("colour-reference-light");
    if (refBtn) {
      refBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = { ...REFERENCE_LIGHT_COLOURS };
        saveAppearanceColours(next);
        applyAppearanceColours(next);
        ["background", "bodies", "waves"].forEach((key) => {
          const swatch = document.getElementById(`colour-${key}`);
          const hexField = document.getElementById(`colour-${key}-hex`);
          if (swatch) swatch.value = next[key];
          if (hexField) hexField.value = next[key];
        });
        updateContrastGuideUI();
      });
    }
  }

  function seededUnitRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Contour capture: view-space normal (rgb) + camera depth (a) — all contour models
  // Underwater fragments discarded using the shared oceanSurfaceY() before edges run.
  const contourCaptureUniforms = Object.assign(
    makeWaveClipUniforms(),
    makeWaterDepthUniforms()
  );
  const contourCaptureMaterial = new THREE.ShaderMaterial({
    uniforms: contourCaptureUniforms,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vViewNormal;
      varying float vViewZ;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vec4 mv = viewMatrix * world;
        vViewNormal = normalize(normalMatrix * normal);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${WAVE_CLIP_UNIFORMS_GLSL}
      ${WAVE_SURFACE_GLSL}
      ${WATER_DEPTH_UNIFORMS_GLSL}
      ${WATER_DEPTH_OCCLUDE_GLSL}
      varying vec3 vViewNormal;
      varying float vViewZ;
      varying vec3 vWorldPos;
      void main() {
        float waterY = oceanSurfaceY(vWorldPos.xz, uTime);
        if (vWorldPos.y < waterY + uWaveClipBias) discard;
        if (behindWaterCrest(vViewZ)) discard;
        vec3 n = normalize(vViewNormal);
        // Pack view normal; alpha = linear view depth (metres-ish)
        gl_FragColor = vec4(n * 0.5 + 0.5, vViewZ);
      }
    `,
  });

  const contourRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  contourRT.texture.name = "projectsContourBuffer";

  const contourCompositeUniforms = {
    tBuffer: { value: contourRT.texture },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uSilhouette: { value: 0.9 },
    uInternal: { value: 0.55 },
    uThreshold: { value: 0.45 },
    uStippleSpacing: { value: 2.2 },
    uContourCssPx: { value: 0.9 },
    uContourColor: { value: new THREE.Color(CONTOUR_DEFAULTS.contourColor) },
    uScreenRadius: { value: 80 },
    uDebug: { value: 0 },
    uBodiesOpacity: { value: 1 },
    uContourDensity: { value: 1 },
    uContourWidth: { value: 0.9 },
    uOrganicIrregularity: { value: 0 },
    uBodyDotScale: { value: 1 },
    uTime: uniforms.uTime,
    uSplashCenters: uniforms.uSplashCenters,
    uSplashData: uniforms.uSplashData,
    uWaveClipBias: { value: WAVE_CLIP_BIAS },
    uInvProjectionMatrix: { value: new THREE.Matrix4() },
    uInvViewMatrix: { value: new THREE.Matrix4() },
    uProjX: { value: 1 },
    uProjY: { value: 1 },
    uCamMode: { value: 0 }, // 0 perspective, 1 orthographic
    uWaterlineBand: { value: 0.55 },
  };

  // Apply appearance colours once composite uniforms exist (look matches pre-feature)
  applyAppearanceColours(appearanceColours);
  applyVisibilitySettings(appearanceVisibility);
  applyMarkSettings(appearanceMark);

  const contourCompositeMaterial = new THREE.ShaderMaterial({
    uniforms: contourCompositeUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tBuffer;
      uniform vec2 uResolution;
      uniform float uPixelRatio;
      uniform float uSilhouette;
      uniform float uInternal;
      uniform float uThreshold;
      uniform float uStippleSpacing;
      uniform float uContourCssPx;
      uniform vec3 uContourColor;
      uniform float uScreenRadius;
      uniform int uDebug;
      uniform float uBodiesOpacity;
      uniform float uContourDensity;
      uniform float uContourWidth;
      uniform float uOrganicIrregularity;
      uniform float uBodyDotScale;
      ${WAVE_CLIP_UNIFORMS_GLSL}
      uniform mat4 uInvProjectionMatrix;
      uniform mat4 uInvViewMatrix;
      uniform float uProjX;
      uniform float uProjY;
      uniform float uCamMode;
      uniform float uWaterlineBand;
      ${WAVE_SURFACE_GLSL}

      varying vec2 vUv;

      vec4 fetch(vec2 uv) {
        return texture2D(tBuffer, uv);
      }

      float objectMask(vec4 s) {
        // Empty buffer cleared to 0; object has positive view depth
        return step(0.02, s.a);
      }

      vec3 reconstructWorld(vec2 uv, float viewZ) {
        // viewZ = -mv.z (positive distance); rebuild view then world
        vec2 ndc = uv * 2.0 - 1.0;
        vec3 viewPos;
        if (uCamMode > 0.5) {
          viewPos = vec3(ndc.x / max(uProjX, 1e-5), ndc.y / max(uProjY, 1e-5), -viewZ);
        } else {
          viewPos = vec3(
            ndc.x * viewZ / max(uProjX, 1e-5),
            ndc.y * viewZ / max(uProjY, 1e-5),
            -viewZ
          );
        }
        return (uInvViewMatrix * vec4(viewPos, 1.0)).xyz;
      }

      float waterlineSuppress(vec2 uv, float viewZ, float mask) {
        if (mask < 0.5 || viewZ < 0.02) return 1.0;
        vec3 wp = reconstructWorld(uv, viewZ);
        float waterY = oceanSurfaceY(wp.xz, uTime);
        float above = wp.y - waterY;
        // Soften only near the clip boundary so legitimate contours above remain
        return smoothstep(0.0, uWaterlineBand, above);
      }

      void main() {
        vec2 texel = 1.0 / uResolution;
        vec4 c = fetch(vUv);
        float m = objectMask(c);

        // Sobel on depth + normals
        float d[9];
        vec3 n[9];
        int k = 0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec4 s = fetch(vUv + vec2(float(i), float(j)) * texel);
            d[k] = s.a;
            n[k] = s.rgb * 2.0 - 1.0;
            k++;
          }
        }

        float gxD = -d[0] - 2.0*d[3] - d[6] + d[2] + 2.0*d[5] + d[8];
        float gyD = -d[0] - 2.0*d[1] - d[2] + d[6] + 2.0*d[7] + d[8];
        float depthEdge = sqrt(gxD*gxD + gyD*gyD);

        vec3 gxN = -n[0] - 2.0*n[3] - n[6] + n[2] + 2.0*n[5] + n[8];
        vec3 gyN = -n[0] - 2.0*n[1] - n[2] + n[6] + 2.0*n[7] + n[8];
        float normalEdge = length(gxN) + length(gyN);

        // Exterior / overlap silhouettes: strong depth breaks (incl. vs empty)
        float sil = smoothstep(uThreshold * 0.35, uThreshold * 1.8, depthEdge);
        // Suppress glowing artificial waterline from wave-clip depth discontinuity
        float wlKeep = waterlineSuppress(vUv, c.a, m);
        sil *= mix(wlKeep, 1.0, 0.15);
        // Internal form: normal changes on continuous surfaces
        float cont = objectMask(c);
        float internal = smoothstep(uThreshold * 0.25, uThreshold * 1.2, normalEdge) * cont;
        internal *= 1.0 - sil * 0.65;
        internal *= mix(wlKeep, 1.0, 0.55);

        // Distance: keep silhouette, thin internals when small on screen
        float sizeNorm = clamp(uScreenRadius / 140.0, 0.0, 1.0);
        float silW = uSilhouette * mix(1.05, 0.92, sizeNorm);
        float intW = uInternal * mix(0.25, 1.0, sizeNorm);
        float edge = clamp(sil * silW + internal * intW, 0.0, 1.0);

        if (uDebug == 1) {
          float nd = clamp(c.a / 80.0, 0.0, 1.0);
          gl_FragColor = vec4(vec3(nd), m);
          return;
        }
        if (uDebug == 2) {
          gl_FragColor = vec4(c.rgb, m);
          return;
        }
        if (uDebug == 3) {
          gl_FragColor = vec4(vec3(edge), edge);
          return;
        }

        // Stable screen-space stipple with optional organic cell jitter
        float dens = max(uContourDensity, 0.25);
        float spacing = max(uStippleSpacing / dens, 0.35) * uPixelRatio;
        vec2 pixel = vUv * uResolution;
        vec2 cell = floor(pixel / spacing);
        float irreg = clamp(uOrganicIrregularity, 0.0, 1.0);
        // Deterministic hash of cell id — stable under camera motion
        float n1 = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        float n2 = fract(sin(dot(cell, vec2(269.5, 183.3))) * 43758.5453);
        float n3 = fract(sin(dot(cell, vec2(419.2, 371.9))) * 43758.5453);
        vec2 centre = (cell + 0.5) * spacing;
        centre += (vec2(n1, n2) - 0.5) * spacing * irreg * 0.7;
        float dist = length(pixel - centre);
        float baseCss = clamp(uContourCssPx * uBodyDotScale, 0.25, 10.0);
        float radius = baseCss * uPixelRatio * 0.5;
        float dotMask = 1.0 - smoothstep(radius * 0.75, radius * 1.15, dist);
        // Subtle survival variation — breaks perfect grid without flicker
        float survive = mix(1.0, step(irreg * 0.22, n3), irreg);
        dotMask *= survive;

        // Edge strength sampled at the stipple centre (stable, less crawl)
        vec2 centreUv = centre / uResolution;
        vec4 cc = fetch(centreUv);
        float cd[9];
        vec3 cn[9];
        k = 0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec4 s = fetch(centreUv + vec2(float(i), float(j)) * texel);
            cd[k] = s.a;
            cn[k] = s.rgb * 2.0 - 1.0;
            k++;
          }
        }
        float cgxD = -cd[0]-2.0*cd[3]-cd[6]+cd[2]+2.0*cd[5]+cd[8];
        float cgyD = -cd[0]-2.0*cd[1]-cd[2]+cd[6]+2.0*cd[7]+cd[8];
        float cDepth = sqrt(cgxD*cgxD + cgyD*cgyD);
        vec3 cgxN = -cn[0]-2.0*cn[3]-cn[6]+cn[2]+2.0*cn[5]+cn[8];
        vec3 cgyN = -cn[0]-2.0*cn[1]-cn[2]+cn[6]+2.0*cn[7]+cn[8];
        float cNorm = length(cgxN) + length(cgyN);
        float cSil = smoothstep(uThreshold * 0.35, uThreshold * 1.8, cDepth);
        float cWl = waterlineSuppress(centreUv, cc.a, objectMask(cc));
        cSil *= mix(cWl, 1.0, 0.15);
        float cInt = smoothstep(uThreshold * 0.25, uThreshold * 1.2, cNorm) * objectMask(cc);
        cInt *= 1.0 - cSil * 0.65;
        cInt *= mix(cWl, 1.0, 0.55);
        float cEdge = clamp(cSil * silW + cInt * intW, 0.0, 1.0);

        // Contour width: dilate edge band in screen space (multi-row marks, not glow)
        float widthPx = max(uContourWidth, 0.5) * uPixelRatio;
        float dilate = 0.0;
        float stepPx = max(spacing * 0.55, 1.0);
        for (int r = 1; r <= 4; r++) {
          float rad = float(r) * stepPx;
          float fall = (1.0 - smoothstep(0.0, widthPx, rad)) * step(rad, widthPx * 1.05);
          for (int kDir = 0; kDir < 8; kDir++) {
            float ang = float(kDir) * 0.785398163;
            vec2 ouv = centreUv + vec2(cos(ang), sin(ang)) * rad / uResolution;
            vec4 os = fetch(ouv);
            float oSil = 0.0;
            float oInt = 0.0;
            {
              float od0 = fetch(ouv + vec2(-1.0, -1.0) * texel).a;
              float od1 = fetch(ouv + vec2( 0.0, -1.0) * texel).a;
              float od2 = fetch(ouv + vec2( 1.0, -1.0) * texel).a;
              float od3 = fetch(ouv + vec2(-1.0,  0.0) * texel).a;
              float od4 = os.a;
              float od5 = fetch(ouv + vec2( 1.0,  0.0) * texel).a;
              float od6 = fetch(ouv + vec2(-1.0,  1.0) * texel).a;
              float od7 = fetch(ouv + vec2( 0.0,  1.0) * texel).a;
              float od8 = fetch(ouv + vec2( 1.0,  1.0) * texel).a;
              float ogx = -od0 - 2.0*od3 - od6 + od2 + 2.0*od5 + od8;
              float ogy = -od0 - 2.0*od1 - od2 + od6 + 2.0*od7 + od8;
              float oDepth = sqrt(ogx*ogx + ogy*ogy);
              oSil = smoothstep(uThreshold * 0.35, uThreshold * 1.8, oDepth);
              vec3 nC = os.rgb * 2.0 - 1.0;
              vec3 nL = fetch(ouv + vec2(-1.0, 0.0) * texel).rgb * 2.0 - 1.0;
              vec3 nR = fetch(ouv + vec2( 1.0, 0.0) * texel).rgb * 2.0 - 1.0;
              vec3 nD = fetch(ouv + vec2( 0.0,-1.0) * texel).rgb * 2.0 - 1.0;
              vec3 nU = fetch(ouv + vec2( 0.0, 1.0) * texel).rgb * 2.0 - 1.0;
              float oNorm = length(nR - nL) + length(nU - nD);
              oInt = smoothstep(uThreshold * 0.25, uThreshold * 1.2, oNorm) * objectMask(os);
              oInt *= 1.0 - oSil * 0.65;
            }
            float oEdge = clamp(oSil * silW + oInt * intW, 0.0, 1.0);
            dilate = max(dilate, oEdge * fall);
          }
        }
        cEdge = max(cEdge, dilate * 0.92);

        // Pigment-like NormalBlending (non-premultiplied):
        //   RGB   = selectedBodiesColour × restrained form shading
        //   Alpha = edgeMask × stippleDot × masterBodiesOpacity
        float formShade = mix(0.9, 1.0, clamp(cSil * 0.7 + cInt * 0.3, 0.0, 1.0));
        vec3 pigment = uContourColor * formShade;
        float coverage = clamp(cEdge * dotMask * uBodiesOpacity, 0.0, 1.0);
        gl_FragColor = vec4(pigment, coverage);
      }
    `,
  });

  const contourQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    contourCompositeMaterial
  );
  const contourScene = new THREE.Scene();
  contourScene.add(contourQuad);
  const contourCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const depthOnlyMaterial = new THREE.ShaderMaterial({
    uniforms: Object.assign(makeWaveClipUniforms(), makeWaterDepthUniforms()),
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying float vViewZ;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vec4 mv = viewMatrix * world;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${WAVE_CLIP_UNIFORMS_GLSL}
      ${WAVE_SURFACE_GLSL}
      ${WATER_DEPTH_UNIFORMS_GLSL}
      ${WATER_DEPTH_OCCLUDE_GLSL}
      varying vec3 vWorldPos;
      varying float vViewZ;
      void main() {
        float waterY = oceanSurfaceY(vWorldPos.xz, uTime);
        if (vWorldPos.y < waterY + uWaveClipBias) discard;
        if (behindWaterCrest(vViewZ)) discard;
        gl_FragColor = vec4(0.0);
      }
    `,
  });

  function createSolidWaveClipMaterial(original) {
    const src = Array.isArray(original) ? original : [original];
    const mapped = src.map((mat) => {
      if (!mat) return mat;
      const clone = mat.clone();
      clone.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.uTime;
        shader.uniforms.uSplashCenters = uniforms.uSplashCenters;
        shader.uniforms.uSplashData = uniforms.uSplashData;
        shader.uniforms.uWaveClipBias = { value: WAVE_CLIP_BIAS };
        Object.assign(shader.uniforms, makeWaterDepthUniforms());
        shader.vertexShader =
          "varying vec3 vWaveWorldPos;\nvarying float vWaveViewZ;\n" +
          shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
           vWaveWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vWaveViewZ = -(modelViewMatrix * vec4(transformed, 1.0)).z;`
        );
        if (!shader.vertexShader.includes("vWaveWorldPos =")) {
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            `#include <project_vertex>
             vWaveWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
             vWaveViewZ = -mvPosition.z;`
          );
        }
        shader.fragmentShader =
          WAVE_CLIP_UNIFORMS_GLSL +
          "\nvarying vec3 vWaveWorldPos;\nvarying float vWaveViewZ;\n" +
          WAVE_SURFACE_GLSL +
          WATER_DEPTH_UNIFORMS_GLSL +
          WATER_DEPTH_OCCLUDE_GLSL +
          shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
           if (vWaveWorldPos.y < oceanSurfaceY(vWaveWorldPos.xz, uTime) + uWaveClipBias) discard;
           if (behindWaterCrest(vWaveViewZ)) discard;`
        );
      };
      clone.customProgramCacheKey = () => "body-wave-clip-waterdepth-v2";
      return clone;
    });
    return Array.isArray(original) ? mapped : mapped[0];
  }

  function resizeContourTargets() {
    const w = Math.max(1, Math.floor(window.innerWidth * renderer.getPixelRatio()));
    const h = Math.max(1, Math.floor(window.innerHeight * renderer.getPixelRatio()));
    contourRT.setSize(w, h);
    contourCompositeUniforms.uResolution.value.set(w, h);
    contourCompositeUniforms.uPixelRatio.value = renderer.getPixelRatio();
  }
  resizeContourTargets();

  function enableContourLayer(root) {
    root.traverse((obj) => {
      obj.layers.enable(CONTOUR_LAYER);
    });
  }

  function createSurfaceStippleMaterial(settings) {
    return new THREE.ShaderMaterial({
      uniforms: Object.assign(makeWaveClipUniforms(), makeWaterDepthUniforms(), {
        uCssPx: { value: settings.surfaceCssPx },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uColor: { value: new THREE.Color(settings.surfaceColor) },
        uStrength: { value: settings.surfaceStrength },
        uDensity: { value: settings.surfaceDensity },
        uMarkSurfaceDensity: { value: 1 },
        uLightDir: { value: new THREE.Vector3(0.4, 0.85, 0.35).normalize() },
        uScreenRadius: { value: 80 },
        uBodiesOpacity: { value: 1 },
        uBodyDotScale: { value: 1 },
        uOrganicIrregularity: { value: 0 },
        uSurfaceMasterScale: {
          value: (CONTOUR_SURFACE_BASE_FRAC * CONTOUR_SURFACE_BASE) / CONTOUR_SURFACE_COUNT,
        },
      }),
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
      vertexShader: /* glsl */ `
        attribute vec3 aNormal;
        attribute float aRank;

        uniform float uCssPx;
        uniform float uPixelRatio;
        uniform float uStrength;
        uniform float uDensity;
        uniform float uMarkSurfaceDensity;
        uniform float uSurfaceMasterScale;
        uniform vec3 uLightDir;
        uniform float uScreenRadius;
        uniform float uBodiesOpacity;
        uniform float uBodyDotScale;
        uniform float uOrganicIrregularity;

        varying float vAlpha;
        varying float vShade;
        varying vec3 vWorldPos;
        varying float vViewZ;

        void main() {
          vec3 nView = normalize(normalMatrix * aNormal);
          float facing = nView.z;
          float front = smoothstep(-0.05, 0.35, facing);

          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPos = world.xyz;
          vec4 mv = viewMatrix * world;
          vViewZ = -mv.z;
          gl_Position = projectionMatrix * mv;

          float css = clamp(uCssPx * uBodyDotScale, 0.25, 8.0);
          gl_PointSize = css * uPixelRatio;

          float ndl = clamp(dot(nView, normalize(uLightDir)) * 0.5 + 0.5, 0.0, 1.0);
          // Restrained form shading — keep Bodies hue saturated
          vShade = mix(0.9, 1.0, ndl);

          float sizeNorm = clamp(uScreenRadius / 140.0, 0.0, 1.0);
          float distSurf = mix(0.0, 1.0, smoothstep(0.15, 0.55, sizeNorm));
          // Ranked master: density 1 ≈ legacy 0.55 of 5500 points
          float thresh = clamp(
            uSurfaceMasterScale * uMarkSurfaceDensity * distSurf,
            0.0,
            1.0
          );
          float irreg = clamp(uOrganicIrregularity, 0.0, 1.0);
          float jitterGate = mix(1.0, step(irreg * 0.18, fract(aRank * 17.13 + aRank)), irreg);
          float keep = step(aRank, thresh) * jitterGate;
          // Strength + master opacity only through alpha (no hidden 0.85 veil)
          vAlpha = uStrength * uBodiesOpacity * front * keep;
          if (vAlpha < 0.01) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          }
        }
      `,
      fragmentShader: /* glsl */ `
        ${WAVE_CLIP_UNIFORMS_GLSL}
        ${WAVE_SURFACE_GLSL}
        ${WATER_DEPTH_UNIFORMS_GLSL}
        ${WATER_DEPTH_OCCLUDE_GLSL}
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vShade;
        varying vec3 vWorldPos;
        varying float vViewZ;
        void main() {
          if (vAlpha < 0.01) discard;
          float waterY = oceanSurfaceY(vWorldPos.xz, uTime);
          if (vWorldPos.y < waterY + uWaveClipBias) discard;
          if (behindWaterCrest(vViewZ)) discard;
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = 1.0 - smoothstep(0.38, 0.5, d);
          vec3 pigment = uColor * vShade;
          gl_FragColor = vec4(pigment, vAlpha * edge);
        }
      `,
    });
  }

  function sampleSparseSurface(poseRoot, count, seed) {
    poseRoot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(poseRoot.matrixWorld).invert();
    const mat = new THREE.Matrix4();
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tris = [];

    poseRoot.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      const geom = obj.geometry;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const pos = geom.attributes.position;
      const nrm = geom.attributes.normal;
      const index = geom.index;
      mat.multiplyMatrices(inv, obj.matrixWorld);
      const nMat = new THREE.Matrix3().getNormalMatrix(mat);
      const triCount = index ? index.count / 3 : (pos.count / 3) | 0;
      // Stride to keep analysis light
      const stride = Math.max(1, (triCount / 120000) | 0);
      for (let t = 0; t < triCount; t += stride) {
        let i0;
        let i1;
        let i2;
        if (index) {
          i0 = index.getX(t * 3);
          i1 = index.getX(t * 3 + 1);
          i2 = index.getX(t * 3 + 2);
        } else {
          i0 = t * 3;
          i1 = t * 3 + 1;
          i2 = t * 3 + 2;
        }
        va.fromBufferAttribute(pos, i0).applyMatrix4(mat);
        vb.fromBufferAttribute(pos, i1).applyMatrix4(mat);
        vc.fromBufferAttribute(pos, i2).applyMatrix4(mat);
        e1.subVectors(vb, va);
        e2.subVectors(vc, va);
        n.copy(e1).cross(e2);
        const area = n.length() * 0.5;
        if (!(area > 1e-12)) continue;
        n.normalize();
        // Prefer face normal from transformed vertex normals when available
        const na = new THREE.Vector3()
          .fromBufferAttribute(nrm, i0)
          .applyMatrix3(nMat)
          .normalize();
        const nb = new THREE.Vector3()
          .fromBufferAttribute(nrm, i1)
          .applyMatrix3(nMat)
          .normalize();
        const nc = new THREE.Vector3()
          .fromBufferAttribute(nrm, i2)
          .applyMatrix3(nMat)
          .normalize();
        const nn = na.add(nb).add(nc).normalize();
        tris.push({
          ax: va.x,
          ay: va.y,
          az: va.z,
          bx: vb.x,
          by: vb.y,
          bz: vb.z,
          cx: vc.x,
          cy: vc.y,
          cz: vc.z,
          nx: nn.x,
          ny: nn.y,
          nz: nn.z,
          area,
        });
      }
    });

    const posArr = new Float32Array(count * 3);
    const nrmArr = new Float32Array(count * 3);
    const rankArr = new Float32Array(count);
    if (!tris.length) return { posArr, nrmArr, rankArr, count: 0 };

    const cdf = new Float32Array(tris.length);
    let total = 0;
    for (let i = 0; i < tris.length; i++) {
      total += tris[i].area;
      cdf[i] = total;
    }
    const rnd = seededUnitRandom(seed);
    const pick = (r) => {
      const target = r * total;
      let lo = 0;
      let hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return tris[lo];
    };
    for (let i = 0; i < count; i++) {
      const tri = pick(rnd());
      let u = rnd();
      let v = rnd();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;
      const o = i * 3;
      posArr[o] = tri.ax * w + tri.bx * u + tri.cx * v;
      posArr[o + 1] = tri.ay * w + tri.by * u + tri.cy * v;
      posArr[o + 2] = tri.az * w + tri.bz * u + tri.cz * v;
      nrmArr[o] = tri.nx;
      nrmArr[o + 1] = tri.ny;
      nrmArr[o + 2] = tri.nz;
      rankArr[i] = rnd();
    }
    return { posArr, nrmArr, rankArr, count };
  }

  function estimateProjectsScreenRadius(state, cam) {
    if (!state?.contourLocalCenter) return 80;
    state.group.updateWorldMatrix(true, false);
    const center = state.contourLocalCenter
      .clone()
      .applyMatrix4(state.group.matrixWorld);
    const radius = state.contourLocalRadius * Math.abs(state.scale);
    const h = Math.max(window.innerHeight, 1);
    if (cam.isPerspectiveCamera) {
      const dist = Math.max(cam.position.distanceTo(center), 0.05);
      const vFov = (cam.fov * Math.PI) / 180;
      const worldH = 2 * Math.tan(vFov * 0.5) * dist;
      return (radius / worldH) * h;
    }
    const halfH = Math.max((cam.top - cam.bottom) * 0.5, 1e-4);
    return (radius / halfH) * (h * 0.5);
  }

  function applyContourDisplayMode(state) {
    if (!state?.solidMeshes) return;
    const s = getSharedContourSettings();
    const contour = s.mode === "contour";
    const debug = s.debug || "final";

    state.solidMeshes.forEach((entry) => {
      if (contour) {
        entry.mesh.material = depthOnlyMaterial;
        entry.mesh.visible = true;
      } else {
        entry.mesh.material = entry.waveClipMaterial || entry.originalMaterial;
        entry.mesh.visible = true;
      }
    });

    if (state.surfacePoints) {
      state.surfacePoints.visible = contour && debug === "final";
    }
  }

  function applyContourDisplayModeAll() {
    contourModels.forEach(applyContourDisplayMode);
  }

  function syncContourUniforms(state) {
    const s = getSharedContourSettings();
    const vis = getVisibilitySettings();
    const mark = getMarkSettings();
    const bodiesHex = getAppearanceColours().bodies;
    const dotScale = mark.bodyDotScale;

    contourCompositeUniforms.uSilhouette.value = vis.silhouette;
    contourCompositeUniforms.uInternal.value = vis.internal;
    contourCompositeUniforms.uThreshold.value = s.edgeThreshold;
    contourCompositeUniforms.uStippleSpacing.value = s.stippleSpacing;
    contourCompositeUniforms.uContourCssPx.value = s.contourCssPx;
    contourCompositeUniforms.uContourColor.value.set(bodiesHex);
    contourCompositeUniforms.uBodiesOpacity.value = vis.bodiesOpacity;
    contourCompositeUniforms.uContourDensity.value = mark.contourDensity;
    contourCompositeUniforms.uContourWidth.value = mark.contourWidth;
    contourCompositeUniforms.uOrganicIrregularity.value = mark.organicIrregularity;
    contourCompositeUniforms.uBodyDotScale.value = dotScale;
    const debugMap = { final: 0, depth: 1, normals: 2, edges: 3 };
    contourCompositeUniforms.uDebug.value = debugMap[s.debug] ?? 0;

    uniforms.uWaveOpacity.value = vis.wavesOpacity;
    uniforms.uWaveDotScale.value = mark.waveDotScale;
    uniforms.uWaveParticleDensity.value = mark.waveParticleDensity;
    uniforms.uWaveRidgeEmphasis.value = mark.waveRidgeEmphasis;
    uniforms.uWaveRidgeWidth.value = mark.waveRidgeWidth;
    uniforms.uOceanMasterMult.value = OCEAN_MASTER_MULT;

    if (state?.surfaceMaterial) {
      state.surfaceMaterial.uniforms.uCssPx.value = s.surfaceCssPx;
      state.surfaceMaterial.uniforms.uStrength.value = vis.surfaceStrength;
      state.surfaceMaterial.uniforms.uDensity.value = s.surfaceDensity;
      state.surfaceMaterial.uniforms.uMarkSurfaceDensity.value = mark.surfaceDensity;
      state.surfaceMaterial.uniforms.uColor.value.set(bodiesHex);
      state.surfaceMaterial.uniforms.uBodiesOpacity.value = vis.bodiesOpacity;
      state.surfaceMaterial.uniforms.uBodyDotScale.value = dotScale;
      state.surfaceMaterial.uniforms.uOrganicIrregularity.value =
        mark.organicIrregularity;
    }
  }

  function applyVisibilitySettings(settings) {
    appearanceVisibility = {
      bodiesOpacity: THREE.MathUtils.clamp(Number(settings.bodiesOpacity) ?? 1, 0, 1),
      silhouette: THREE.MathUtils.clamp(Number(settings.silhouette) ?? 0.9, 0, 1.5),
      internal: THREE.MathUtils.clamp(Number(settings.internal) ?? 0.55, 0, 1.5),
      surfaceStrength: THREE.MathUtils.clamp(
        Number(settings.surfaceStrength) ?? 0.25,
        0,
        0.8
      ),
      wavesOpacity: THREE.MathUtils.clamp(Number(settings.wavesOpacity) ?? 1, 0, 1),
      contrastGuide: settings.contrastGuide === true,
    };

    const contour = getSharedContourSettings();
    sharedContourSettings = {
      ...contour,
      silhouette: appearanceVisibility.silhouette,
      internal: appearanceVisibility.internal,
      surfaceStrength: appearanceVisibility.surfaceStrength,
    };
    saveContourSettings(sharedContourSettings);

    syncContourUniformsAll();
    updateContrastGuideUI();
    if (typeof updatePresetUI === "function") updatePresetUI();
  }

  function applyMarkSettings(settings) {
    appearanceMark = {
      surfaceDensity: THREE.MathUtils.clamp(Number(settings.surfaceDensity) ?? 1, 0.25, 8),
      contourDensity: THREE.MathUtils.clamp(Number(settings.contourDensity) ?? 1, 0.25, 8),
      contourWidth: THREE.MathUtils.clamp(Number(settings.contourWidth) ?? 0.9, 0.5, 4),
      organicIrregularity: THREE.MathUtils.clamp(
        Number(settings.organicIrregularity) ?? 0,
        0,
        1
      ),
      bodyDotScale: THREE.MathUtils.clamp(Number(settings.bodyDotScale) ?? 1, 0.25, 8),
      waveParticleDensity: THREE.MathUtils.clamp(
        Number(settings.waveParticleDensity) ?? 1,
        0.25,
        8
      ),
      waveRidgeEmphasis: THREE.MathUtils.clamp(
        Number(settings.waveRidgeEmphasis) ?? 0,
        0,
        4
      ),
      waveRidgeWidth: THREE.MathUtils.clamp(Number(settings.waveRidgeWidth) ?? 1, 0.25, 4),
      waveDotScale: THREE.MathUtils.clamp(Number(settings.waveDotScale) ?? 1, 0.25, 8),
    };
    syncContourUniformsAll();
    updateMarkPerfWarnings();
    if (typeof updatePresetUI === "function") updatePresetUI();
  }

  function syncContourUniformsAll() {
    syncContourUniforms(null);
    contourModels.forEach((state) => {
      if (state.surfaceMaterial) syncContourUniforms(state);
    });
  }

  function attachContourStipple(state, solidModel) {
    const settings = getSharedContourSettings();
    state.contourSettings = settings;
    state.solidModel = solidModel;
    state.hasContourStipple = true;

    solidModel.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        if (!obj.geometry.attributes.normal) {
          obj.geometry.computeVertexNormals();
        }
      }
    });

    enableContourLayer(state.group);

    state.solidMeshes = [];
    solidModel.traverse((obj) => {
      if (!obj.isMesh) return;
      state.solidMeshes.push({
        mesh: obj,
        originalMaterial: obj.material,
        waveClipMaterial: createSolidWaveClipMaterial(obj.material),
      });
    });

    const seed =
      CONTOUR_SURFACE_SEEDS[state.id] ?? CONTOUR_SURFACE_SEEDS.projects;
    const sampled = sampleSparseSurface(
      state.pose,
      CONTOUR_SURFACE_COUNT,
      seed
    );
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(sampled.posArr, 3));
    geom.setAttribute("aNormal", new THREE.BufferAttribute(sampled.nrmArr, 3));
    geom.setAttribute("aRank", new THREE.BufferAttribute(sampled.rankArr, 1));
    geom.computeBoundingSphere();

    const surfaceMat = createSurfaceStippleMaterial(settings);
    const surfacePoints = new THREE.Points(geom, surfaceMat);
    surfacePoints.name = `${state.id}ContourSurface`;
    surfacePoints.frustumCulled = true;
    surfacePoints.layers.disable(CONTOUR_LAYER);
    state.pose.add(surfacePoints);
    state.surfacePoints = surfacePoints;
    state.surfaceMaterial = surfaceMat;

    const sphere = geom.boundingSphere.clone();
    state.contourLocalCenter = sphere.center.clone();
    state.contourLocalRadius = Math.max(sphere.radius, 0.05);

    if (!contourModels.includes(state)) contourModels.push(state);

    applyContourDisplayMode(state);
    syncContourUniforms(state);
    applyBodiesColour(getAppearanceColours().bodies);
    console.log(
      `[${state.id} contour] surface dots=${sampled.count}, solid meshes=${state.solidMeshes.length}`
    );
  }

  function renderContourPass() {
    const settings = getSharedContourSettings();
    if (settings.mode !== "contour" || !contourModels.length) return false;

    let maxScreenR = 0;
    contourModels.forEach((state) => {
      const screenR = estimateProjectsScreenRadius(state, activeCamera);
      maxScreenR = Math.max(maxScreenR, screenR);
      if (state.surfaceMaterial) {
        state.surfaceMaterial.uniforms.uScreenRadius.value = screenR;
      }
    });
    // Composite distance falloff: use the largest on-screen model so Projects
    // (and peers at similar depth) keep the accepted silhouette behaviour.
    contourCompositeUniforms.uScreenRadius.value = maxScreenR;

    const prevMask = activeCamera.layers.mask;
    activeCamera.layers.set(CONTOUR_LAYER);
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = contourCaptureMaterial;

    renderer.setRenderTarget(contourRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, activeCamera);

    scene.overrideMaterial = prevOverride;
    activeCamera.layers.mask = prevMask;
    renderer.setRenderTarget(null);
    // Restored by applyBackgroundColour each frame / after pass
    if (typeof applyBackgroundColour === "function") {
      applyBackgroundColour(getAppearanceColours().background);
    } else {
      renderer.setClearColor(0x000000, 1);
    }
    return true;
  }

  function renderContourComposite() {
    renderer.render(contourScene, contourCam);
  }

  // ─── Floating models: load, centre, buoyant update ───────────────────
  const gltfLoader = new GLTFLoader();
  const floatingModels = [];
  let lastFloatTime = 0;

  function createFloatingModel(config) {
    const group = new THREE.Group();
    group.name = `${config.id}Group`;
    scene.add(group);

    // Inner orientation group = manual Rotate X/Y/Z; outer group = buoyancy + wave tilt
    const pose = new THREE.Group();
    pose.name = `${config.id}Pose`;
    pose.rotation.set(
      config.baseRotation.x,
      config.baseRotation.y,
      config.baseRotation.z
    );
    group.add(pose);

    const rotXDeg = Number.isFinite(config.rotXDeg)
      ? config.rotXDeg
      : (config.baseRotation.x * 180) / Math.PI;
    const rotYDeg = Number.isFinite(config.rotYDeg)
      ? config.rotYDeg
      : (config.baseRotation.y * 180) / Math.PI;
    const rotZDeg = Number.isFinite(config.rotZDeg)
      ? config.rotZDeg
      : (config.baseRotation.z * 180) / Math.PI;

    const state = {
      id: config.id,
      label: config.label,
      group,
      pose,
      x: config.x,
      z: config.z,
      scale: config.scale,
      immersionFraction: config.immersion,
      immersionOffset: config.immersionOffset,
      bobResponsiveness: config.bob,
      maxTilt: (config.maxTiltDeg * Math.PI) / 180,
      tiltStrength: FLOAT_TILT_STRENGTH,
      // Manual orientation in degrees (editable base pose — not overwritten by waves)
      rotXDeg,
      rotYDeg,
      rotZDeg,
      initialRotXDeg: rotXDeg,
      initialRotYDeg: rotYDeg,
      initialRotZDeg: rotZDeg,
      halfHeight: 0.5,
      ready: false,
      bobY: 0,
      pitch: 0,
      roll: 0,
    };

    group.position.set(state.x, 0, state.z);
    group.scale.setScalar(state.scale);

    gltfLoader.load(
      config.url,
      (gltf) => {
        // Use gltf.scene directly — do not clone (about-shaardul is large)
        const model = gltf.scene;
        model.name = `${config.id}Model`;

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        pose.add(model);
        state.solidModel = model;

        // Vertical half-extent AFTER base pose, in local units (ignore group scale).
        // Measured on the solid pose only — before contour stipple is attached.
        const prevScale = state.scale;
        group.scale.setScalar(1);
        group.updateMatrixWorld(true);
        const posedBox = new THREE.Box3().setFromObject(pose);
        state.halfHeight = Math.max(0.05, (posedBox.max.y - posedBox.min.y) * 0.5);
        group.scale.setScalar(prevScale);

    if (config.attachContourStipple) {
          attachContourStipple(state, model);
        }

        state.ready = true;

        const t0 = uniforms.uTime.value;
        const surface0 = sampleWaveHeight(state.x, state.z, t0);
        state.bobY =
          surface0 +
          state.halfHeight * state.scale * (1 - 2 * state.immersionFraction) -
          state.immersionOffset;
        group.position.y = state.bobY;

        console.log(`[${config.id}] GLB loaded and added to scene:`, config.url);
      },
      undefined,
      (error) => {
        console.error(
          `[${config.id}] Failed to load GLB "${config.url}". Check the path and that you are serving over http(s), not file://.`,
          error
        );
      }
    );

    floatingModels.push(state);
    return state;
  }

  createFloatingModel({
    id: "projects",
    label: "Projects",
    url: PROJECTS_URL,
    x: activeComposition.projects.x,
    z: activeComposition.projects.z,
    scale: activeComposition.projects.scale,
    immersion: activeComposition.projects.immersion,
    immersionOffset: activeComposition.projects.immersionOffset,
    bob: activeComposition.projects.bob,
    maxTiltDeg: activeComposition.projects.maxTiltDeg,
    rotXDeg: activeComposition.projects.rotXDeg,
    rotYDeg: activeComposition.projects.rotYDeg,
    rotZDeg: activeComposition.projects.rotZDeg,
    attachContourStipple: true,
    baseRotation: {
      x: (activeComposition.projects.rotXDeg * Math.PI) / 180,
      y: (activeComposition.projects.rotYDeg * Math.PI) / 180,
      z: (activeComposition.projects.rotZDeg * Math.PI) / 180,
    },
  });

  createFloatingModel({
    id: "about",
    label: "About",
    url: ABOUT_URL,
    x: activeComposition.about.x,
    z: activeComposition.about.z,
    scale: activeComposition.about.scale,
    immersion: activeComposition.about.immersion,
    immersionOffset: activeComposition.about.immersionOffset,
    bob: activeComposition.about.bob,
    maxTiltDeg: activeComposition.about.maxTiltDeg,
    rotXDeg: activeComposition.about.rotXDeg,
    rotYDeg: activeComposition.about.rotYDeg,
    rotZDeg: activeComposition.about.rotZDeg,
    attachContourStipple: true,
    baseRotation: {
      x: (activeComposition.about.rotXDeg * Math.PI) / 180,
      y: (activeComposition.about.rotYDeg * Math.PI) / 180,
      z: (activeComposition.about.rotZDeg * Math.PI) / 180,
    },
  });

  createFloatingModel({
    id: "interests",
    label: "Interests",
    url: INTERESTS_URL,
    x: activeComposition.interests.x,
    z: activeComposition.interests.z,
    scale: activeComposition.interests.scale,
    immersion: activeComposition.interests.immersion,
    immersionOffset: activeComposition.interests.immersionOffset,
    bob: activeComposition.interests.bob,
    maxTiltDeg: activeComposition.interests.maxTiltDeg,
    rotXDeg: activeComposition.interests.rotXDeg,
    rotYDeg: activeComposition.interests.rotYDeg,
    rotZDeg: activeComposition.interests.rotZDeg,
    attachContourStipple: true,
    baseRotation: {
      x: (activeComposition.interests.rotXDeg * Math.PI) / 180,
      y: (activeComposition.interests.rotYDeg * Math.PI) / 180,
      z: (activeComposition.interests.rotZDeg * Math.PI) / 180,
    },
  });

  function saveCompositionFromModels() {
    const payload = { projects: null, about: null, interests: null };
    floatingModels.forEach((state) => {
      payload[state.id] = {
        x: state.x,
        z: state.z,
        scale: state.scale,
        immersion: state.immersionFraction,
        immersionOffset: state.immersionOffset,
        bob: state.bobResponsiveness,
        maxTiltDeg: (state.maxTilt * 180) / Math.PI,
        rotXDeg: state.rotXDeg,
        rotYDeg: state.rotYDeg,
        rotZDeg: state.rotZDeg,
      };
    });
    localStorage.setItem(COMPOSITION_STORAGE_KEY, JSON.stringify(payload));
  }

  function syncTuneControlsFromState(state) {
    const prefix = `tune-${state.id}`;
    const setPair = (id, value, format) => {
      const input = document.getElementById(id);
      const valueEl = document.getElementById(`${id}-val`);
      if (input) input.value = String(value);
      if (valueEl) valueEl.textContent = format(value);
    };
    setPair(`${prefix}-x`, state.x, (v) => Number(v).toFixed(2));
    setPair(`${prefix}-z`, state.z, (v) => Number(v).toFixed(2));
    setPair(`${prefix}-scale`, state.scale, (v) => Number(v).toFixed(2));
    setPair(`${prefix}-immersion`, state.immersionFraction, (v) => Number(v).toFixed(2));
    setPair(`${prefix}-bob`, state.bobResponsiveness, (v) => Number(v).toFixed(2));
    setPair(`${prefix}-tilt`, (state.maxTilt * 180) / Math.PI, (v) => Number(v).toFixed(1));
    setPair(`${prefix}-rot-x`, state.rotXDeg, (v) => Number(v).toFixed(0));
    setPair(`${prefix}-rot-y`, state.rotYDeg, (v) => Number(v).toFixed(0));
    setPair(`${prefix}-rot-z`, state.rotZDeg, (v) => Number(v).toFixed(0));
  }

  function applyCompositionPreset(preset) {
    floatingModels.forEach((state) => {
      const cfg = preset[state.id];
      if (!cfg) return;
      state.x = cfg.x;
      state.z = cfg.z;
      state.scale = cfg.scale;
      state.immersionFraction = cfg.immersion;
      state.immersionOffset = cfg.immersionOffset;
      state.bobResponsiveness = cfg.bob;
      state.maxTilt = (cfg.maxTiltDeg * Math.PI) / 180;
      state.rotXDeg = cfg.rotXDeg;
      state.rotYDeg = cfg.rotYDeg;
      state.rotZDeg = cfg.rotZDeg;
      // Keep Reset rotation aligned with this composition pose
      state.initialRotXDeg = cfg.rotXDeg;
      state.initialRotYDeg = cfg.rotYDeg;
      state.initialRotZDeg = cfg.rotZDeg;
      applyFloatingModelXZScale(state);
      applyFloatingModelOrientation(state);
      syncTuneControlsFromState(state);
    });
    saveCompositionFromModels();
  }

  function applyFloatingModelXZScale(state) {
    state.group.position.x = state.x;
    state.group.position.z = state.z;
    state.group.scale.setScalar(state.scale);
  }

  // Manual orientation lives only on the inner pose group (degrees → radians)
  function applyFloatingModelOrientation(state) {
    state.pose.rotation.set(
      (state.rotXDeg * Math.PI) / 180,
      (state.rotYDeg * Math.PI) / 180,
      (state.rotZDeg * Math.PI) / 180
    );
  }

  function resetFloatingModelOrientation(state) {
    state.rotXDeg = state.initialRotXDeg;
    state.rotYDeg = state.initialRotYDeg;
    state.rotZDeg = state.initialRotZDeg;
    applyFloatingModelOrientation(state);
  }

  // Each model samples the shared ocean height at its own X/Z (same as GPU waveHeight)
  function updateFloatingModels(time) {
    const dt = Math.min(Math.max(time - lastFloatTime, 0), 0.05);
    lastFloatTime = time;
    const eps = FLOAT_SLOPE_SAMPLE_EPS;

    for (let i = 0; i < floatingModels.length; i++) {
      const state = floatingModels[i];
      if (!state.ready) continue;

      applyFloatingModelXZScale(state);

      const x = state.x;
      const z = state.z;
      const hC = sampleWaveHeight(x, z, time);
      const hL = sampleWaveHeight(x - eps, z, time);
      const hR = sampleWaveHeight(x + eps, z, time);
      const hD = sampleWaveHeight(x, z - eps, time);
      const hU = sampleWaveHeight(x, z + eps, time);

      const targetY =
        hC +
        state.halfHeight * state.scale * (1 - 2 * state.immersionFraction) -
        state.immersionOffset;

      const bobK = 1 - Math.exp(-state.bobResponsiveness * dt);
      state.bobY += (targetY - state.bobY) * bobK;
      state.group.position.y = state.bobY;

      const slopeX = (hR - hL) / (2 * eps);
      const slopeZ = (hU - hD) / (2 * eps);
      const targetPitch = THREE.MathUtils.clamp(
        -slopeZ * state.tiltStrength,
        -state.maxTilt,
        state.maxTilt
      );
      const targetRoll = THREE.MathUtils.clamp(
        slopeX * state.tiltStrength,
        -state.maxTilt,
        state.maxTilt
      );

      const tiltK = 1 - Math.exp(-state.bobResponsiveness * 0.85 * dt);
      state.pitch += (targetPitch - state.pitch) * tiltK;
      state.roll += (targetRoll - state.roll) * tiltK;

      // Wave tilt only on the outer group — intentional base pose stays on `pose`
      state.group.rotation.x = state.pitch;
      state.group.rotation.y = 0;
      state.group.rotation.z = state.roll;
    }
  }

  // ─── Temporary 3-column tune dock (easy to delete later) ─────────────
  function setupFloatTuneDock() {
    const dock = document.getElementById("float-tune-dock");
    const chrome = document.querySelector(".float-tune-chrome");
    const toggle = document.getElementById("float-tune-toggle");
    const viewBar = document.getElementById("view-bar");
    if (!dock) return;

    const stopOceanGestures = (el) => {
      if (!el) return;
      [
        "pointerdown",
        "pointerup",
        "pointermove",
        "click",
        "dblclick",
        "wheel",
        "touchstart",
        "touchmove",
        "touchend",
        "contextmenu",
      ].forEach((type) => {
        el.addEventListener(
          type,
          (event) => {
            event.stopPropagation();
          },
          { passive: type.startsWith("touch") ? false : undefined }
        );
      });
    };
    stopOceanGestures(chrome);
    stopOceanGestures(dock);
    stopOceanGestures(viewBar);
    stopOceanGestures(toggle);

    if (toggle && chrome) {
      toggle.addEventListener("click", () => {
        const hidden = chrome.classList.toggle("is-hidden");
        toggle.textContent = hidden ? "Show Tune" : "Hide Tune";
        toggle.setAttribute("aria-pressed", hidden ? "true" : "false");
      });
    }

    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => setActiveView(btn.dataset.view));
    });
    const fitBtn = document.getElementById("view-fit-all");
    if (fitBtn) fitBtn.addEventListener("click", () => fitTopToAllModels());
    const resetTopBtn = document.getElementById("view-reset-top");
    if (resetTopBtn) resetTopBtn.addEventListener("click", () => resetTopView());
    const zoomSlider = document.getElementById("view-top-zoom");
    if (zoomSlider) {
      syncTopZoomSlider();
      zoomSlider.addEventListener("input", () => {
        const pct = parseFloat(zoomSlider.value);
        if (!Number.isFinite(pct)) return;
        setTopHalfExtentFromZoomSlider(pct);
        const out = document.getElementById("view-top-zoom-val");
        if (out) out.textContent = String(Math.round(pct));
      });
    }

    floatingModels.forEach((state) => {
      const bind = (key, inputId, format = (v) => v.toFixed(2), fromInput = (v) => v) => {
        const input = document.getElementById(inputId);
        const valueEl = document.getElementById(`${inputId}-val`);
        if (!input) return;
        const display = fromInput(state[key]);
        input.value = String(display);
        if (valueEl) valueEl.textContent = format(display);
        input.addEventListener("input", () => {
          const raw = parseFloat(input.value);
          if (!Number.isFinite(raw)) return;
          if (key === "maxTilt") {
            state[key] = (raw * Math.PI) / 180;
          } else {
            state[key] = raw;
          }
          if (valueEl) valueEl.textContent = format(raw);
          applyFloatingModelXZScale(state);
          if (key === "rotXDeg" || key === "rotYDeg" || key === "rotZDeg") {
            applyFloatingModelOrientation(state);
          }
          saveCompositionFromModels();
        });
      };

      const prefix = `tune-${state.id}`;
      bind("x", `${prefix}-x`);
      bind("z", `${prefix}-z`);
      bind("scale", `${prefix}-scale`);
      bind("immersionFraction", `${prefix}-immersion`);
      bind("bobResponsiveness", `${prefix}-bob`);
      bind(
        "maxTilt",
        `${prefix}-tilt`,
        (v) => Number(v).toFixed(1),
        (radians) => (radians * 180) / Math.PI
      );
      bind("rotXDeg", `${prefix}-rot-x`, (v) => Number(v).toFixed(0));
      bind("rotYDeg", `${prefix}-rot-y`, (v) => Number(v).toFixed(0));
      bind("rotZDeg", `${prefix}-rot-z`, (v) => Number(v).toFixed(0));

      const resetBtn = document.getElementById(`${prefix}-rot-reset`);
      if (resetBtn) {
        resetBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          resetFloatingModelOrientation(state);
          ["rot-x", "rot-y", "rot-z"].forEach((axis) => {
            const input = document.getElementById(`${prefix}-${axis}`);
            const valueEl = document.getElementById(`${prefix}-${axis}-val`);
            const deg =
              axis === "rot-x"
                ? state.rotXDeg
                : axis === "rot-y"
                  ? state.rotYDeg
                  : state.rotZDeg;
            if (input) input.value = String(deg);
            if (valueEl) valueEl.textContent = Number(deg).toFixed(0);
          });
          saveCompositionFromModels();
        });
      }
    });

    const restoreBtn = document.getElementById("tune-restore-composition");
    if (restoreBtn) {
      restoreBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyCompositionPreset(cloneComposition(FINAL_COMPOSITION));
      });
    }

    setupContourStippleControls();
    setupColourControls();
    setupVisibilityControls();
    setupMarkMakingControls();
    setupPresetControls();
  }

  function setupContourStippleControls() {
    const applyAppearance = (settings) => {
      sharedContourSettings = settings;
      contourModels.forEach((state) => {
        state.contourSettings = settings;
      });
      syncContourUniformsAll();
      applyContourDisplayModeAll();
      if (typeof updatePresetUI === "function") updatePresetUI();
    };

    const syncMode = (mode) => {
      document.querySelectorAll("[data-contour-mode]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.contourMode === mode);
      });
    };

    const syncDebug = (debug) => {
      document.querySelectorAll("[data-contour-debug]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.contourDebug === debug);
      });
    };

    const settings = getSharedContourSettings();
    const map = [
      ["tune-proj-contour-thresh", "tune-proj-contour-thresh-val", "edgeThreshold", 0.05, 1.5, 2],
      ["tune-proj-contour-csize", "tune-proj-contour-csize-val", "contourCssPx", 0.5, 1.3, 1],
      ["tune-proj-contour-ssize", "tune-proj-contour-ssize-val", "surfaceCssPx", 0.4, 0.9, 2],
    ];

    map.forEach(([id, outId, key, min, max, digits]) => {
      const el = document.getElementById(id);
      const out = document.getElementById(outId);
      if (!el) return;
      el.value = String(settings[key]);
      if (out) out.textContent = Number(settings[key]).toFixed(digits);
      el.addEventListener("input", () => {
        const value = THREE.MathUtils.clamp(parseFloat(el.value) || min, min, max);
        if (out) out.textContent = value.toFixed(digits);
        const next = { ...getSharedContourSettings(), [key]: value };
        saveContourSettings(next);
        applyAppearance(next);
      });
    });

    // Contour/surface colour pickers removed — global COLOURS.Bodies owns hue

    syncMode(settings.mode);
    syncDebug(settings.debug);

    document.querySelectorAll("[data-contour-mode]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const mode = btn.dataset.contourMode === "solid" ? "solid" : "contour";
        const next = { ...getSharedContourSettings(), mode };
        saveContourSettings(next);
        syncMode(mode);
        applyAppearance(next);
      });
    });

    document.querySelectorAll("[data-contour-debug]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const debug = btn.dataset.contourDebug || "final";
        const next = { ...getSharedContourSettings(), debug };
        saveContourSettings(next);
        syncDebug(debug);
        applyAppearance(next);
      });
    });
  }

  setupFloatTuneDock();

  // Invisible circular disc for raycasting against the ocean footprint
  const hitPlane = new THREE.Mesh(
    new THREE.CircleGeometry(OCEAN_RADIUS, 96),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitPlane.rotation.x = -Math.PI / 2;
  hitPlane.position.set(0, 0, OCEAN_CENTER_Z);
  scene.add(hitPlane);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = new THREE.Clock();

  const activeSplashes = [];
  let splashWriteIndex = 0;

  function syncSplashUniforms(time) {
    // Prune finished
    for (let i = activeSplashes.length - 1; i >= 0; i--) {
      if (time - activeSplashes[i].time > activeSplashes[i].duration) {
        activeSplashes.splice(i, 1);
      }
    }

    for (let i = 0; i < MAX_SPLASHES; i++) {
      if (i < activeSplashes.length) {
        const s = activeSplashes[i];
        splashCenters[i].set(s.x, 0, s.z);
        splashData[i * 4] = s.time;
        splashData[i * 4 + 1] = s.strength;
        splashData[i * 4 + 2] = s.radius;
        splashData[i * 4 + 3] = s.duration;
      } else {
        splashCenters[i].set(0, -999, 0);
        splashData[i * 4] = 0;
        splashData[i * 4 + 1] = 0;
        splashData[i * 4 + 2] = 1;
        splashData[i * 4 + 3] = 1;
      }
    }
  }

  function getOceanPoint(clientX, clientY) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObject(hitPlane);
    if (!hits.length) return null;

    const p = hits[0].point;
    const time = uniforms.uTime.value;
    const y = sampleWaveHeight(p.x, p.z, time) + sampleSplashHeight(p.x, p.z, time, activeSplashes);
    return new THREE.Vector3(p.x, y, p.z);
  }

  function focusOnPoint(point) {
    cameraState.targetLookAt.set(point.x, Math.max(point.y, 0.3), point.z);

    // Keep a cinematic offset: slightly elevated, behind the look target toward camera side
    const offset = new THREE.Vector3()
      .subVectors(cameraState.position, cameraState.lookAt)
      .normalize()
      .multiplyScalar(22);

    // Soft lateral bias toward the clicked X so the pan feels intentional
    offset.x += (point.x - cameraState.lookAt.x) * 0.35;
    offset.y = 6.5 + Math.max(point.y, 0) * 0.35;
    offset.z = Math.max(offset.z, 14);

    cameraState.targetPosition.copy(point).add(offset);
    cameraState.targetPosition.y = Math.max(cameraState.targetPosition.y, 5.5);
    clampNavigation();
  }

  const _panRight = new THREE.Vector3();
  const _panForward = new THREE.Vector3();
  const _panMove = new THREE.Vector3();
  const _zoomOffset = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  // Stay near the wave disk — zoom-out capped at 2× the plane radius (center → perimeter)
  const NAV_BOUNDS = {
    maxLookRadius: OCEAN_RADIUS * 0.82,
    minDist: 9,
    maxDist: OCEAN_RADIUS * 2,
    maxCameraRadius: OCEAN_RADIUS * 2,
    minHeight: 4.5,
    maxHeight: 18,
  };

  function clampLookTarget() {
    const look = cameraState.targetLookAt;
    const dx = look.x;
    const dz = look.z - OCEAN_CENTER_Z;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r > NAV_BOUNDS.maxLookRadius) {
      const s = NAV_BOUNDS.maxLookRadius / r;
      look.x = dx * s;
      look.z = OCEAN_CENTER_Z + dz * s;
    }
    look.y = Math.max(look.y, 0.3);
  }

  function clampCameraToPlane() {
    const pos = cameraState.targetPosition;
    const dx = pos.x;
    const dz = pos.z - OCEAN_CENTER_Z;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r > NAV_BOUNDS.maxCameraRadius) {
      const s = NAV_BOUNDS.maxCameraRadius / r;
      pos.x = dx * s;
      pos.z = OCEAN_CENTER_Z + dz * s;
    }
    pos.y = THREE.MathUtils.clamp(pos.y, NAV_BOUNDS.minHeight, NAV_BOUNDS.maxHeight);
  }

  function clampCameraDistance() {
    _zoomOffset.subVectors(cameraState.targetPosition, cameraState.targetLookAt);
    const dist = _zoomOffset.length();
    if (dist < 1e-4) {
      _zoomOffset.set(0, 6, 18);
    }
    const clamped = THREE.MathUtils.clamp(dist, NAV_BOUNDS.minDist, NAV_BOUNDS.maxDist);
    _zoomOffset.setLength(clamped);
    cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
    clampCameraToPlane();
  }

  function clampNavigation() {
    clampLookTarget();
    clampCameraDistance();
  }

  function panCamera(deltaX, deltaY) {
    const dist = cameraState.targetPosition.distanceTo(cameraState.targetLookAt);
    const scale = dist * 0.0018;

    _panForward.subVectors(cameraState.targetLookAt, cameraState.targetPosition);
    _panForward.y = 0;
    if (_panForward.lengthSq() < 1e-6) {
      _panForward.set(0, 0, -1);
    } else {
      _panForward.normalize();
    }
    _panRight.crossVectors(_panForward, WORLD_UP).normalize();

    // Drag the ocean with the fingers (trackpad two-finger scroll)
    _panMove
      .copy(_panRight)
      .multiplyScalar(deltaX * scale)
      .addScaledVector(_panForward, -deltaY * scale);

    cameraState.targetLookAt.add(_panMove);
    cameraState.targetPosition.add(_panMove);
    clampNavigation();
  }

  function zoomCamera(deltaY) {
    _zoomOffset.subVectors(cameraState.targetPosition, cameraState.targetLookAt);
    const dist = _zoomOffset.length();
    if (dist < 1e-4) return;

    const factor = Math.exp(deltaY * 0.009);
    const newDist = THREE.MathUtils.clamp(
      dist * factor,
      NAV_BOUNDS.minDist,
      NAV_BOUNDS.maxDist
    );
    _zoomOffset.multiplyScalar(newDist / dist);
    cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
    clampNavigation();
  }

  // Trackpad / wheel: perspective nav, or Top pan/zoom
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (activeView === "top") {
        if (event.ctrlKey) {
          topView.halfExtent *= Math.exp(event.deltaY * 0.0025);
          topView.halfExtent = THREE.MathUtils.clamp(
            topView.halfExtent,
            topView.minHalfExtent,
            topView.maxHalfExtent
          );
          updateTopCameraFrustum();
          syncTopZoomSlider();
        } else {
          const worldPerPixel = (2 * topView.halfExtent) / Math.max(window.innerHeight, 1);
          // Match ortho mapping: screen right = +X, screen down = +Z
          topView.centerX += event.deltaX * worldPerPixel;
          topView.centerZ += event.deltaY * worldPerPixel;
          updateTopCameraFrustum();
        }
        return;
      }
      if (event.ctrlKey) {
        zoomCamera(event.deltaY);
      } else {
        panCamera(event.deltaX, event.deltaY);
      }
    },
    { passive: false }
  );

  function spawnSplash(point, options = {}) {
    const time = uniforms.uTime.value;
    const splash = {
      x: point.x,
      z: point.z,
      time,
      strength: options.strength ?? 1.0 + Math.random() * 0.35,
      radius: options.radius ?? 3.2 + Math.random() * 1.4,
      duration: options.duration ?? 1.8 + Math.random() * 0.5,
    };

    if (activeSplashes.length >= MAX_SPLASHES) {
      activeSplashes[splashWriteIndex % MAX_SPLASHES] = splash;
      splashWriteIndex++;
    } else {
      activeSplashes.push(splash);
    }
  }

  // Pointer: click = focus, drag = long splash trail, double-click = burst
  let clickTimer = null;
  const CLICK_DELAY = 220;
  const DRAG_THRESHOLD = 8; // px before a press counts as a drag
  const TRAIL_SPACING = 1.15; // world units between trail splash samples

  const dragState = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    isDragging: false,
    lastSplash: null,
  };

  // Top-view pan via right-click drag (does not move models)
  const topPanState = {
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
  };

  canvas.addEventListener("contextmenu", (event) => {
    if (activeView === "top") event.preventDefault();
  });

  function spawnTrailSplash(point, speed) {
    const boost = Math.min(speed / 40, 1.25);
    spawnSplash(point, {
      strength: 0.75 + boost * 0.55 + Math.random() * 0.2,
      radius: 2.4 + boost * 1.6 + Math.random() * 0.6,
      duration: 1.6 + boost * 0.5,
    });
  }

  function maybeSpawnAlongDrag(clientX, clientY, movementSpeed) {
    const point = getOceanPoint(clientX, clientY);
    if (!point) return;

    if (!dragState.lastSplash) {
      spawnTrailSplash(point, movementSpeed);
      dragState.lastSplash = { x: point.x, z: point.z };
      return;
    }

    const dx = point.x - dragState.lastSplash.x;
    const dz = point.z - dragState.lastSplash.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < TRAIL_SPACING) return;

    const originX = dragState.lastSplash.x;
    const originZ = dragState.lastSplash.z;
    const steps = Math.min(Math.floor(dist / TRAIL_SPACING), 8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      spawnTrailSplash(
        new THREE.Vector3(originX + dx * t, point.y, originZ + dz * t),
        movementSpeed
      );
    }
    dragState.lastSplash = { x: point.x, z: point.z };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (activeView === "top") {
      // Right-click (or secondary button) drag pans the Top composition camera
      if (event.button === 2) {
        event.preventDefault();
        topPanState.active = true;
        topPanState.pointerId = event.pointerId;
        topPanState.lastX = event.clientX;
        topPanState.lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.isDragging = false;
    dragState.lastSplash = null;
    clearTimeout(clickTimer);
    clickTimer = null;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (activeView === "top") {
      if (!topPanState.active || event.pointerId !== topPanState.pointerId) return;
      const dx = event.clientX - topPanState.lastX;
      const dy = event.clientY - topPanState.lastY;
      topPanState.lastX = event.clientX;
      topPanState.lastY = event.clientY;
      const worldPerPixel = (2 * topView.halfExtent) / Math.max(window.innerHeight, 1);
      // Drag the map with the cursor (content follows the pointer)
      topView.centerX -= dx * worldPerPixel;
      topView.centerZ -= dy * worldPerPixel;
      updateTopCameraFrustum();
      return;
    }

    if (!dragState.active || event.pointerId !== dragState.pointerId) return;

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);

    if (!dragState.isDragging && pixelDist >= DRAG_THRESHOLD) {
      dragState.isDragging = true;
      // Start the trail at the press point so the stroke feels continuous
      const origin = getOceanPoint(dragState.startX, dragState.startY);
      if (origin) {
        spawnTrailSplash(origin, 0);
        dragState.lastSplash = { x: origin.x, z: origin.z };
      }
    }

    if (dragState.isDragging) {
      const speed = Math.hypot(event.movementX || 0, event.movementY || 0);
      maybeSpawnAlongDrag(event.clientX, event.clientY, speed);
    }
  });

  function endPointer(event) {
    if (topPanState.active && event.pointerId === topPanState.pointerId) {
      topPanState.active = false;
      topPanState.pointerId = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* already released */
      }
      return;
    }

    if (activeView === "top") return;

    if (!dragState.active || event.pointerId !== dragState.pointerId) return;

    const wasDragging = dragState.isDragging;
    const x = event.clientX;
    const y = event.clientY;

    dragState.active = false;
    dragState.pointerId = null;
    dragState.isDragging = false;
    dragState.lastSplash = null;

    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* already released */
    }

    if (wasDragging) return;

    // Short press → delayed focus (so double-click can cancel it)
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (activeView !== "perspective") return;
      const point = getOceanPoint(x, y);
      if (point) focusOnPoint(point);
      clickTimer = null;
    }, CLICK_DELAY);
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("dblclick", (event) => {
    if (activeView !== "perspective") return;
    event.preventDefault();
    clearTimeout(clickTimer);
    clickTimer = null;
    const point = getOceanPoint(event.clientX, event.clientY);
    if (point) {
      spawnSplash(point, {
        strength: 1.2 + Math.random() * 0.4,
        radius: 3.6 + Math.random() * 1.2,
        duration: 2.0 + Math.random() * 0.4,
      });
    }
  });

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateTopCameraFrustum();
    renderer.setSize(w, h);
    uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(uniforms.uPixelRatio.value);
    floatingModels.forEach((state) => {
      if (state.surfaceMaterial?.uniforms?.uPixelRatio) {
        state.surfaceMaterial.uniforms.uPixelRatio.value = uniforms.uPixelRatio.value;
      }
    });
    resizeContourTargets();
    resizeWaterDepthTarget();
    syncWaterDepthUniformTargets(contourCaptureUniforms);
    syncWaterDepthUniformTargets(depthOnlyMaterial.uniforms);
    floatingModels.forEach((state) => {
      if (state.surfaceMaterial) {
        syncWaterDepthUniformTargets(state.surfaceMaterial.uniforms);
      }
    });
  }
  window.addEventListener("resize", onResize);

  const currentLook = cameraState.lookAt.clone();

  function syncContourWaveMatrices(cam) {
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    contourCompositeUniforms.uInvProjectionMatrix.value.copy(cam.projectionMatrix).invert();
    contourCompositeUniforms.uInvViewMatrix.value.copy(cam.matrixWorld);
    contourCompositeUniforms.uProjX.value = cam.projectionMatrix.elements[0];
    contourCompositeUniforms.uProjY.value = cam.projectionMatrix.elements[5];
    contourCompositeUniforms.uCamMode.value = cam.isOrthographicCamera ? 1 : 0;
  }

  function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    uniforms.uTime.value = time;
    syncSplashUniforms(time);

    updateFloatingModels(time);

    if (activeView === "perspective") {
      // Smooth camera ease
      cameraState.position.lerp(cameraState.targetPosition, 0.045);
      cameraState.lookAt.lerp(cameraState.targetLookAt, 0.055);
      camera.position.copy(cameraState.position);
      currentLook.copy(cameraState.lookAt);
      camera.lookAt(currentLook);
    } else {
      updateCompositionLabels();
    }

    syncContourWaveMatrices(activeCamera);
    renderWaterDepthPass();
    syncWaterDepthUniformTargets(contourCaptureUniforms);
    syncWaterDepthUniformTargets(depthOnlyMaterial.uniforms);
    contourModels.forEach((state) => {
      if (state.surfaceMaterial) {
        syncWaterDepthUniformTargets(state.surfaceMaterial.uniforms);
      }
    });
    const contourOn = renderContourPass();

    renderer.autoClear = true;
    renderer.render(scene, activeCamera);

    if (contourOn) {
      renderer.autoClear = false;
      renderContourComposite();
      renderer.autoClear = true;
    }
  }

  animate();
})();
