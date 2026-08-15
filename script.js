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

  // Locked production look (SETTINGS_PRESETS["current-screenshot"] +
  // COLOUR_PRESETS["cream-orange"] + contour defaults). Never read from localStorage.
  const FINAL_LOOK = Object.freeze({
    colours: Object.freeze({
      background: "#f8e8ce",
      bodies: "#bb4121",
      waves: "#0873b5",
    }),
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
      // waveRidgeEmphasis locked at 0 — compiled out of ocean VS
      // waveRidgeWidth unused after ridge compile-out
      waveDotScale: 1.5,
    }),
    contour: Object.freeze({
      mode: "contour",
      edgeThreshold: 0.45,
      contourCssPx: 0.9,
      surfaceCssPx: 0.65,
      debug: "final",
      stippleSpacing: 2.2,
      surfaceDensity: 0.55, // CONTOUR_DEFAULTS.surfaceDensity (contour surface slider)
    }),
  });

  const activeComposition = FINAL_COMPOSITION;

  const canvas = document.getElementById("ocean");

  // Locked production fog (restored exactly when the intro ends).
  const FOG_PRODUCTION_DENSITY = 0.00183;
  // Dense enough that the distant world dissolves into cream before the reveal.
  const FOG_INTRO_DENSITY = 0.0185;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0xf8e8ce, 1);

  const scene = new THREE.Scene();
  // Softly dissolve distant / perimeter particles into the void when zoomed out.
  // Colour matches cream; density starts dense for the intro mist.
  scene.fog = new THREE.FogExp2(0xf8e8ce, FOG_INTRO_DENSITY);

  const camera = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    600
  );

  // ─── Layer 2: global screen-space framing (viewport-normalized) ─────
  // Positive verticalBias shifts the projected world downward so the horizon
  // sits slightly below mathematical centre. Applied via setViewOffset after
  // world-space pose — never via CSS, body moves, or intro-only hacks.
  // Baked from CAM-001 / CAM-002 calibration (verticalBiasPixels = cssH * 0.137).
  const CAMERA_FRAMING = {
    verticalBias: 0.137,
    horizontalBias: 0,
  };

  // Reference CSS viewport used during calibration capture.
  const CAMERA_REF_VIEWPORT = Object.freeze({
    cssWidth: 1536,
    cssHeight: 791,
    aspect: 1536 / 791,
    dpr: 1.25,
  });

  // ─── Baked intro / landing poses (exact captured numbers) ────────────
  // CAM-002 = Loading Shot 2 waypoint (~575 ms).
  // CAM-001 = Loading Shot 3 AND canonical interactive landing (identical).
  const INTRO_CAMERA_SHOTS = Object.freeze({
    distant: Object.freeze({
      id: "CAM-002",
      name: "Initial-Landing-View",
      position: Object.freeze({
        x: -292.3983285761905,
        y: 22.095588722659762,
        z: -85.53198854717607,
      }),
      target: Object.freeze({
        x: -93.122,
        y: 1.133,
        z: -93.75,
      }),
      distance: 200.54431173433957,
    }),
    final: Object.freeze({
      id: "CAM-001",
      name: "Final-Landing-View",
      position: Object.freeze({
        x: -65.461,
        y: 20.7,
        z: -66.641,
      }),
      target: Object.freeze({
        x: -18.8,
        y: 1.133,
        z: -96.27,
      }),
      distance: 58.63441012750108,
    }),
  });

  // Canonical hero = Shot 3 / CAM-001 (ordinary navigation space after intro).
  const HERO_LOOK_AT = INTRO_CAMERA_SHOTS.final.target;
  const HERO_POSITION = INTRO_CAMERA_SHOTS.final.position;

  // Intro timing.
  const INTRO_DURATION_MS = 1600;
  // Debug / reference marker for exact CAM-002 (not a timed pause in the flight).
  const INTRO_SHOT2_MS = 575;
  // Freeze opening extrapolation to the original 1.5s segment ratio so the
  // start camera pose stays identical when duration is 1.6s.
  const INTRO_OPENING_K = 575 / 925;

  function heroDistancePull() {
    // Prefer aspect over width alone so portrait keeps the full trio in frame.
    // At the calibration reference aspect, pull MUST be 1 (exact baked numbers).
    const w = window.innerWidth;
    const h = Math.max(window.innerHeight, 1);
    const aspect = w / h;
    if (
      Math.abs(aspect - CAMERA_REF_VIEWPORT.aspect) < 0.012 &&
      Math.abs(w - CAMERA_REF_VIEWPORT.cssWidth) < 48
    ) {
      return 1;
    }
    if (aspect < 0.7) return 2.35;
    if (aspect < 1.0) return 1.45;
    if (aspect < 1.25) return 1.12;
    if (w < 1100) return 1.05;
    return 1;
  }

  // Scratch used only while applying hero / pitch clamps (no per-frame alloc).
  const _heroOffset = new THREE.Vector3();
  const _introPos = new THREE.Vector3();
  const _introLook = new THREE.Vector3();
  const _introPosA = new THREE.Vector3();
  const _introLookA = new THREE.Vector3();
  const _introPosB = new THREE.Vector3();
  const _introLookB = new THREE.Vector3();
  const _introPosS = new THREE.Vector3();
  const _introLookS = new THREE.Vector3();

  function writeHeroPose(outPos, outLook) {
    outLook.set(HERO_LOOK_AT.x, HERO_LOOK_AT.y, HERO_LOOK_AT.z);
    _heroOffset.set(
      HERO_POSITION.x - HERO_LOOK_AT.x,
      HERO_POSITION.y - HERO_LOOK_AT.y,
      HERO_POSITION.z - HERO_LOOK_AT.z
    );
    const pull = heroDistancePull();
    if (pull !== 1) _heroOffset.multiplyScalar(pull);
    outPos.copy(outLook).add(_heroOffset);
  }

  function writeDistantPose(outPos, outLook) {
    const d = INTRO_CAMERA_SHOTS.distant;
    outLook.set(d.target.x, d.target.y, d.target.z);
    _heroOffset.set(
      d.position.x - d.target.x,
      d.position.y - d.target.y,
      d.position.z - d.target.z
    );
    const pull = heroDistancePull();
    // Distant shot pulls back a little less aggressively than the hero (already far).
    const distantPull = 1 + (pull - 1) * 0.55;
    if (distantPull !== 1) _heroOffset.multiplyScalar(distantPull);
    outPos.copy(outLook).add(_heroOffset);
  }

  // Concealed opening pose ahead of CAM-002 on the flight path.
  // INTRO_OPENING_K freezes the start coordinates (unchanged vs the calibrated bake).
  function writeOpeningPose(outPos, outLook) {
    writeDistantPose(_introPosA, _introLookA);
    writeHeroPose(_introPosB, _introLookB);
    const k = INTRO_OPENING_K;
    // start = shot2 + (shot2 - final) * k
    outPos
      .copy(_introPosA)
      .sub(_introPosB)
      .multiplyScalar(k)
      .add(_introPosA);
    outLook
      .copy(_introLookA)
      .sub(_introLookB)
      .multiplyScalar(k)
      .add(_introLookA);
  }

  const cameraState = {
    position: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
    targetPosition: new THREE.Vector3(),
    targetLookAt: new THREE.Vector3(),
  };

  const currentLook = new THREE.Vector3();

  // Canonical camera pipeline (world pose → orientation → aspect → framing bias).
  // Every intro/nav/focus/resize path must end here — never write projection alone.
  function applyCameraProjection() {
    const w = Math.max(1, window.innerWidth | 0);
    const h = Math.max(1, window.innerHeight | 0);
    camera.aspect = w / h;
    // Positive CAMERA_FRAMING bias → world reads lower in the CSS viewport.
    // Three.js setViewOffset: positive offsetY shifts the frustum so content
    // moves upward on screen; we negate so production bias stays intuitive.
    const ox = -CAMERA_FRAMING.horizontalBias * w;
    const oy = -CAMERA_FRAMING.verticalBias * h;
    camera.setViewOffset(w, h, ox, oy, w, h);
    camera.updateProjectionMatrix();
  }

  function commitLiveCamera() {
    camera.position.copy(cameraState.position);
    currentLook.copy(cameraState.lookAt);
    camera.lookAt(currentLook);
    applyCameraProjection();
  }

  function syncCameraTargetsFromLive() {
    cameraState.targetPosition.copy(cameraState.position);
    cameraState.targetLookAt.copy(cameraState.lookAt);
  }

  // Start at distant pose behind the cream veil (no flash of the final framing).
  writeDistantPose(cameraState.position, cameraState.lookAt);
  syncCameraTargetsFromLive();
  commitLiveCamera();

  // Perspective camera only (top/ortho composition view removed).

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
        if (i >= uActiveSplashCount) break;
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
    uOceanMasterMult: { value: OCEAN_MASTER_MULT },
    uActiveSplashCount: { value: 0 },
    // Temporary body-selection pigment ripple (navy ← #bb4121 contamination)
    uPigmentColor: { value: new THREE.Color(0xbb4121) },
    uPigmentCenter: { value: new THREE.Vector2(0, 0) },
    uPigmentAge: { value: 99 },
    uPigmentDuration: { value: 1.25 },
    uPigmentStrength: { value: 0 },
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
      uniform float uOceanMasterMult;
      uniform int uActiveSplashCount;

      varying float vAlpha;
      varying float vBright;
      varying vec2 vWorldXZ;

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

        vWorldXZ = pos.xz;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        #include <fog_vertex>

        float heightNorm = clamp((h + splash + 1.5) / 5.0, 0.0, 1.0);

        // Soft circular rim so the disk reads as a round ocean, not a hard cut
        float radial = length(pos.xz - uOceanCenter);
        float edgeFade = 1.0 - smoothstep(uOceanRadius * 0.62, uOceanRadius * 0.98, radial);
        float depthFade = smoothstep(uOceanCenter.y - uOceanRadius * 0.95, uOceanCenter.y + uOceanRadius * 0.35, pos.z);

        // Stipple density: troughs sparse, crests dense/bright
        // Ridge emphasis compiled out (locked FINAL_LOOK waveRidgeEmphasis = 0):
        // former ridge add was *0, and size *= mix(1.0, 1.15, ridge*2) was *= 1.0.
        float densityGate = mix(0.12, 1.0, pow(heightNorm, 1.65));
        densityGate *= mix(0.55, 1.0, depthFade) * edgeFade;

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
        float pr = uPixelRatio;
        gl_PointSize = size * pr * (45.0 / -mvPosition.z) * uWaveDotScale;
        // Upper bound scales with dot scale so density≠size and high scale is not silently clamped away
        gl_PointSize = clamp(gl_PointSize, 0.35 * pr, max(4.5, 4.5 * uWaveDotScale) * pr);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vBright;
      varying vec2 vWorldXZ;
      uniform vec3 uWaveColor;
      uniform float uWaveOpacity;
      uniform vec3 uPigmentColor;
      uniform vec2 uPigmentCenter;
      uniform float uPigmentAge;
      uniform float uPigmentDuration;
      uniform float uPigmentStrength;

      #include <fog_pars_fragment>

      void main() {
        if (vAlpha < 0.02) discard;

        // Soft circular point — stipple grain, not hard squares
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float soft = 1.0 - smoothstep(0.15, 0.5, d);

        vec3 col = uWaveColor;
        if (uPigmentStrength > 0.001 && uPigmentAge < uPigmentDuration) {
          float life = clamp(uPigmentAge / max(uPigmentDuration, 1e-4), 0.0, 1.0);
          vec2 delta = vWorldXZ - uPigmentCenter;
          float dist = length(delta);
          float ang = atan(delta.y, delta.x);
          float irreg = sin(ang * 5.0 + life * 9.0) * 0.12 + sin(ang * 2.3 - life * 4.0) * 0.07;
          float waveR = life * 26.0 * (1.0 + irreg * 0.35);
          float band = 3.2 + life * 7.5;
          float ring = exp(-pow(dist - waveR, 2.0) / max(band * band, 1e-3));
          float core = exp(-(dist * dist) / pow(5.5 * (1.0 - life * 0.55), 2.0)) * (1.0 - life);
          float stain =
            (ring * 0.9 + core * 0.45) *
            (1.0 - smoothstep(0.55, 1.0, life)) *
            uPigmentStrength;
          col = mix(col, uPigmentColor, clamp(stain, 0.0, 0.82));
        }

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
    uActiveSplashCount: uniforms.uActiveSplashCount,
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
      uniform int uActiveSplashCount;
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
    renderer.render(waterDepthScene, camera);
    renderer.setRenderTarget(null);
    restoreBackgroundClearColor();
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
      uActiveSplashCount: uniforms.uActiveSplashCount,
      uWaveClipBias: { value: WAVE_CLIP_BIAS },
    };
  }

  const WAVE_CLIP_UNIFORMS_GLSL = /* glsl */ `
    uniform float uTime;
    uniform vec3 uSplashCenters[${MAX_SPLASHES}];
    uniform float uSplashData[${MAX_SPLASHES * 4}];
    uniform int uActiveSplashCount;
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

  // Body surface master trim threshold (opt 3). Proof:
  //   uSurfaceMasterScale = (0.55 * 5500) / 44000 = 0.06875
  //   max thresh = 0.06875 * mark.surfaceDensity(1.15) * distSurf(1) = 0.0790625
  // Organic irreg only reduces keep via jitterGate; never raises thresh.
  const SURFACE_RANK_KEEP_MAX = 0.0790625 + 1e-6;

  // Locked contour settings (baked from FINAL_LOOK; no localStorage).
  const sharedContourSettings = Object.freeze({
    mode: FINAL_LOOK.contour.mode,
    silhouette: FINAL_LOOK.visibility.silhouette,
    internal: FINAL_LOOK.visibility.internal,
    edgeThreshold: FINAL_LOOK.contour.edgeThreshold,
    stippleSpacing: FINAL_LOOK.contour.stippleSpacing,
    contourCssPx: FINAL_LOOK.contour.contourCssPx,
    surfaceStrength: FINAL_LOOK.visibility.surfaceStrength,
    surfaceCssPx: FINAL_LOOK.contour.surfaceCssPx,
    surfaceDensity: FINAL_LOOK.contour.surfaceDensity,
    contourColor: FINAL_LOOK.colours.bodies,
    surfaceColor: FINAL_LOOK.colours.bodies,
    debug: FINAL_LOOK.contour.debug,
  });
  const contourModels = []; // floating-model states with contour attached

  function getSharedContourSettings() {
    return sharedContourSettings;
  }

  function normalizeHexColour(value, fallback) {
    if (typeof value !== "string") return fallback;
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
    return fallback;
  }

  const appearanceColours = {
    background: normalizeHexColour(FINAL_LOOK.colours.background, "#f8e8ce"),
    bodies: normalizeHexColour(FINAL_LOOK.colours.bodies, "#bb4121"),
    waves: normalizeHexColour(FINAL_LOOK.colours.waves, "#0873b5"),
  };

  const bgClearColor = new THREE.Color(appearanceColours.background);

  function getAppearanceColours() {
    return appearanceColours;
  }

  function restoreBackgroundClearColor() {
    renderer.setClearColor(bgClearColor, 1);
  }

  function applyBackgroundColour(hex) {
    const normalized = normalizeHexColour(hex, appearanceColours.background);
    appearanceColours.background = normalized;
    bgClearColor.set(normalized);
    renderer.setClearColor(bgClearColor, 1);
    if (scene.fog) scene.fog.color.copy(bgClearColor);
    document.documentElement.style.background = normalized;
    document.body.style.background = normalized;
  }

  function applyBodiesColour(hex) {
    const normalized = normalizeHexColour(hex, appearanceColours.bodies);
    appearanceColours.bodies = normalized;
    if (contourCompositeUniforms?.uContourColor) {
      contourCompositeUniforms.uContourColor.value.set(normalized);
    }
    contourModels.forEach((state) => {
      if (state.surfaceMaterial?.uniforms?.uColor) {
        state.surfaceMaterial.uniforms.uColor.value.set(normalized);
      }
    });
  }

  function applyWavesColour(hex) {
    const normalized = normalizeHexColour(hex, appearanceColours.waves);
    appearanceColours.waves = normalized;
    uniforms.uWaveColor.value.set(normalized);
  }

  // Colour-space: THREE r160 enables ColorManagement by default. THREE.Color.set(hex)
  // stores linear working values. All custom body/ocean ShaderMaterials share that
  // uniform path (no extra per-shader sRGB encode). Renderer colour-management is
  // left unchanged so Background / Bodies / Waves stay mutually consistent.

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
    uContourColor: { value: new THREE.Color(appearanceColours.bodies) },
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
    uActiveSplashCount: uniforms.uActiveSplashCount,
    uWaveClipBias: { value: WAVE_CLIP_BIAS },
    uInvProjectionMatrix: { value: new THREE.Matrix4() },
    uInvViewMatrix: { value: new THREE.Matrix4() },
    uProjX: { value: 1 },
    uProjY: { value: 1 },
    uCamMode: { value: 0 }, // always perspective in production
    uWaterlineBand: { value: 0.55 },
  };

  // Bake FINAL_LOOK into uniforms once materials exist (function-hoisted below).
  bakeFinalLook();

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
        // viewZ = -mv.z (positive linear depth). Must respect the full projection,
        // including setViewOffset off-axis terms — do not assume a centred frustum.
        vec2 ndc = uv * 2.0 - 1.0;
        vec3 viewPos;
        if (uCamMode > 0.5) {
          // Ortho (unused in production): linear xy mapping.
          viewPos = vec3(
            ndc.x / max(uProjX, 1e-5),
            ndc.y / max(uProjY, 1e-5),
            -viewZ
          );
        } else {
          // Perspective: unproject through the inverse projection matrix so
          // asymmetric frustum offsets from setViewOffset() are included.
          vec4 rayH = uInvProjectionMatrix * vec4(ndc, 1.0, 1.0);
          vec3 rayView = rayH.xyz / max(rayH.w, 1e-6);
          float rayScale = viewZ / max(-rayView.z, 1e-6);
          viewPos = rayView * rayScale;
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
        // Opt 4: r>=2 is a no-op at locked look. Proof with contourWidth=0.9,
        // contourDensity=1.95, stippleSpacing=2.2, dpr<=2:
        //   spacing=(2.2/1.95)*dpr; stepPx=max(spacing*0.55,1)>=1;
        //   widthPx=0.9*dpr <= 1.8; for r>=2, rad>=2 > widthPx*1.05 (<=1.89) so step=0.
        float widthPx = max(uContourWidth, 0.5) * uPixelRatio;
        float dilate = 0.0;
        float stepPx = max(spacing * 0.55, 1.0);
        {
          // r = 1 only (see proof above)
          float rad = stepPx;
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
        shader.uniforms.uActiveSplashCount = uniforms.uActiveSplashCount;
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
        uMarkSurfaceDensity: { value: FINAL_LOOK.mark.surfaceDensity },
        uLightDir: { value: new THREE.Vector3(0.4, 0.85, 0.35).normalize() },
        uScreenRadius: { value: 80 },
        uBodiesOpacity: { value: FINAL_LOOK.visibility.bodiesOpacity },
        uBodyDotScale: { value: FINAL_LOOK.mark.bodyDotScale },
        uOrganicIrregularity: { value: FINAL_LOOK.mark.organicIrregularity },
        uSurfaceMasterScale: {
          value: (CONTOUR_SURFACE_BASE_FRAC * CONTOUR_SURFACE_BASE) / CONTOUR_SURFACE_COUNT,
        },
        // Interaction: presence (idle→full) + pointer-local influence field
        uPresence: { value: 0.88 },
        uHoverWorldPos: { value: new THREE.Vector3(0, -999, 0) },
        uHoverStrength: { value: 0 },
        uHoverRadius: { value: 3.5 },
        uHoverDarkColor: { value: new THREE.Color(0x8f3018) },
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
        uniform float uPresence;
        uniform vec3 uHoverWorldPos;
        uniform float uHoverStrength;
        uniform float uHoverRadius;

        varying float vAlpha;
        varying float vShade;
        varying float vHoverInfl;
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

          float hoverDist = distance(world.xyz, uHoverWorldPos);
          float infl =
            uHoverStrength *
            (1.0 - smoothstep(0.0, max(uHoverRadius, 0.05), hoverDist));
          infl *= infl; // softer outer falloff
          vHoverInfl = infl;

          float css = clamp(uCssPx * uBodyDotScale, 0.25, 8.0);
          gl_PointSize = css * uPixelRatio * mix(1.0, 1.2, infl);

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
          vAlpha = uStrength * uBodiesOpacity * uPresence * front * keep;
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
        uniform vec3 uHoverDarkColor;
        varying float vAlpha;
        varying float vShade;
        varying float vHoverInfl;
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
          vec3 pigment = mix(uColor, uHoverDarkColor, vHoverInfl) * vShade;
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

    // Opt 3: keep full seed sequence, then drop ranks that can never pass GPU keep.
    // See SURFACE_RANK_KEEP_MAX proof above. Preserve original aRank values (no renorm).
    let kept = 0;
    for (let i = 0; i < count; i++) {
      if (rankArr[i] > SURFACE_RANK_KEEP_MAX) continue;
      if (kept !== i) {
        const o = i * 3;
        const d = kept * 3;
        posArr[d] = posArr[o];
        posArr[d + 1] = posArr[o + 1];
        posArr[d + 2] = posArr[o + 2];
        nrmArr[d] = nrmArr[o];
        nrmArr[d + 1] = nrmArr[o + 1];
        nrmArr[d + 2] = nrmArr[o + 2];
        rankArr[kept] = rankArr[i];
      }
      kept++;
    }
    return {
      posArr: posArr.slice(0, kept * 3),
      nrmArr: nrmArr.slice(0, kept * 3),
      rankArr: rankArr.slice(0, kept),
      count: kept,
    };
  }

  const _screenCenter = new THREE.Vector3();
  function estimateProjectsScreenRadius(state, cam) {
    if (!state?.contourLocalCenter) return 80;
    state.group.updateWorldMatrix(true, false);
    _screenCenter.copy(state.contourLocalCenter).applyMatrix4(state.group.matrixWorld);
    const radius = state.contourLocalRadius * Math.abs(state.scale);
    const h = Math.max(window.innerHeight, 1);
    const dist = Math.max(cam.position.distanceTo(_screenCenter), 0.05);
    const vFov = (cam.fov * Math.PI) / 180;
    const worldH = 2 * Math.tan(vFov * 0.5) * dist;
    return (radius / worldH) * h;
  }

  function applyContourDisplayMode(state) {
    if (!state?.solidMeshes) return;
    // Locked FINAL_LOOK: always contour + final
    state.solidMeshes.forEach((entry) => {
      entry.mesh.material = depthOnlyMaterial;
      entry.mesh.visible = true;
    });
    if (state.surfacePoints) state.surfacePoints.visible = true;
  }

  function applyContourDisplayModeAll() {
    contourModels.forEach(applyContourDisplayMode);
  }

  function syncContourUniforms(state) {
    const s = getSharedContourSettings();
    const vis = FINAL_LOOK.visibility;
    const mark = FINAL_LOOK.mark;
    const bodiesHex = appearanceColours.bodies;
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
    contourCompositeUniforms.uDebug.value = 0; // final

    uniforms.uWaveOpacity.value = vis.wavesOpacity;
    uniforms.uWaveDotScale.value = mark.waveDotScale;
    uniforms.uWaveParticleDensity.value = mark.waveParticleDensity;
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

  function bakeFinalLook() {
    applyBackgroundColour(appearanceColours.background);
    applyBodiesColour(appearanceColours.bodies);
    applyWavesColour(appearanceColours.waves);
    syncContourUniformsAll();
    applyContourDisplayModeAll();
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
    applyBodiesColour(appearanceColours.bodies);
  }

  function renderContourPass() {
    if (!contourModels.length) return false;

    let maxScreenR = 0;
    contourModels.forEach((state) => {
      const screenR = estimateProjectsScreenRadius(state, camera);
      maxScreenR = Math.max(maxScreenR, screenR);
      if (state.surfaceMaterial) {
        state.surfaceMaterial.uniforms.uScreenRadius.value = screenR;
      }
    });
    // Composite distance falloff: use the largest on-screen model so Projects
    // (and peers at similar depth) keep the accepted silhouette behaviour.
    contourCompositeUniforms.uScreenRadius.value = maxScreenR;

    const prevMask = camera.layers.mask;
    camera.layers.set(CONTOUR_LAYER);
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = contourCaptureMaterial;

    renderer.setRenderTarget(contourRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    scene.overrideMaterial = prevOverride;
    camera.layers.mask = prevMask;
    renderer.setRenderTarget(null);
    restoreBackgroundClearColor();
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
      // Interaction visual state (lerped in the render loop)
      presence: 0.88,
      presenceTarget: 0.88,
      pressDip: 0,
      pressDipTarget: 0,
      hoverInfl: 0,
      hoverInflTarget: 0,
      // Whole-body hover enlargement multiplier (1 = idle, 1.04 = hover)
      hoverScale: 1,
      hoverScaleTarget: 1,
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
        if (typeof onFloatingModelReady === "function") onFloatingModelReady();

        const t0 = uniforms.uTime.value;
        const surface0 = sampleWaveHeight(state.x, state.z, t0);
        state.bobY =
          surface0 +
          state.halfHeight * state.scale * (1 - 2 * state.immersionFraction) -
          state.immersionOffset;
        group.position.y = state.bobY;
      },
      undefined,
      (error) => {
        console.error(
          `[${config.id}] Failed to load GLB "${config.url}". Check the path and that you are serving over http(s), not file://.`,
          error
        );
        // Fail open so the cream veil never traps the visitor permanently.
        state.ready = true;
        state.loadFailed = true;
        if (typeof onFloatingModelReady === "function") onFloatingModelReady();
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

  // ─── One-time 1.6s opening camera + mist reveal ───────────────────────
  // Mist timeline is independent of the camera path (landing @ 1600 ms).
  const MIST_FADE_START_MS = 0;
  const MIST_FADE_END_MS = 220;

  const prefersReducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const introVeil = document.getElementById("intro-veil");
  const introState = {
    active: !prefersReducedMotion,
    started: false,
    completed: false,
    startPerf: 0,
    warmed: false,
    holdMs: null, // QA: freeze choreography at a fixed elapsed ms
    mistCleared: false, // once true, intro code must not write fog/veil again
  };

  // Smooth ease-out for the full camera flight — decelerates into CAM-001.
  function introCameraEaseOut(t) {
    const u = 1 - t;
    return 1 - u * u * u;
  }

  // Decisive mist ease-out (short tail). Not a slow cinematic curve.
  function mistEaseOut(t) {
    const u = 1 - t;
    return 1 - u * u * u * u; // easeOutQuart
  }

  function introBlocksInput() {
    return introState.active && !introState.completed;
  }

  function setFogDensity(density) {
    if (scene.fog) scene.fog.density = density;
  }

  // Hard restore of every property temporarily modified for the mist reveal.
  // Idempotent. After this runs, sampleIntroAt must not write mist values again.
  function applyFinalClearSceneState() {
    introState.mistCleared = true;
    if (scene.fog) {
      scene.fog.density = FOG_PRODUCTION_DENSITY;
      scene.fog.color.copy(bgClearColor);
    }
    if (introVeil) {
      introVeil.style.opacity = "0";
      introVeil.style.pointerEvents = "none";
      introVeil.classList.add("is-gone");
      if (!introVeil.classList.contains("is-fading")) {
        introVeil.classList.add("is-fading");
      }
    }
  }

  function applyIntroCameraPose(pos, look) {
    cameraState.position.copy(pos);
    cameraState.lookAt.copy(look);
    syncCameraTargetsFromLive();
    commitLiveCamera();
  }

  function finishIntro() {
    if (introState.completed) {
      applyFinalClearSceneState();
      return;
    }
    introState.completed = true;
    introState.active = false;
    introState.holdMs = null;

    // Exact CAM-001 into both live and controller targets — no second handoff.
    writeHeroPose(_introPos, _introLook);
    cameraState.position.copy(_introPos);
    cameraState.lookAt.copy(_introLook);
    cameraState.targetPosition.copy(_introPos);
    cameraState.targetLookAt.copy(_introLook);
    // Clamp is a no-op for CAM-001 at reference (and near-reference) framing;
    // keep it so interactive bounds stay consistent if portrait pull applied.
    clampNavigation();
    cameraState.position.copy(cameraState.targetPosition);
    cameraState.lookAt.copy(cameraState.targetLookAt);
    commitLiveCamera();

    applyFinalClearSceneState();

    document.body.classList.remove("is-intro");
    if (introVeil) {
      // Fully detach after fade so it cannot intercept gestures.
      window.setTimeout(() => {
        if (introVeil && introVeil.parentNode) introVeil.remove();
      }, 400);
    }
  }

  function introSkipToEnd() {
    if (introState.completed) {
      applyFinalClearSceneState();
      return;
    }
    finishIntro();
  }

  function sampleIntroAt(elapsedMs) {
    writeDistantPose(_introPosA, _introLookA); // CAM-002 (+ responsive pull)
    writeHeroPose(_introPosB, _introLookB); // CAM-001 (+ responsive pull)
    writeOpeningPose(_introPosS, _introLookS);

    // ── Camera path: opening → CAM-001 over exactly 1600 ms, smooth ease-out ──
    if (elapsedMs >= INTRO_DURATION_MS) {
      applyIntroCameraPose(_introPosB, _introLookB);
    } else {
      const t = Math.max(0, elapsedMs) / INTRO_DURATION_MS;
      const u = introCameraEaseOut(t);
      _introPos.lerpVectors(_introPosS, _introPosB, u);
      _introLook.lerpVectors(_introLookS, _introLookB, u);
      applyIntroCameraPose(_introPos, _introLook);
    }

    // ── Mist / cream veil — absolute elapsed time, independent of camera ──
    // Do not use asymptotic frame lerps. Snap to exact production once done.
    if (introState.mistCleared) {
      return;
    }

    if (elapsedMs >= MIST_FADE_END_MS) {
      applyFinalClearSceneState();
      return;
    }

    const mistProgress = Math.min(
      1,
      Math.max(
        0,
        (elapsedMs - MIST_FADE_START_MS) /
          Math.max(1, MIST_FADE_END_MS - MIST_FADE_START_MS)
      )
    );
    const mistAmount = 1 - mistEaseOut(mistProgress);
    // mistAmount 1 → full intro mist; 0 → exact production fog.
    setFogDensity(
      THREE.MathUtils.lerp(
        FOG_PRODUCTION_DENSITY,
        FOG_INTRO_DENSITY,
        mistAmount
      )
    );
    if (scene.fog) scene.fog.color.copy(bgClearColor);

    if (introVeil && !introVeil.classList.contains("is-gone")) {
      // Cream cover tracks the same short fade (starts revealing immediately).
      introVeil.style.opacity = String(mistAmount);
      if (mistAmount <= 0.001) {
        introVeil.classList.add("is-gone");
        introVeil.style.pointerEvents = "none";
      } else {
        introVeil.style.pointerEvents = "auto";
      }
    }
  }

  function warmIntroShaders() {
    if (introState.warmed) return;
    introState.warmed = true;
    // Pre-render distant pose once behind the opaque veil to compile shaders.
    writeDistantPose(_introPos, _introLook);
    applyIntroCameraPose(_introPos, _introLook);
    if (!introState.mistCleared) {
      setFogDensity(FOG_INTRO_DENSITY);
    }
    try {
      renderer.compile(scene, camera);
    } catch (_) {
      /* compile is best-effort */
    }
  }

  function allModelsReady() {
    return (
      floatingModels.length >= 3 &&
      floatingModels.every((m) => m.ready)
    );
  }

  function beginIntroSequence() {
    if (introState.started || introState.completed) return;
    if (prefersReducedMotion) {
      finishIntro();
      return;
    }
    warmIntroShaders();
    introState.started = true;
    introState.startPerf = performance.now();
    sampleIntroAt(0);
  }

  function onFloatingModelReady() {
    if (!allModelsReady()) return;
    if (prefersReducedMotion) {
      finishIntro();
      return;
    }
    beginIntroSequence();
  }

  // Safety: never trap behind the veil if a load hangs.
  window.setTimeout(() => {
    if (!introState.started && !introState.completed) {
      floatingModels.forEach((m) => {
        if (!m.ready) {
          m.ready = true;
          m.loadFailed = true;
        }
      });
      onFloatingModelReady();
    }
  }, 12000);

  // Each model samples the shared ocean height at its own X/Z (same as GPU waveHeight)
  function updateFloatingModels(time) {
    const dt = Math.min(Math.max(time - lastFloatTime, 0), 0.05);
    lastFloatTime = time;
    const eps = FLOAT_SLOPE_SAMPLE_EPS;

    for (let i = 0; i < floatingModels.length; i++) {
      const state = floatingModels[i];
      if (!state.ready) continue;

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

      // Soft press dip (extra tactile squash into the water — tiny)
      const pressK = 1 - Math.exp(-14 * dt);
      state.pressDip += (state.pressDipTarget - state.pressDip) * pressK;
      state.group.position.y = state.bobY - state.pressDip;

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

  // ─── Body interaction state (centralised) ────────────────────────────
  // Exact authored focus poses from stippled-ocean-camera-poses.json
  const BODY_FOCUS_POSES = Object.freeze({
    // Shelfie / Interests → CAM-001
    interests: Object.freeze({
      position: Object.freeze({
        x: -1.0222709780616837,
        y: 15.47485601555642,
        z: -75.76869908002864,
      }),
      target: Object.freeze({
        x: 56.60248992165327,
        y: 0.3,
        z: -113.33312133393787,
      }),
    }),
    // Floating Boy / About → CAM-002
    about: Object.freeze({
      position: Object.freeze({
        x: 17.9326073431696,
        y: 8.486639888456539,
        z: -59.81195275722791,
      }),
      target: Object.freeze({
        x: -0.7968178871152448,
        y: 0.656,
        z: -86.01040937940621,
      }),
    }),
    // Workpool / Projects → CAM-003
    projects: Object.freeze({
      position: Object.freeze({
        x: -45.31697712689964,
        y: 14.414999999999996,
        z: -64.1546041757497,
      }),
      target: Object.freeze({
        x: -44.75997712651576,
        y: 0.3,
        z: -99.08660417568247,
      }),
    }),
  });
  const BODY_ROUTES = Object.freeze({
    projects: "/projects",
  });

  const FRAMER_ORIGIN =
    "https://shaardulstrikesagain.framer.website";

  const PAGE_PARAMS =
    new URLSearchParams(window.location.search);

  const CAMERA_DEBUG_ENABLED =
    PAGE_PARAMS.get("cameraDebug") === "1";

  const SECTION_NAVIGATION_DISABLED =
    CAMERA_DEBUG_ENABLED ||
    PAGE_PARAMS.get("qa") === "1";

  const HANDOFF_CAMERA_FRACTION = 0.1;
  const HANDOFF_CAMERA_MS = 120;

  const IDLE_PRESENCE = 0.88;
  const FULL_PRESENCE = 1.0;
  const FOCUS_TRAVEL_MS = 1100;
  const HOVER_BODY_SCALE = 1.04;

  const interaction = {
    hoveredBody: null,
    nearbyBody: null,
    focusedBody: null,
    pressedBody: null,
    isPointerDown: false,
    isCameraTransitioning: false,
    pointerX: 0,
    pointerY: 0,
    hoverWorld: new THREE.Vector3(0, -999, 0),
    homePose: null,
    camTravel: null,
    handoff: {
      active: false,
      destination: null,
    },
    pigment: {
      active: false,
      startTime: 0,
      duration: 1.25,
      x: 0,
      z: 0,
    },
  };

  const _bodyPickHit = new THREE.Vector3();
  const _screenProj = new THREE.Vector3();
  const _travelPos = new THREE.Vector3();
  const _travelLook = new THREE.Vector3();

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function captureHomePoseIfNeeded() {
    if (interaction.homePose) return;
    interaction.homePose = {
      position: {
        x: cameraState.targetPosition.x,
        y: cameraState.targetPosition.y,
        z: cameraState.targetPosition.z,
      },
      target: {
        x: cameraState.targetLookAt.x,
        y: cameraState.targetLookAt.y,
        z: cameraState.targetLookAt.z,
      },
    };
  }

  function startCameraTravel(endPos, endLook, onComplete) {
    captureHomePoseIfNeeded();
    interaction.isCameraTransitioning = true;
    interaction.camTravel = {
      startPos: {
        x: cameraState.position.x,
        y: cameraState.position.y,
        z: cameraState.position.z,
      },
      startLook: {
        x: cameraState.lookAt.x,
        y: cameraState.lookAt.y,
        z: cameraState.lookAt.z,
      },
      endPos: { x: endPos.x, y: endPos.y, z: endPos.z },
      endLook: { x: endLook.x, y: endLook.y, z: endLook.z },
      t0: performance.now(),
      duration: FOCUS_TRAVEL_MS,
      onComplete: onComplete || null,
    };
    // Pre-seed navigation targets so handoff after travel has no snap.
    cameraState.targetPosition.set(endPos.x, endPos.y, endPos.z);
    cameraState.targetLookAt.set(endLook.x, endLook.y, endLook.z);
  }

  function updateCameraTravel() {
    const travel = interaction.camTravel;
    if (!travel) return false;
    const elapsed = performance.now() - travel.t0;
    const t = Math.min(1, elapsed / travel.duration);
    const u = easeInOutCubic(t);
    cameraState.position.set(
      travel.startPos.x + (travel.endPos.x - travel.startPos.x) * u,
      travel.startPos.y + (travel.endPos.y - travel.startPos.y) * u,
      travel.startPos.z + (travel.endPos.z - travel.startPos.z) * u
    );
    cameraState.lookAt.set(
      travel.startLook.x + (travel.endLook.x - travel.startLook.x) * u,
      travel.startLook.y + (travel.endLook.y - travel.startLook.y) * u,
      travel.startLook.z + (travel.endLook.z - travel.startLook.z) * u
    );
    if (t >= 1) {
      cameraState.position.set(travel.endPos.x, travel.endPos.y, travel.endPos.z);
      cameraState.lookAt.set(travel.endLook.x, travel.endLook.y, travel.endLook.z);
      cameraState.targetPosition.copy(cameraState.position);
      cameraState.targetLookAt.copy(cameraState.lookAt);
      const cb = travel.onComplete;
      interaction.camTravel = null;
      interaction.isCameraTransitioning = false;
      if (cb) cb();
    }
    return true;
  }

  function triggerPigmentRipple(body) {
    if (!body) return;
    interaction.pigment.active = true;
    interaction.pigment.startTime = uniforms.uTime.value;
    interaction.pigment.x = body.x;
    interaction.pigment.z = body.z;
    uniforms.uPigmentCenter.value.set(body.x, body.z);
    uniforms.uPigmentAge.value = 0;
    uniforms.uPigmentDuration.value = interaction.pigment.duration;
    uniforms.uPigmentStrength.value = 1;
    uniforms.uPigmentColor.value.set(0xbb4121);
  }

  function syncPigmentUniforms(time) {
    if (!interaction.pigment.active) {
      uniforms.uPigmentStrength.value = 0;
      uniforms.uPigmentAge.value = 99;
      return;
    }
    const age = time - interaction.pigment.startTime;
    uniforms.uPigmentAge.value = age;
    if (age >= interaction.pigment.duration) {
      interaction.pigment.active = false;
      uniforms.uPigmentStrength.value = 0;
      uniforms.uPigmentAge.value = 99;
    } else {
      uniforms.uPigmentStrength.value = 1;
    }
  }

  function pickBodyAtClient(clientX, clientY) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < floatingModels.length; i++) {
      const state = floatingModels[i];
      if (!state.ready || !state.solidMeshes || !state.solidMeshes.length) continue;
      const meshes = state.solidMeshes.map((e) => e.mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length) continue;
      if (hits[0].distance < bestDist) {
        bestDist = hits[0].distance;
        best = { body: state, point: hits[0].point };
      }
    }
    return best;
  }

  function findNearbyBody(clientX, clientY) {
    let best = null;
    let bestScore = Infinity;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (let i = 0; i < floatingModels.length; i++) {
      const state = floatingModels[i];
      if (!state.ready || !state.contourLocalCenter) continue;
      state.group.updateWorldMatrix(true, false);
      _screenProj.copy(state.contourLocalCenter).applyMatrix4(state.group.matrixWorld);
      _screenProj.project(camera);
      const sx = (_screenProj.x * 0.5 + 0.5) * vw;
      const sy = (-_screenProj.y * 0.5 + 0.5) * vh;
      if (_screenProj.z > 1) continue;
      const screenR = estimateProjectsScreenRadius(state, camera);
      const proxR = Math.max(screenR * 1.55, 48);
      const d = Math.hypot(clientX - sx, clientY - sy);
      if (d < proxR && d < bestScore) {
        bestScore = d;
        best = state;
      }
    }
    return best;
  }

  function selectBody(body, opts = {}) {
    if (!body || interaction.isCameraTransitioning) return;
    if (introBlocksInput()) return;
    const pose = BODY_FOCUS_POSES[body.id];
    if (!pose) return;

    interaction.focusedBody = body;
    if (opts.fromKeyboard) {
      // Keyboard focus must not invent a pointer hover / local stipple influence.
      interaction.hoveredBody = null;
      interaction.nearbyBody = null;
      interaction.hoverWorld.set(0, -999, 0);
    } else {
      interaction.hoveredBody = body;
      interaction.nearbyBody = body;
    }
    triggerPigmentRipple(body);

    startCameraTravel(pose.position, pose.target, () => {
      interaction.focusedBody = body;
      // Refresh hover from live pointer so scale only stays enlarged if still over the body.
      evaluatePointerAffinity(interaction.pointerX, interaction.pointerY);
    });
  }

  // Circular body order: Laptop → Boy → Shelf → Laptop
  const BODY_CYCLE_IDS = Object.freeze(["projects", "about", "interests"]);

  function getFloatingBodyById(id) {
    for (let i = 0; i < floatingModels.length; i++) {
      if (floatingModels[i].id === id) return floatingModels[i];
    }
    return null;
  }

  function navigateBodyByKeyboard(direction) {
    // direction: +1 = Right Arrow, -1 = Left Arrow
    if (introBlocksInput() || interaction.isCameraTransitioning) return;
    const focused = interaction.focusedBody;
    let nextId = "projects"; // overview / unknown → always enter at Laptop
    if (focused) {
      const idx = BODY_CYCLE_IDS.indexOf(focused.id);
      if (idx >= 0) {
        const len = BODY_CYCLE_IDS.length;
        nextId = BODY_CYCLE_IDS[(idx + direction + len) % len];
      }
    }
    const body = getFloatingBodyById(nextId);
    if (body) selectBody(body, { fromKeyboard: true });
  }

  function returnHomeCamera() {
    if (interaction.isCameraTransitioning) return;
    captureHomePoseIfNeeded();
    const home = interaction.homePose;
    if (!home) return;
    interaction.focusedBody = null;
    startCameraTravel(home.position, home.target, () => {
      interaction.focusedBody = null;
      evaluatePointerAffinity(interaction.pointerX, interaction.pointerY);
    });
  }

  function updateBodyInteractionVisuals(dt) {
    const hoverBody = interaction.hoveredBody;
    const nearbyBody = interaction.nearbyBody;
    const focused = interaction.focusedBody;
    const camBusy = interaction.isCameraTransitioning;
    let maxPresence = IDLE_PRESENCE;

    for (let i = 0; i < floatingModels.length; i++) {
      const state = floatingModels[i];
      let presenceTarget = IDLE_PRESENCE;
      let hoverTarget = 0;
      // Whole-body enlarge only while actively hovered and not mid-camera travel.
      let scaleTarget = 1;

      if (focused === state) {
        presenceTarget = FULL_PRESENCE;
      } else if (hoverBody === state) {
        presenceTarget = FULL_PRESENCE;
        hoverTarget = 1;
      } else if (nearbyBody === state) {
        presenceTarget = FULL_PRESENCE;
      }

      if (!camBusy && hoverBody === state) {
        scaleTarget = HOVER_BODY_SCALE;
      }

      if (interaction.pressedBody === state) {
        state.pressDipTarget = 0.22 * Math.max(0.35, state.scale * 0.02);
      } else {
        state.pressDipTarget = 0;
      }

      const k = 1 - Math.exp(-12 * dt); // ~150–250ms settle (presence / local stipple)
      const scaleK = 1 - Math.exp(-11 * dt); // ~180–250ms hover enlarge
      state.presenceTarget = presenceTarget;
      state.hoverInflTarget = hoverTarget;
      state.hoverScaleTarget = scaleTarget;
      state.presence += (state.presenceTarget - state.presence) * k;
      state.hoverInfl += (state.hoverInflTarget - state.hoverInfl) * k;
      state.hoverScale += (state.hoverScaleTarget - state.hoverScale) * scaleK;
      maxPresence = Math.max(maxPresence, state.presence);

      // Uniform enlarge around the group's floating pivot (bob/tilt unchanged).
      state.group.scale.setScalar(state.scale * state.hoverScale);

      if (state.surfaceMaterial) {
        const u = state.surfaceMaterial.uniforms;
        if (u.uPresence) u.uPresence.value = state.presence;
        if (u.uHoverStrength) u.uHoverStrength.value = state.hoverInfl;
        if (u.uHoverWorldPos) {
          if (hoverBody === state && !camBusy) {
            u.uHoverWorldPos.value.copy(interaction.hoverWorld);
            const r =
              Math.max(state.contourLocalRadius || 1, 0.5) *
              Math.abs(state.scale) *
              0.45;
            u.uHoverRadius.value = THREE.MathUtils.clamp(r, 2.2, 7.5);
          } else {
            u.uHoverWorldPos.value.set(0, -999, 0);
          }
        }
      }
    }

    // Shared contour opacity tracks the strongest body presence (idle headroom).
    if (contourCompositeUniforms?.uBodiesOpacity) {
      contourCompositeUniforms.uBodiesOpacity.value = maxPresence;
    }
  }

  function evaluatePointerAffinity(clientX, clientY) {
    interaction.pointerX = clientX;
    interaction.pointerY = clientY;
    if (interaction.isCameraTransitioning || introBlocksInput()) return;

    const hit = pickBodyAtClient(clientX, clientY);
    if (hit) {
      interaction.hoveredBody = hit.body;
      interaction.nearbyBody = hit.body;
      interaction.hoverWorld.copy(hit.point);
      return;
    }

    interaction.hoveredBody = null;
    interaction.nearbyBody = findNearbyBody(clientX, clientY);
    if (!interaction.nearbyBody) {
      interaction.hoverWorld.set(0, -999, 0);
    }
  }

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
    uniforms.uActiveSplashCount.value = activeSplashes.length;
  }

  const _oceanHit = new THREE.Vector3();
  function getOceanPoint(clientX, clientY) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObject(hitPlane);
    if (!hits.length) return null;

    const p = hits[0].point;
    const time = uniforms.uTime.value;
    const y = sampleWaveHeight(p.x, p.z, time) + sampleSplashHeight(p.x, p.z, time, activeSplashes);
    return _oceanHit.set(p.x, y, p.z);
  }

  const _focusOffset = new THREE.Vector3();
  function focusOnPoint(point) {
    cameraState.targetLookAt.set(point.x, Math.max(point.y, 0.3), point.z);

    // Keep a cinematic offset: elevated, behind the look target toward camera side
    _focusOffset
      .subVectors(cameraState.position, cameraState.lookAt)
      .normalize()
      .multiplyScalar(22);

    // Soft lateral bias toward the clicked X so the pan feels intentional
    _focusOffset.x += (point.x - cameraState.lookAt.x) * 0.35;
    // Prefer a modest elevated close-focus (within NAV pitch limits after clamp)
    _focusOffset.y = Math.max(_focusOffset.y, 7.5 + Math.max(point.y, 0) * 0.35);
    _focusOffset.z = Math.max(_focusOffset.z, 14);

    cameraState.targetPosition.copy(point).add(_focusOffset);
    cameraState.targetPosition.y = Math.max(cameraState.targetPosition.y, 5.5);
    clampNavigation();
  }

  const _panRight = new THREE.Vector3();
  const _panForward = new THREE.Vector3();
  const _panMove = new THREE.Vector3();
  const _zoomOffset = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  // Stay near the wave disk — zoom-out capped at 2× the plane radius (center → perimeter).
  // Height / pitch expanded just enough for the centred elevated hero pose (~14.5°)
  // while still blocking top-down, underwater, and edge-of-disk views.
  const NAV_BOUNDS = {
    maxLookRadius: OCEAN_RADIUS * 0.82,
    minDist: 9,
    maxDist: OCEAN_RADIUS * 2.4,
    // Allows portrait pull-back of the hero pose without hitting the disk rim clamp.
    maxCameraRadius: OCEAN_RADIUS * 2.4,
    minHeight: 4.5,
    // High enough for portrait pull-back at ~14.5° pitch; top-down still blocked by maxPitchDeg.
    maxHeight: 56,
    minPitchDeg: 6,
    maxPitchDeg: 22,
  };
  const NAV_MIN_PITCH = (NAV_BOUNDS.minPitchDeg * Math.PI) / 180;
  const NAV_MAX_PITCH = (NAV_BOUNDS.maxPitchDeg * Math.PI) / 180;

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

  function clampCameraPitch() {
    // Keep a cinematic downward pitch — no dive, no overhead editor angle.
    _zoomOffset.subVectors(cameraState.targetPosition, cameraState.targetLookAt);
    const horiz = Math.sqrt(
      _zoomOffset.x * _zoomOffset.x + _zoomOffset.z * _zoomOffset.z
    );
    if (horiz < 1e-4) {
      _zoomOffset.set(0, 6, 18);
      cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
      return;
    }
    const dist = _zoomOffset.length();
    let pitch = Math.atan2(_zoomOffset.y, horiz);
    pitch = THREE.MathUtils.clamp(pitch, NAV_MIN_PITCH, NAV_MAX_PITCH);
    const newHoriz = dist * Math.cos(pitch);
    const newY = dist * Math.sin(pitch);
    const scale = newHoriz / horiz;
    _zoomOffset.x *= scale;
    _zoomOffset.z *= scale;
    _zoomOffset.y = newY;
    cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
  }

  function clampCameraDistance() {
    _zoomOffset.subVectors(cameraState.targetPosition, cameraState.targetLookAt);
    const dist = _zoomOffset.length();
    if (dist < 1e-4) {
      _zoomOffset.set(
        HERO_POSITION.x - HERO_LOOK_AT.x,
        HERO_POSITION.y - HERO_LOOK_AT.y,
        HERO_POSITION.z - HERO_LOOK_AT.z
      );
    }
    const clamped = THREE.MathUtils.clamp(dist, NAV_BOUNDS.minDist, NAV_BOUNDS.maxDist);
    _zoomOffset.setLength(clamped);
    cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
    clampCameraPitch();
    clampCameraToPlane();
  }

  function clampNavigation() {
    clampLookTarget();
    clampCameraDistance();
  }

  // Ensure the load pose sits inside bounds (same values — no visible snap).
  clampNavigation();
  cameraState.position.copy(cameraState.targetPosition);
  cameraState.lookAt.copy(cameraState.targetLookAt);
  commitLiveCamera();

  function panCamera(deltaX, deltaY) {
    if (interaction.isCameraTransitioning) return;
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
    if (interaction.isCameraTransitioning) return;
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

  // Trackpad / wheel: pan (two-finger) or zoom (pinch / ctrl+wheel)
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (introBlocksInput()) {
        introSkipToEnd();
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

  // Right / middle mouse drag pan — separate from left-button splash/focus.
  const mousePanState = {
    active: false,
    pointerId: null,
  };

  // ─── Additive mouse edge-pan + keyboard pan (trackpad wheel path untouched) ─
  const EDGE_DEAD_FRAC = 0.55; // central dead zone
  const EDGE_PAN_MAX_PX = 1.65; // restrained peak (px-equivalent @ 60fps)
  const KEY_PAN_PX = 1.35;
  const edgeSteer = {
    vx: 0,
    vy: 0,
    targetVx: 0,
    targetVy: 0,
    pointerInside: false,
  };
  const keyPan = {
    left: false,
    right: false,
    up: false,
    down: false,
  };

  function isTypingTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return !!el.closest("input, textarea, select, [contenteditable='true']");
  }

  function edgeAxisDrive(n) {
    // n in [0,1]. Return signed drive in [-1,1] with dead zone + eased falloff.
    const half = EDGE_DEAD_FRAC * 0.5;
    const lo = 0.5 - half;
    const hi = 0.5 + half;
    if (n >= lo && n <= hi) return 0;
    let t;
    let sign;
    if (n < lo) {
      t = (lo - n) / Math.max(lo, 1e-6);
      sign = -1;
    } else {
      t = (n - hi) / Math.max(1 - hi, 1e-6);
      sign = 1;
    }
    t = Math.min(1, Math.max(0, t));
    // Smoothstep-ish nonlinear ramp (gentle near dead zone, firmer at rim)
    const eased = t * t * (3 - 2 * t);
    return sign * eased;
  }

  function edgePanBlocked() {
    return (
      introBlocksInput() ||
      interaction.isCameraTransitioning ||
      dragState.active ||
      mousePanState.active ||
      !!interaction.pressedBody
    );
  }

  function computeEdgeSteerTargets() {
    if (edgePanBlocked() || !edgeSteer.pointerInside) {
      edgeSteer.targetVx = 0;
      edgeSteer.targetVy = 0;
      return;
    }
    const w = Math.max(window.innerWidth, 1);
    const h = Math.max(window.innerHeight, 1);
    const nx = interaction.pointerX / w;
    const ny = interaction.pointerY / h;
    const dx = edgeAxisDrive(nx);
    const dy = edgeAxisDrive(ny);
    edgeSteer.targetVx = dx * EDGE_PAN_MAX_PX;
    edgeSteer.targetVy = dy * EDGE_PAN_MAX_PX;
  }

  function computeKeyboardSteerAdd() {
    if (edgePanBlocked()) return { kx: 0, ky: 0 };
    let kx = 0;
    let ky = 0;
    if (keyPan.left) kx -= KEY_PAN_PX;
    if (keyPan.right) kx += KEY_PAN_PX;
    if (keyPan.up) ky -= KEY_PAN_PX;
    if (keyPan.down) ky += KEY_PAN_PX;
    // Soften diagonals slightly
    if (kx !== 0 && ky !== 0) {
      const inv = 1 / Math.SQRT2;
      kx *= inv;
      ky *= inv;
    }
    return { kx, ky };
  }

  function updatePointerSteering(dt) {
    computeEdgeSteerTargets();
    const { kx, ky } = computeKeyboardSteerAdd();
    const wantX = edgeSteer.targetVx + kx;
    const wantY = edgeSteer.targetVy + ky;
    // Smooth accel/decel (~180–250ms)
    const damp = 1 - Math.exp(-9 * dt);
    edgeSteer.vx += (wantX - edgeSteer.vx) * damp;
    edgeSteer.vy += (wantY - edgeSteer.vy) * damp;
    if (Math.abs(edgeSteer.vx) < 0.02) edgeSteer.vx = 0;
    if (Math.abs(edgeSteer.vy) < 0.02) edgeSteer.vy = 0;
    if (edgeSteer.vx === 0 && edgeSteer.vy === 0) return;
    // Frame-rate independent: EDGE_* calibrated as px @ 60fps
    panCamera(edgeSteer.vx * dt * 60, edgeSteer.vy * dt * 60);
  }

  function endMousePan(event) {
    if (!mousePanState.active || event.pointerId !== mousePanState.pointerId) {
      return false;
    }
    mousePanState.active = false;
    mousePanState.pointerId = null;
    canvas.style.cursor = "";
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* already released */
    }
    return true;
  }

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
      _oceanHit.set(originX + dx * t, point.y, originZ + dz * t);
      spawnTrailSplash(_oceanHit, movementSpeed);
    }
    dragState.lastSplash = { x: point.x, z: point.z };
  }

  canvas.addEventListener("pointerdown", (event) => {
    // Manual mouse pan: Shift + Right-drag (middle-drag unchanged).
    // Plain right-click alone must not pan.
    const isShiftRightPan = event.button === 2 && event.shiftKey;
    const isMiddlePan = event.button === 1;
    if (isShiftRightPan || isMiddlePan) {
      event.preventDefault();
      if (introBlocksInput()) {
        introSkipToEnd();
        return;
      }
      if (dragState.active) return;
      mousePanState.active = true;
      mousePanState.pointerId = event.pointerId;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) return;
    if (mousePanState.active) return;
    if (introBlocksInput()) {
      introSkipToEnd();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.isDragging = false;
    dragState.lastSplash = null;
    clearTimeout(clickTimer);
    clickTimer = null;

    interaction.isPointerDown = true;
    if (!interaction.isCameraTransitioning) {
      const hit = pickBodyAtClient(event.clientX, event.clientY);
      interaction.pressedBody = hit ? hit.body : null;
      if (hit) {
        interaction.hoveredBody = hit.body;
        interaction.nearbyBody = hit.body;
        interaction.hoverWorld.copy(hit.point);
      }
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    interaction.pointerX = event.clientX;
    interaction.pointerY = event.clientY;
    edgeSteer.pointerInside = true;

    if (mousePanState.active && event.pointerId === mousePanState.pointerId) {
      // Same panCamera used by trackpad two-finger wheel pan.
      panCamera(event.movementX || 0, event.movementY || 0);
      return;
    }

    // Hover / nearby affinity (suppressed during camera travel)
    if (!dragState.active && !mousePanState.active) {
      evaluatePointerAffinity(event.clientX, event.clientY);
    } else if (
      dragState.active &&
      !dragState.isDragging &&
      interaction.pressedBody &&
      !interaction.isCameraTransitioning
    ) {
      const hit = pickBodyAtClient(event.clientX, event.clientY);
      if (hit) interaction.hoverWorld.copy(hit.point);
    }

    if (!dragState.active || event.pointerId !== dragState.pointerId) return;

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);

    if (!dragState.isDragging && pixelDist >= DRAG_THRESHOLD) {
      dragState.isDragging = true;
      // Drag overrides body press / pending selection
      interaction.pressedBody = null;
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

  canvas.addEventListener("pointerenter", (event) => {
    edgeSteer.pointerInside = true;
    interaction.pointerX = event.clientX;
    interaction.pointerY = event.clientY;
  });

  canvas.addEventListener("pointerleave", () => {
    edgeSteer.pointerInside = false;
  });

  function endPointer(event) {
    if (endMousePan(event)) return;

    if (!dragState.active || event.pointerId !== dragState.pointerId) return;

    const wasDragging = dragState.isDragging;
    const x = event.clientX;
    const y = event.clientY;

    dragState.active = false;
    dragState.pointerId = null;
    dragState.isDragging = false;
    dragState.lastSplash = null;
    interaction.isPointerDown = false;
    interaction.pressedBody = null;

    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* already released */
    }

    if (wasDragging) return;

    // Short press → body select / return home / overview soft-focus
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (interaction.isCameraTransitioning) return;

      const hit = pickBodyAtClient(x, y);
      if (hit) {
        // Clicking a body always focuses it (mouse / trackpad), including while focused.
        selectBody(hit.body);
        return;
      }

      // While focused: empty ocean OR completely blank background (no body, no
      // ocean hit required) → same overview/home camera transition.
      if (interaction.focusedBody) {
        returnHomeCamera();
        return;
      }

      // Overview only: soft cinematic nudge when the ocean disk is hit.
      const point = getOceanPoint(x, y);
      if (point) focusOnPoint(point);
    }, CLICK_DELAY);
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("pointerleave", () => {
    if (interaction.isCameraTransitioning) return;
    if (dragState.active || mousePanState.active) return;
    interaction.hoveredBody = null;
    interaction.nearbyBody = null;
    interaction.hoverWorld.set(0, -999, 0);
  });

  // Suppress context menu on the WebGL canvas (needed for Shift+Right-drag pan).
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  function setKeyPanFromCode(code, pressed) {
    // A/D + Up/Down only — Left/Right arrows are reserved for body cycling.
    switch (code) {
      case "KeyA":
        keyPan.left = pressed;
        break;
      case "KeyD":
        keyPan.right = pressed;
        break;
      case "KeyW":
      case "ArrowUp":
        keyPan.up = pressed;
        break;
      case "KeyS":
      case "ArrowDown":
        keyPan.down = pressed;
        break;
      default:
        return false;
    }
    return true;
  }

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;

    // Body carousel — one navigation per distinct keypress (ignore auto-repeat).
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      navigateBodyByKeyboard(event.code === "ArrowRight" ? 1 : -1);
      return;
    }

    if (!setKeyPanFromCode(event.code, true)) return;
    // Prevent page scroll from arrow keys while steering the ocean.
    event.preventDefault();
  });

  window.addEventListener("keyup", (event) => {
    setKeyPanFromCode(event.code, false);
  });

  window.addEventListener("blur", () => {
    keyPan.left = false;
    keyPan.right = false;
    keyPan.up = false;
    keyPan.down = false;
  });

  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (introBlocksInput()) {
      introSkipToEnd();
      return;
    }
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

  let resizeDirty = true;
  let lastHeroPull = heroDistancePull();

  function applyResponsiveCameraDistance() {
    // Preserve look target (pan state); scale camera offset when viewport class changes.
    if (introBlocksInput()) {
      // Keep intro path responsive without replaying — resample current intro time.
      if (introState.started) {
        const elapsed = performance.now() - introState.startPerf;
        sampleIntroAt(Math.min(elapsed, INTRO_DURATION_MS));
      }
      return;
    }
    const pull = heroDistancePull();
    if (pull === lastHeroPull) return;
    const ratio = pull / lastHeroPull;
    lastHeroPull = pull;
    _zoomOffset.subVectors(
      cameraState.targetPosition,
      cameraState.targetLookAt
    );
    _zoomOffset.multiplyScalar(ratio);
    cameraState.targetPosition.copy(cameraState.targetLookAt).add(_zoomOffset);
    // Keep live pose in sync so there is no ease jump after resize.
    cameraState.position.copy(cameraState.targetPosition);
    clampNavigation();
    cameraState.position.copy(cameraState.targetPosition);
  }

  function applyResizeIfNeeded() {
    if (!resizeDirty) return;
    resizeDirty = false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    applyCameraProjection();
    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    uniforms.uPixelRatio.value = dpr;
    floatingModels.forEach((state) => {
      if (state.surfaceMaterial?.uniforms?.uPixelRatio) {
        state.surfaceMaterial.uniforms.uPixelRatio.value = dpr;
      }
    });
    resizeContourTargets();
    resizeWaterDepthTarget();
    // Water-depth RT texture/size only changes on resize — sync targets here (not every frame).
    syncWaterDepthUniformTargets(contourCaptureUniforms);
    syncWaterDepthUniformTargets(depthOnlyMaterial.uniforms);
    floatingModels.forEach((state) => {
      if (state.surfaceMaterial) {
        syncWaterDepthUniformTargets(state.surfaceMaterial.uniforms);
      }
    });
    applyResponsiveCameraDistance();
    commitLiveCamera();
  }
  window.addEventListener("resize", () => {
    resizeDirty = true;
  });

  function syncContourWaveMatrices(cam) {
    cam.updateMatrixWorld(true);
    // Preserve view-offset framing — never clearViewOffset / bare aspect reset.
    // Inverse projection must include the off-axis setViewOffset terms so
    // reconstructWorld() / waterlineSuppress() stay aligned with the framebuffer.
    if (cam === camera) applyCameraProjection();
    else cam.updateProjectionMatrix();
    contourCompositeUniforms.uInvProjectionMatrix.value.copy(cam.projectionMatrix).invert();
    contourCompositeUniforms.uInvViewMatrix.value.copy(cam.matrixWorld);
    contourCompositeUniforms.uProjX.value = cam.projectionMatrix.elements[0];
    contourCompositeUniforms.uProjY.value = cam.projectionMatrix.elements[5];
    contourCompositeUniforms.uCamMode.value = 0; // perspective only
  }

  function animate() {
    requestAnimationFrame(animate);
    applyResizeIfNeeded();
    const time = clock.getElapsedTime();
    uniforms.uTime.value = time;
    syncSplashUniforms(time);
    syncPigmentUniforms(time);

    updateFloatingModels(time);

    const idt = Math.min(Math.max(time - (interaction._lastVisT || time), 0), 0.05);
    interaction._lastVisT = time;
    if (!introBlocksInput()) {
      updateBodyInteractionVisuals(idt > 0 ? idt : 1 / 60);
      // Edge / keyboard pan — additive; never touches the wheel/trackpad handler.
      if (!interaction.isCameraTransitioning) {
        updatePointerSteering(idt > 0 ? idt : 1 / 60);
      } else {
        edgeSteer.vx = 0;
        edgeSteer.vy = 0;
        edgeSteer.targetVx = 0;
        edgeSteer.targetVy = 0;
      }
    }

    if (introState.active && introState.started && !introState.completed) {
      const elapsed =
        introState.holdMs != null
          ? introState.holdMs
          : performance.now() - introState.startPerf;
      if (elapsed >= INTRO_DURATION_MS) {
        sampleIntroAt(INTRO_DURATION_MS);
        finishIntro();
      } else {
        sampleIntroAt(elapsed);
      }
    } else if (updateCameraTravel()) {
      commitLiveCamera();
    } else if (!introBlocksInput()) {
      // Smooth camera ease (interactive navigation)
      cameraState.position.lerp(cameraState.targetPosition, 0.045);
      cameraState.lookAt.lerp(cameraState.targetLookAt, 0.055);
      commitLiveCamera();
    }

    syncContourWaveMatrices(camera);
    renderWaterDepthPass();
    const contourOn = renderContourPass();

    renderer.autoClear = true;
    renderer.render(scene, camera);

    if (contourOn) {
      renderer.autoClear = false;
      renderContourComposite();
      renderer.autoClear = true;
    }
  }

  animate();

  function getCameraDerived() {
    const ox = cameraState.position.x - cameraState.lookAt.x;
    const oy = cameraState.position.y - cameraState.lookAt.y;
    const oz = cameraState.position.z - cameraState.lookAt.z;
    const horiz = Math.hypot(ox, oz);
    const dist = cameraState.position.distanceTo(cameraState.lookAt);
    const pitchDeg = (Math.atan2(oy, horiz) * 180) / Math.PI;
    const yawDeg = (Math.atan2(ox, oz) * 180) / Math.PI;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    return {
      distance: dist,
      pitchDeg,
      yawDeg,
      fov: camera.fov,
      aspect: cssW / Math.max(cssH, 1),
      cssWidth: cssW,
      cssHeight: cssH,
      dpr: renderer.getPixelRatio(),
      verticalBiasPixels: CAMERA_FRAMING.verticalBias * cssH,
      horizontalBiasPixels: CAMERA_FRAMING.horizontalBias * cssW,
      mode: introBlocksInput()
        ? "intro"
        : introState.completed
          ? "interactive"
          : "loading",
      reproducible: true,
    };
  }

  function snapshotPose(name) {
    const d = getCameraDerived();
    return {
      name: name || "",
      viewport: {
        cssWidth: d.cssWidth,
        cssHeight: d.cssHeight,
        aspect: d.aspect,
        dpr: d.dpr,
      },
      camera: {
        position: {
          x: cameraState.position.x,
          y: cameraState.position.y,
          z: cameraState.position.z,
        },
        target: {
          x: cameraState.lookAt.x,
          y: cameraState.lookAt.y,
          z: cameraState.lookAt.z,
        },
        distance: d.distance,
        pitch: d.pitchDeg,
        yaw: d.yawDeg,
        fov: d.fov,
      },
      framing: {
        verticalBiasNormalized: CAMERA_FRAMING.verticalBias,
        verticalBiasPixels: d.verticalBiasPixels,
        horizontalBiasNormalized: CAMERA_FRAMING.horizontalBias,
        horizontalBiasPixels: d.horizontalBiasPixels,
      },
      navigation: {
        // Controller uses targetPosition/targetLookAt; live position eases toward them.
        targetPosition: {
          x: cameraState.targetPosition.x,
          y: cameraState.targetPosition.y,
          z: cameraState.targetPosition.z,
        },
        targetLookAt: {
          x: cameraState.targetLookAt.x,
          y: cameraState.targetLookAt.y,
          z: cameraState.targetLookAt.z,
        },
        livePosition: {
          x: cameraState.position.x,
          y: cameraState.position.y,
          z: cameraState.position.z,
        },
        liveLookAt: {
          x: cameraState.lookAt.x,
          y: cameraState.lookAt.y,
          z: cameraState.lookAt.z,
        },
        distance: d.distance,
        focusState: "none",
      },
    };
  }

  function applyCapturedPose(pose, opts = {}) {
    if (!pose?.camera?.position || !pose?.camera?.target) return false;
    const snapLive = opts.snapLive !== false;
    cameraState.targetPosition.set(
      pose.navigation?.targetPosition?.x ?? pose.camera.position.x,
      pose.navigation?.targetPosition?.y ?? pose.camera.position.y,
      pose.navigation?.targetPosition?.z ?? pose.camera.position.z
    );
    cameraState.targetLookAt.set(
      pose.navigation?.targetLookAt?.x ?? pose.camera.target.x,
      pose.navigation?.targetLookAt?.y ?? pose.camera.target.y,
      pose.navigation?.targetLookAt?.z ?? pose.camera.target.z
    );
    if (snapLive) {
      cameraState.position.copy(cameraState.targetPosition);
      cameraState.lookAt.copy(cameraState.targetLookAt);
    }
    if (pose.framing) {
      if (Number.isFinite(pose.framing.verticalBiasNormalized)) {
        CAMERA_FRAMING.verticalBias = pose.framing.verticalBiasNormalized;
      }
      if (Number.isFinite(pose.framing.horizontalBiasNormalized)) {
        CAMERA_FRAMING.horizontalBias = pose.framing.horizontalBiasNormalized;
      }
    }
    clampNavigation();
    if (snapLive) {
      cameraState.position.copy(cameraState.targetPosition);
      cameraState.lookAt.copy(cameraState.targetLookAt);
    }
    commitLiveCamera();
    return true;
  }

  function setWorldPose({ position, target, syncTargets = true }) {
    if (position) {
      cameraState.position.set(position.x, position.y, position.z);
      if (syncTargets) cameraState.targetPosition.copy(cameraState.position);
    }
    if (target) {
      cameraState.lookAt.set(target.x, target.y, target.z);
      if (syncTargets) cameraState.targetLookAt.copy(cameraState.lookAt);
    }
    clampNavigation();
    if (syncTargets) {
      cameraState.position.copy(cameraState.targetPosition);
      cameraState.lookAt.copy(cameraState.targetLookAt);
    }
    commitLiveCamera();
  }

  function setFramingBias({ vertical, horizontal }) {
    if (Number.isFinite(vertical)) CAMERA_FRAMING.verticalBias = vertical;
    if (Number.isFinite(horizontal)) CAMERA_FRAMING.horizontalBias = horizontal;
    commitLiveCamera();
  }

  function vecErr(ax, ay, az, b) {
    const dx = ax - b.x;
    const dy = ay - b.y;
    const dz = az - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function getBakedMatch() {
    writeDistantPose(_introPosA, _introLookA);
    writeHeroPose(_introPosB, _introLookB);
    const pull = heroDistancePull();
    const atRef = pull === 1;
    const livePos = cameraState.position;
    const liveLook = cameraState.lookAt;
    const liveTargetPos = cameraState.targetPosition;
    const liveTargetLook = cameraState.targetLookAt;
    const shot2PosErr = vecErr(livePos.x, livePos.y, livePos.z, {
      x: _introPosA.x,
      y: _introPosA.y,
      z: _introPosA.z,
    });
    const shot2LookErr = vecErr(liveLook.x, liveLook.y, liveLook.z, {
      x: _introLookA.x,
      y: _introLookA.y,
      z: _introLookA.z,
    });
    const landPosErr = vecErr(livePos.x, livePos.y, livePos.z, {
      x: _introPosB.x,
      y: _introPosB.y,
      z: _introPosB.z,
    });
    const landLookErr = vecErr(liveLook.x, liveLook.y, liveLook.z, {
      x: _introLookB.x,
      y: _introLookB.y,
      z: _introLookB.z,
    });
    const targetPosErr = vecErr(
      liveTargetPos.x,
      liveTargetPos.y,
      liveTargetPos.z,
      { x: _introPosB.x, y: _introPosB.y, z: _introPosB.z }
    );
    const targetLookErr = vecErr(
      liveTargetLook.x,
      liveTargetLook.y,
      liveTargetLook.z,
      { x: _introLookB.x, y: _introLookB.y, z: _introLookB.z }
    );
    const eps = 1e-4;
    let introElapsed = null;
    if (introState.started && !introState.completed) {
      introElapsed =
        introState.holdMs != null
          ? introState.holdMs
          : performance.now() - introState.startPerf;
    } else if (introState.completed) {
      introElapsed = INTRO_DURATION_MS;
    }
    return {
      framing: {
        expectedVertical: 0.137,
        actualVertical: CAMERA_FRAMING.verticalBias,
        expectedHorizontal: 0,
        actualHorizontal: CAMERA_FRAMING.horizontalBias,
        match:
          Math.abs(CAMERA_FRAMING.verticalBias - 0.137) < 1e-9 &&
          Math.abs(CAMERA_FRAMING.horizontalBias) < 1e-9,
      },
      referenceViewport: { ...CAMERA_REF_VIEWPORT },
      responsivePull: pull,
      atReferenceViewport: atRef,
      shot2: {
        id: INTRO_CAMERA_SHOTS.distant.id,
        name: INTRO_CAMERA_SHOTS.distant.name,
        atMs: INTRO_SHOT2_MS,
        positionError: shot2PosErr,
        targetError: shot2LookErr,
        match: shot2PosErr < eps && shot2LookErr < eps,
      },
      landing: {
        id: INTRO_CAMERA_SHOTS.final.id,
        name: INTRO_CAMERA_SHOTS.final.name,
        positionError: landPosErr,
        targetError: landLookErr,
        match: landPosErr < eps && landLookErr < eps,
      },
      controllerHandoff: {
        targetPositionError: targetPosErr,
        targetLookAtError: targetLookErr,
        match:
          introState.completed &&
          targetPosErr < eps &&
          targetLookErr < eps &&
          landPosErr < eps &&
          landLookErr < eps,
      },
      introElapsedMs: introElapsed,
      introCompleted: introState.completed,
    };
  }

  // Invisible production QA probe (no UI). Used only by local measurement scripts.
  window.__STIPPLED_PERF__ = {
    getInfo() {
      return {
        memory: renderer.info.memory,
        render: { ...renderer.info.render },
        dpr: renderer.getPixelRatio(),
        size: renderer.getSize(new THREE.Vector2()),
        oceanVertices: PARTICLE_COUNT,
        modelsReady: floatingModels.filter((m) => m.ready).length,
        intro: {
          active: introState.active,
          started: introState.started,
          completed: introState.completed,
          mistCleared: introState.mistCleared,
          fogDensity: scene.fog ? scene.fog.density : null,
          fogProductionDensity: FOG_PRODUCTION_DENSITY,
          mistFadeEndMs: MIST_FADE_END_MS,
        },
        framing: { ...CAMERA_FRAMING },
        camera: snapshotPose().camera,
        derived: getCameraDerived(),
        bakedMatch: getBakedMatch(),
      };
    },
    seekIntro(ms) {
      if (prefersReducedMotion) return false;
      if (!introState.started) {
        warmIntroShaders();
        introState.started = true;
        introState.active = true;
        introState.completed = false;
        document.body.classList.add("is-intro");
        if (introVeil) {
          introVeil.classList.remove("is-gone", "is-fading");
          introVeil.style.opacity = "1";
          introVeil.style.pointerEvents = "auto";
          if (!introVeil.parentNode) document.body.prepend(introVeil);
        }
      }
      introState.completed = false;
      introState.active = true;
      document.body.classList.add("is-intro");
      const t = Math.max(0, Math.min(INTRO_DURATION_MS, Number(ms) || 0));
      introState.holdMs = t;
      introState.startPerf = performance.now() - t;
      // Allow mist to replay when seeking before the hard-clear point.
      introState.mistCleared = false;
      if (t >= INTRO_DURATION_MS) {
        introState.holdMs = null;
        sampleIntroAt(INTRO_DURATION_MS);
        finishIntro();
      } else {
        if (introVeil && t < MIST_FADE_END_MS) {
          introVeil.classList.remove("is-gone", "is-fading");
          if (!introVeil.parentNode) document.body.prepend(introVeil);
        }
        sampleIntroAt(t);
      }
      return true;
    },
  };

  // Temporary calibration API — consumed only by camera-debug.js when ?cameraDebug=1.
  window.__STIPPLED_CAMERA__ = {
    getFraming: () => ({ ...CAMERA_FRAMING }),
    setFramingBias,
    getDerived: getCameraDerived,
    getBakedMatch,
    getBakedPoses: () => ({
      shot2: INTRO_CAMERA_SHOTS.distant,
      landing: INTRO_CAMERA_SHOTS.final,
      framing: { ...CAMERA_FRAMING },
      referenceViewport: { ...CAMERA_REF_VIEWPORT },
      shot2AtMs: INTRO_SHOT2_MS,
      durationMs: INTRO_DURATION_MS,
    }),
    snapshotPose,
    applyCapturedPose,
    setWorldPose,
    commitLiveCamera,
    writeHeroPose,
    writeDistantPose,
    finishIntro,
    seekIntro: (ms) => window.__STIPPLED_PERF__.seekIntro(ms),
    previewMode(mode) {
      if (mode === "shot2" || mode === "freezeShot2") {
        introState.completed = false;
        introState.active = true;
        introState.started = true;
        introState.mistCleared = false;
        introState.holdMs = INTRO_SHOT2_MS;
        introState.startPerf = performance.now() - INTRO_SHOT2_MS;
        document.body.classList.add("is-intro");
        // Exact CAM-002 pose (debug hold) — independent of the ease-out flight clock.
        writeDistantPose(_introPosA, _introLookA);
        applyIntroCameraPose(_introPosA, _introLookA);
        applyFinalClearSceneState();
        return;
      }
      if (mode === "shot3" || mode === "landing" || mode === "jumpLanding") {
        introSkipToEnd();
        writeHeroPose(_introPos, _introLook);
        cameraState.position.copy(_introPos);
        cameraState.lookAt.copy(_introLook);
        cameraState.targetPosition.copy(_introPos);
        cameraState.targetLookAt.copy(_introLook);
        clampNavigation();
        cameraState.position.copy(cameraState.targetPosition);
        cameraState.lookAt.copy(cameraState.targetLookAt);
        commitLiveCamera();
        applyFinalClearSceneState();
        return;
      }
      if (mode === "shot1") {
        warmIntroShaders();
        introState.started = true;
        introState.active = true;
        introState.completed = false;
        introState.mistCleared = false;
        introState.holdMs = 50;
        document.body.classList.add("is-intro");
        if (introVeil) {
          introVeil.classList.remove("is-gone", "is-fading");
          introVeil.style.opacity = "1";
          introVeil.style.pointerEvents = "auto";
          if (!introVeil.parentNode) document.body.prepend(introVeil);
        }
        sampleIntroAt(50);
        return;
      }
      if (mode === "intro") {
        introState.completed = false;
        introState.active = true;
        introState.started = true;
        introState.mistCleared = false;
        introState.holdMs = null;
        introState.startPerf = performance.now();
        document.body.classList.add("is-intro");
        if (introVeil) {
          introVeil.classList.remove("is-gone", "is-fading");
          introVeil.style.opacity = "1";
          introVeil.style.pointerEvents = "auto";
          if (!introVeil.parentNode) document.body.prepend(introVeil);
        }
        sampleIntroAt(0);
        return;
      }
      // free
      introState.holdMs = null;
      if (!introState.completed) introSkipToEnd();
      else applyFinalClearSceneState();
    },
    getLiveState() {
      return {
        position: cameraState.position.clone(),
        lookAt: cameraState.lookAt.clone(),
        targetPosition: cameraState.targetPosition.clone(),
        targetLookAt: cameraState.targetLookAt.clone(),
      };
    },
  };

  if (new URLSearchParams(location.search).get("cameraDebug") === "1") {
    import("./camera-debug.js")
      .then((mod) => mod.mount(window.__STIPPLED_CAMERA__))
      .catch((err) => console.error("[camera-debug] failed to mount", err));
  }
})();
