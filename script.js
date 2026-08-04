import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

(() => {
  "use strict";

  const MAX_SPLASHES = 48;
  // Linear size ×3 → area ×9, so particle count ×9 keeps the same density
  const PARTICLE_COUNT = 1980000;
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
      immersion: 0.5,
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
  const activeComposition = storedComposition || cloneComposition(FINAL_COMPOSITION);
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
    return extra;
  }

  // ─── Particle geometry (circular disk) ──────────────────────────────
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const seeds = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Uniform disk sampling (sqrt keeps density even across the circle)
    const r = Math.sqrt(Math.random()) * OCEAN_RADIUS;
    const theta = Math.random() * Math.PI * 2;
    const x = Math.cos(theta) * r;
    const z = OCEAN_CENTER_Z + Math.sin(theta) * r;
    positions[i * 3] = x;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = z;
    seeds[i] = Math.random();
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

      varying float vAlpha;
      varying float vBright;

      #include <fog_pars_vertex>

      // Value-noise style hash / noise (GPU)
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      float fbm(vec2 p) {
        // Shared with CPU fbm() / sampleWaveHeight() — keep in lockstep.
        float v = 0.0;
        float a = 0.5;
        float f = 1.0;
        float m = 0.0;
        for (int i = 0; i < 4; i++) {
          v += noise(p * f) * a;
          m += a;
          a *= 0.5;
          f *= 2.02;
        }
        return v / m;
      }

      float waveHeight(vec2 xz, float t) {
        // Shared ocean surface (must match CPU sampleWaveHeight).
        // Drift so crests travel toward -Z (away from the camera at +Z)
        float driftX = t * 0.17;
        float driftZ = t * 0.2;

        float h = 0.0;
        // Energetic rolling swells — closer to the dynamic look, without needle spikes
        h += (fbm(xz * 0.07 + vec2(driftX, driftZ)) - 0.5) * 2.95;
        h += (fbm(xz * 0.18 + vec2(driftX * 1.3, driftZ * 1.1)) - 0.5) * 1.15;
        h += (fbm(xz * 0.34 + vec2(-driftX * 0.55, driftZ * 1.25)) - 0.5) * 0.32;

        float crest = max(h, 0.0);
        h += crest * crest * 0.28;

        // Light crest chop for life — low amplitude, mid frequency (not spike spray)
        if (h > 1.35) {
          float chop = noise(xz * 1.6 + vec2(t * 0.45, t * 0.3));
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
          // Anisotropic distance: expand farther away from camera than toward it
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
        return extra;
      }

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

        // Stochastic discard via alpha — sparse troughs
        float keep = step(aSeed * 0.92, densityGate);

        vBright = mix(0.55, 1.0, pow(heightNorm, 1.15));
        // Base opacity kept in the 0.4–0.6 range so stacked splashes don't blow out
        vAlpha = keep * mix(0.4, 0.58, heightNorm) * mix(0.5, 1.0, depthFade) * edgeFade;

        float size = mix(1.0, 2.35, pow(heightNorm, 1.4));
        size *= mix(0.7, 1.1, depthFade) * mix(0.55, 1.0, edgeFade);
        size += splash * 0.18;
        gl_PointSize = size * uPixelRatio * (45.0 / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 0.6 * uPixelRatio, 4.5 * uPixelRatio);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vBright;

      #include <fog_pars_fragment>

      void main() {
        if (vAlpha < 0.02) discard;

        // Soft circular point — stipple grain, not hard squares
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float soft = 1.0 - smoothstep(0.15, 0.5, d);

        // Near-white with a slight gold hint
        vec3 col = vec3(1.0, 0.97, 0.9);
        float alpha = vAlpha * soft * vBright;
        gl_FragColor = vec4(col, alpha);

        #include <fog_fragment>
      }
    `,
  });

  const uniforms = material.uniforms;
  const ocean = new THREE.Points(geometry, material);
  scene.add(ocean);

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
  const CONTOUR_SURFACE_COUNT = 5500;
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
        silhouette: THREE.MathUtils.clamp(Number(p.silhouette) ?? 0.9, 0, 1),
        internal: THREE.MathUtils.clamp(Number(p.internal) ?? 0.55, 0, 1),
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
          0.6
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
  const contourCaptureMaterial = new THREE.ShaderMaterial({
    uniforms: {},
    side: THREE.FrontSide,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vViewNormal;
      varying float vViewZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewNormal = normalize(normalMatrix * normal);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vViewNormal;
      varying float vViewZ;
      void main() {
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
  };

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

      varying vec2 vUv;

      vec4 fetch(vec2 uv) {
        return texture2D(tBuffer, uv);
      }

      float objectMask(vec4 s) {
        // Empty buffer cleared to 0; object has positive view depth
        return step(0.02, s.a);
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
        // Internal form: normal changes on continuous surfaces
        float cont = objectMask(c);
        float internal = smoothstep(uThreshold * 0.25, uThreshold * 1.2, normalEdge) * cont;
        internal *= 1.0 - sil * 0.65;

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

        // Stable screen-space stipple: circular dots on a fixed pixel grid
        float spacing = max(uStippleSpacing, 1.2) * uPixelRatio;
        vec2 pixel = vUv * uResolution;
        vec2 cell = floor(pixel / spacing);
        vec2 centre = (cell + 0.5) * spacing;
        float dist = length(pixel - centre);
        float radius = clamp(uContourCssPx, 0.5, 1.3) * uPixelRatio * 0.5;
        float dotMask = 1.0 - smoothstep(radius * 0.75, radius * 1.15, dist);

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
        float cInt = smoothstep(uThreshold * 0.25, uThreshold * 1.2, cNorm) * objectMask(cc);
        cInt *= 1.0 - cSil * 0.65;
        float cEdge = clamp(cSil * silW + cInt * intW, 0.0, 1.0);

        float alpha = cEdge * dotMask;
        // Controlled brightness — not overexposed white
        vec3 col = uContourColor * mix(0.55, 0.92, cSil * 0.65 + cInt * 0.35);
        gl_FragColor = vec4(col, alpha * 0.92);
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

  const depthOnlyMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
  });

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
      uniforms: {
        uCssPx: { value: settings.surfaceCssPx },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uColor: { value: new THREE.Color(settings.surfaceColor) },
        uStrength: { value: settings.surfaceStrength },
        uDensity: { value: settings.surfaceDensity },
        uLightDir: { value: new THREE.Vector3(0.4, 0.85, 0.35).normalize() },
        uScreenRadius: { value: 80 },
      },
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
        uniform vec3 uLightDir;
        uniform float uScreenRadius;

        varying float vAlpha;
        varying float vShade;

        void main() {
          vec3 nView = normalize(normalMatrix * aNormal);
          // Suppress strongly back-facing
          float facing = nView.z; // in view space, camera looks down -Z; front has +z normal toward camera... 
          // view-space: camera looks -Z, front faces have normal.z > 0 when normalMatrix applied correctly
          float front = smoothstep(-0.05, 0.35, facing);

          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;

          float css = clamp(uCssPx, 0.4, 0.9);
          gl_PointSize = css * uPixelRatio;

          float ndl = clamp(dot(nView, normalize(uLightDir)) * 0.5 + 0.5, 0.0, 1.0);
          vShade = mix(0.35, 0.75, ndl);

          // Distance: drop surface before it becomes an orb
          float sizeNorm = clamp(uScreenRadius / 140.0, 0.0, 1.0);
          float distSurf = mix(0.0, 1.0, smoothstep(0.15, 0.55, sizeNorm));
          float keep = step(aRank, uDensity * distSurf);
          vAlpha = uStrength * front * keep * 0.85;
          if (vAlpha < 0.01) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          }
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vShade;
        void main() {
          if (vAlpha < 0.01) discard;
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = 1.0 - smoothstep(0.38, 0.5, d);
          gl_FragColor = vec4(uColor * vShade, vAlpha * edge);
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
        entry.mesh.material = entry.originalMaterial;
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
    contourCompositeUniforms.uSilhouette.value = s.silhouette;
    contourCompositeUniforms.uInternal.value = s.internal;
    contourCompositeUniforms.uThreshold.value = s.edgeThreshold;
    contourCompositeUniforms.uStippleSpacing.value = s.stippleSpacing;
    contourCompositeUniforms.uContourCssPx.value = s.contourCssPx;
    contourCompositeUniforms.uContourColor.value.set(s.contourColor);
    const debugMap = { final: 0, depth: 1, normals: 2, edges: 3 };
    contourCompositeUniforms.uDebug.value = debugMap[s.debug] ?? 0;

    if (state?.surfaceMaterial) {
      state.surfaceMaterial.uniforms.uCssPx.value = s.surfaceCssPx;
      state.surfaceMaterial.uniforms.uStrength.value = s.surfaceStrength;
      state.surfaceMaterial.uniforms.uDensity.value = s.surfaceDensity;
      state.surfaceMaterial.uniforms.uColor.value.set(s.surfaceColor);
    }
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
    renderer.setClearColor(0x000000, 1);
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
  }

  function setupContourStippleControls() {
    const applyAppearance = (settings) => {
      sharedContourSettings = settings;
      contourModels.forEach((state) => {
        state.contourSettings = settings;
      });
      syncContourUniformsAll();
      applyContourDisplayModeAll();
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
      ["tune-proj-contour-sil", "tune-proj-contour-sil-val", "silhouette", 0, 1, 2],
      ["tune-proj-contour-int", "tune-proj-contour-int-val", "internal", 0, 1, 2],
      ["tune-proj-contour-thresh", "tune-proj-contour-thresh-val", "edgeThreshold", 0.05, 1.5, 2],
      ["tune-proj-contour-space", "tune-proj-contour-space-val", "stippleSpacing", 1.2, 5, 1],
      ["tune-proj-contour-csize", "tune-proj-contour-csize-val", "contourCssPx", 0.5, 1.3, 1],
      ["tune-proj-contour-sstr", "tune-proj-contour-sstr-val", "surfaceStrength", 0, 0.6, 2],
      ["tune-proj-contour-ssize", "tune-proj-contour-ssize-val", "surfaceCssPx", 0.4, 0.9, 2],
      ["tune-proj-contour-sdens", "tune-proj-contour-sdens-val", "surfaceDensity", 0.15, 1, 2],
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

    const cColor = document.getElementById("tune-proj-contour-ccolor");
    const sColor = document.getElementById("tune-proj-contour-scolor");
    if (cColor) {
      cColor.value = settings.contourColor;
      cColor.addEventListener("input", () => {
        const next = { ...getSharedContourSettings(), contourColor: cColor.value };
        saveContourSettings(next);
        applyAppearance(next);
      });
    }
    if (sColor) {
      sColor.value = settings.surfaceColor;
      sColor.addEventListener("input", () => {
        const next = { ...getSharedContourSettings(), surfaceColor: sColor.value };
        saveContourSettings(next);
        applyAppearance(next);
      });
    }

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
  }
  window.addEventListener("resize", onResize);

  const currentLook = cameraState.lookAt.clone();

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
