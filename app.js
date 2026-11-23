"use strict";
const METHODS = ["qutcc", "im2im", "deepensemble", "mcdropout"],
  NAMES = { qutcc: "QUTCC", im2im: "Im2im", deepensemble: "DeepEnsemble", mcdropout: "MCDropout" },
  COLORS = { qutcc: "#63dbce", im2im: "#f2b76a", deepensemble: "#a78bfa", mcdropout: "#f87171" };
const $ = (s) => document.querySelector(s);
let data, assets, index = 0, example = null, busy = false,
  point = { x: 240, y: 135 }, requestSerial = 0;
const CACHE = new Map();

function makeDemoExample() {
  const W = 480, H = 270, N = W * H;
  let s = 0x12345678;
  const rand = () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };

  const measurement = new Uint8Array(3 * N);
  for (let c = 0; c < 3; c++) {
    const base = [0.4, 0.3, 0.6][c];
    for (let i = 0; i < N; i++)
      measurement[c * N + i] = Math.round(Math.max(0, Math.min(255, (base + (rand() - 0.5) * 0.5) * 255)));
  }

  const target = new Uint8Array(3 * N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      target[0 * N + y * W + x] = Math.round((0.3 + 0.5 * x / W) * 255);
      target[1 * N + y * W + x] = Math.round((0.2 + 0.5 * y / H) * 255);
      target[2 * N + y * W + x] = Math.round((0.5 - 0.3 * x / W + 0.2 * y / H) * 255);
    }

  const models = {};
  const noiseScale = [0.08, 0.07, 0.12, 0.15];
  const widthScale = [0.06, 0.05, 0.10, 0.13];
  for (const [i, method] of METHODS.entries()) {
    s = 0xdeadbe00 + i * 0x9e3779b9;
    const prediction = new Float32Array(3 * N);
    const lower = new Float32Array(3 * N);
    const upper = new Float32Array(3 * N);
    for (let j = 0; j < 3 * N; j++) {
      const t = target[j] / 255;
      prediction[j] = Math.max(0, Math.min(1, t + (rand() - 0.5) * noiseScale[i]));
      const w = widthScale[i] * (0.5 + rand());
      lower[j] = Math.max(0, prediction[j] - w * 0.5);
      upper[j] = Math.min(1, prediction[j] + w * 0.5);
    }
    models[method] = { prediction, lower, upper };
  }

  return {
    id: "demo", width: W, height: H,
    measurement, target, models,
    arrays: [{ name: "target", shape: [3, H, W] }],
  };
}

function controls(disabled) {
  window.exampleBrowser?.setBusy(disabled);
  for (const id of ["example", "previous", "next", "random"])
    $("#" + id).disabled = disabled;
}

async function unpack(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const decompressed = new Response(response.body.pipeThrough(new DecompressionStream("gzip"))),
    buffer = await decompressed.arrayBuffer(),
    view = new DataView(buffer),
    length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))),
    start = 4 + length,
    arrays = {};
  for (const d of header.arrays) {
    const bytes = new Uint8Array(buffer, start + d.offset, d.length);
    if (d.encoding === "uint8") {
      arrays[d.name] = Uint8Array.from(bytes);
    } else {
      const size = bytes.length / 4, ordered = new Uint8Array(bytes.length);
      for (let byte = 0; byte < 4; byte++)
        for (let i = 0; i < size; i++)
          ordered[4 * i + byte] = bytes[byte * size + i];
      arrays[d.name] = new Float32Array(ordered.buffer);
    }
  }
  return { ...header, ...arrays };
}

function heat(v) {
  const t = Math.min(1, Math.max(0, v)),
    stops = [[20,35,60],[34,95,157],[35,185,172],[243,203,85],[250,112,82]],
    i = Math.min(3, Math.floor(t * 4)), f = t * 4 - i;
  return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
}

function paint(canvas, kind, model) {
  const { width: w, height: h } = example, N = w * h;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(w, h);
  let arr;
  if (kind === "measurement" || kind === "target") arr = example[kind];
  else arr = example.models[model][kind];
  for (let i = 0; i < N; i++) {
    let rgb;
    if (kind === "error" || kind === "width") {
      let value = 0;
      const m = example.models[model];
      for (let c = 0; c < 3; c++) {
        const k = c * N + i;
        value += kind === "error"
          ? Math.abs(example.target[k] / 255 - m.prediction[k])
          : m.upper[k] - m.lower[k];
      }
      rgb = heat(value / 3);
    } else {
      rgb = [0, 1, 2].map((c) => Math.max(0, Math.min(255,
        arr[c * N + i] * (arr instanceof Uint8Array ? 1 : 255))));
    }
    for (let c = 0; c < 3; c++) img.data[4 * i + c] = rgb[c];
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (kind !== "measurement") HeatmapPixels.drawCanvas(canvas, point.x + 0.5, point.y + 0.5);
  if (kind === "measurement") { canvas.onclick = null; return; }
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    point = {
      x: Math.max(0, Math.min(w - 1, Math.floor(((e.clientX - r.left) / r.width) * w))),
      y: Math.max(0, Math.min(h - 1, Math.floor(((e.clientY - r.top) / r.height) * h))),
    };
    $("#pixelInspector").open = true;
    drawImages();
  };
}

function renderPixel() {
  if (!example) return;
  const N = example.width * example.height, p = point.y * example.width + point.x,
    ch = $("#channel").value, channels = ch === "rgb" ? [0, 1, 2] : [Number(ch)];
  const read = (a, byte = false) =>
    channels.reduce((sum, c) => sum + a[c * N + p] / (byte ? 255 : 1), 0) / channels.length;
  const target = read(example.target, true);
  $("#pixelTitle").textContent = `Selected pixel (${point.x}, ${point.y})`;
  $("#pixelTruth").textContent =
    `Ground truth: ${target.toFixed(6)} · ${ch === "rgb" ? "RGB average" : ["Red", "Green", "Blue"][Number(ch)]}`;
  $("#pixelRows").innerHTML = METHODS.map((method) => {
    const m = example.models[method];
    if (!m) return `<tr><td>${NAMES[method]}</td><td colspan="5">Inference pending</td></tr>`;
    const pred = read(m.prediction), lo = read(m.lower), hi = read(m.upper);
    const err = channels.reduce((s, c) => s + Math.abs(example.target[c * N + p] / 255 - m.prediction[c * N + p]), 0) / channels.length;
    return `<tr><td>${NAMES[method]}</td>${[pred, lo, hi, err, hi - lo].map((v) => `<td>${v.toFixed(6)}</td>`).join("")}</tr>`;
  }).join("");
}

function drawImages() {
  if (!example) return;
  paint($("#measurement"), "measurement");
  paint($("#target"), "target");
  for (const c of document.querySelectorAll("#matrix canvas"))
    paint(c, c.dataset.kind, c.dataset.method);
  renderPixel();
}

function renderExample() {
  window.exampleBrowser?.update(index);
  const cols = [
    ["prediction", "Reconstruction"], ["error", "Error"], ["width", "Uncertainty"],
    ["lower", "Lower"], ["upper", "Upper"],
  ];
  const isBound = (kind) => kind === "lower" || kind === "upper";
  let html = `<div class="method-row col-headers"><div class="method-label"></div>` +
    cols.map(([kind, label]) => `<div class="${isBound(kind) ? "bound-image" : ""}">${label}</div>`).join("") +
    `</div>`;
  for (const method of METHODS) {
    const m = example.models[method];
    const nameDiv = `<div class="method-label" style="color:${COLORS[method]}">${NAMES[method]}</div>`;
    if (!m) {
      html += `<div class="method-row">${nameDiv}<p class="pending-method">Inference pending.</p></div>`;
      continue;
    }
    const figures = cols.map(([kind]) =>
      `<figure class="${isBound(kind) ? "bound-image" : ""}"><canvas class="image" data-kind="${kind}" data-method="${method}"></canvas></figure>`
    ).join("");
    html += `<div class="method-row">${nameDiv}${figures}</div>`;
  }
  $("#matrix").innerHTML = html;
  drawImages();
  $("#status").textContent = `${index + 1} / ${data.example_count} · ID ${example.id}`;
}

async function loadExample() {
  const serial = ++requestSerial;
  busy = true; controls(true);
  $("#status").textContent = "Loading…";
  const key = String(index);
  try {
    let item = CACHE.get(key);
    if (!item) {
      const loaded = await Promise.all(METHODS.map((m) =>
        unpack(`${assets.base}/${m}/example_${String(index).padStart(2, "0")}.bin.gz`)));
      for (let i = 1; i < loaded.length; i++)
        if (String(loaded[i].id) !== String(loaded[0].id) || loaded[i].target.length !== loaded[0].target.length)
          throw Error("Example pairing mismatch");
      const shape = loaded[0].arrays.find((d) => d.name === "target").shape;
      item = {
        id: loaded[0].id, width: shape[2], height: shape[1],
        measurement: loaded[0].measurement, target: loaded[0].target,
        models: Object.fromEntries(METHODS.map((m, i) => [m, loaded[i]])),
      };
      if (CACHE.size > 5) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(key, item);
    }
    if (serial !== requestSerial) return;
    example = item;
    point.x = Math.min(point.x, item.width - 1);
    point.y = Math.min(point.y, item.height - 1);
    renderExample();
    const u = new URL(location.href);
    u.searchParams.set("example", index);
    history.replaceState(null, "", u);
  } catch (e) {
    if (serial === requestSerial)
      $("#status").textContent = "Could not load example: " + e.message;
    console.error(e);
  } finally {
    if (serial === requestSerial) { busy = false; controls(false); }
  }
}

(async () => {
  try {
    [data, assets] = await Promise.all(
      ["data.json", "assets.json"].map(async (file) => {
        const r = await fetch(file, { cache: "no-store" });
        if (!r.ok) throw Error(file + " HTTP " + r.status);
        return r.json();
      })
    );
    if (data.example_count === 0) {
      example = makeDemoExample();
      renderExample();
      $("#status").textContent = "Layout preview · inference pending";
      controls(true);
      return;
    }
    const params = new URLSearchParams(location.search);
    index = Math.max(0, Math.min(data.example_count - 1, Number(params.get("example")) || 0));
    $("#example").innerHTML = Array.from({ length: data.example_count }, (_, i) =>
      `<option value="${i}">${i + 1}</option>`).join("");
    $("#example").value = index;
    $("#example").onchange = () => { index = Number($("#example").value); loadExample(); };
    $("#next").onclick = () => { index = (index + 1) % data.example_count; $("#example").value = index; loadExample(); };
    $("#previous").onclick = () => { index = (index + data.example_count - 1) % data.example_count; $("#example").value = index; loadExample(); };
    $("#random").onclick = () => { index = Math.floor(Math.random() * data.example_count); $("#example").value = index; loadExample(); };
    $("#channel").onchange = renderPixel;
    $("#showBounds").onclick = () => { const on = $("#matrix").classList.toggle("show-bounds"); $("#showBounds").classList.toggle("active", on); };
    loadExample();
  } catch (e) {
    $("#status").textContent = "Could not load results: " + e.message;
    console.error(e);
  }
})();
