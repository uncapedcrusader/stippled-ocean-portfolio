/**
 * Temporary production QA harness — not shipped to visitors.
 * Measures locked look, renderer.info, FPS, and localStorage independence.
 */
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const BASE = "http://localhost:5173/?qa=1";
const OUT = path.resolve("qa-baseline");

fs.mkdirSync(OUT, { recursive: true });

async function openPage(browser, { clearStorage, seedOldStorage, viewport }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto("about:blank");
  if (clearStorage || seedOldStorage) {
    await page.goto(BASE);
    await page.evaluate((seed) => {
      localStorage.clear();
      if (seed) {
        localStorage.setItem(
          "stippled-ocean-appearance-colours-v1",
          JSON.stringify({
            background: "#000000",
            bodies: "#20cccf",
            waves: "#ffffff",
          })
        );
        localStorage.setItem(
          "stippled-ocean-appearance-mark-making-v1",
          JSON.stringify({
            surfaceDensity: 8,
            contourDensity: 8,
            waveParticleDensity: 1,
            waveRidgeEmphasis: 4,
            bodyDotScale: 8,
            waveDotScale: 8,
          })
        );
        localStorage.setItem(
          "stippled-ocean-float-tune-v4",
          JSON.stringify({
            projects: { x: 0, z: 0, scale: 1, immersion: 0.1, immersionOffset: 0, bob: 1, maxTiltDeg: 1, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
            about: { x: 0, z: 0, scale: 1, immersion: 0.1, immersionOffset: 0, bob: 1, maxTiltDeg: 1, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
            interests: { x: 0, z: 0, scale: 1, immersion: 0.1, immersionOffset: 0, bob: 1, maxTiltDeg: 1, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 },
          })
        );
      }
    }, seedOldStorage);
  }
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 120000 });
  // Wait for GLBs + a few frames
  await page.waitForFunction(
    () => {
      const p = window.__STIPPLED_PERF__;
      return p && p.getInfo().modelsReady >= 3;
    },
    { timeout: 120000 }
  );
  await new Promise((r) => setTimeout(r, 1500));
  return page;
}

async function probe(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("ocean");
    const tune = document.querySelector(
      ".float-tune-chrome, #float-tune-toggle, #view-bar, #comp-labels"
    );
    const bg = getComputedStyle(document.body).backgroundColor;
    const hint = document.querySelector(".hint");
    const perf =
      typeof window.__STIPPLED_PERF__?.getInfo === "function"
        ? window.__STIPPLED_PERF__.getInfo()
        : null;
    return {
      hasTuneUI: !!tune,
      bodyBg: bg,
      hintText: hint ? hint.textContent.trim() : null,
      canvasW: canvas.width,
      canvasH: canvas.height,
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      dpr: window.devicePixelRatio,
      storageKeys: Object.keys(localStorage).filter((k) =>
        k.startsWith("stippled-ocean")
      ),
      perf,
    };
  });
}

async function measureFps(page, ms = 3000) {
  return page.evaluate(async (duration) => {
    const canvas = document.getElementById("ocean");
    let frames = 0;
    const t0 = performance.now();
    await new Promise((resolve) => {
      function tick(now) {
        frames++;
        if (now - t0 >= duration) resolve();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const elapsed = performance.now() - t0;
    return {
      frames,
      elapsedMs: elapsed,
      fps: (frames / elapsed) * 1000,
      canvasBytes: canvas.width * canvas.height * 4,
    };
  }, ms);
}

async function interact(page) {
  const v = page.viewport();
  const cx = Math.floor(v.width * 0.5);
  const cy = Math.floor(v.height * 0.55);
  // Click focus
  await page.mouse.click(cx, cy);
  await new Promise((r) => setTimeout(r, 400));
  // Drag splash
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cx - 80 + i * 14, cy - i * 2, { steps: 2 });
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  // Double-click burst
  await page.mouse.click(cx + 40, cy + 20, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"],
});

const report = { exe, cases: [] };

try {
  // Clean load
  {
    const page = await openPage(browser, {
      clearStorage: true,
      seedOldStorage: false,
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    });
    const info = await probe(page);
    await page.screenshot({
      path: path.join(OUT, "clean-dpr1-wide.png"),
      type: "png",
    });
    const fps = await measureFps(page, 2500);
    await interact(page);
    await page.screenshot({
      path: path.join(OUT, "clean-dpr1-after-interact.png"),
      type: "png",
    });
    const transfer = await page.evaluate(async () => {
      const entries = performance.getEntriesByType("resource");
      const js = entries.find((e) => e.name.includes("script.js"));
      const html = entries.find((e) => e.name.replace(/\/$/, "").endsWith(":5173") || e.name.endsWith("/"));
      const css = entries.find((e) => e.name.includes("style.css"));
      return {
        scriptTransfer: js ? js.transferSize : null,
        scriptDecoded: js ? js.decodedBodySize : null,
        cssTransfer: css ? css.transferSize : null,
        nav: performance.getEntriesByType("navigation")[0]
          ? {
              domContentLoaded:
                performance.getEntriesByType("navigation")[0]
                  .domContentLoadedEventEnd,
              load: performance.getEntriesByType("navigation")[0].loadEventEnd,
            }
          : null,
      };
    });
    report.cases.push({ name: "clean-dpr1", info, fps, transfer });
    await page.close();
  }

  // Old dirty localStorage must not change look
  {
    const page = await openPage(browser, {
      clearStorage: true,
      seedOldStorage: true,
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    });
    const info = await probe(page);
    await page.screenshot({
      path: path.join(OUT, "dirty-storage-dpr1.png"),
      type: "png",
    });
    report.cases.push({ name: "dirty-storage", info });
    await page.close();
  }

  // DPR 2
  {
    const page = await openPage(browser, {
      clearStorage: true,
      seedOldStorage: false,
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    });
    const info = await probe(page);
    const fps = await measureFps(page, 2500);
    await page.screenshot({
      path: path.join(OUT, "clean-dpr2-wide.png"),
      type: "png",
    });
    report.cases.push({ name: "clean-dpr2", info, fps });
    await page.close();
  }

  // Mobile narrow
  {
    const page = await openPage(browser, {
      clearStorage: true,
      seedOldStorage: false,
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    });
    const info = await probe(page);
    await page.screenshot({
      path: path.join(OUT, "mobile-narrow.png"),
      type: "png",
    });
    report.cases.push({ name: "mobile", info });
    await page.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
