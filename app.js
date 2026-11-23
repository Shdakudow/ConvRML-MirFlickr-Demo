"use strict";
const METHODS = ["qutcc", "im2im"],
  NAMES = { qutcc: "QUTCC", im2im: "Im2im" },
  COLORS = { qutcc: "#63dbce", im2im: "#f2b76a" };
const $ = (s) => document.querySelector(s);
let data, assets, index = 0, example = null, busy = false,
  point = { x: 240, y: 135 }, requestSerial = 0;
const CACHE = new Map();

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
  let html = "";
  for (const method of METHODS) {
    const m = example.models[method];
    if (!m) {
      html += `<div class="model-header"><h3>${NAMES[method]}</h3><p>Inference pending.</p></div>`;
      continue;
    }
    html += `<div class="model-header"><h3 style="color:${COLORS[method]}">${NAMES[method]}</h3></div>`;
    for (const [kind, label] of [
      ["prediction", "Reconstruction"], ["error", "Error"], ["width", "Uncertainty"],
      ["lower", "Lower bound"], ["upper", "Upper bound"],
    ])
      html += `<figure class="${["lower", "upper"].includes(kind) ? "bound-image" : ""}"><figcaption>${label}</figcaption><canvas class="image" data-kind="${kind}" data-method="${method}"></canvas></figure>`;
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
      const [a, b] = loaded;
      if (String(a.id) !== String(b.id) || a.target.length !== b.target.length)
        throw Error("Example pairing mismatch");
      const shape = a.arrays.find((d) => d.name === "target").shape;
      item = {
        id: a.id, width: shape[2], height: shape[1],
        measurement: a.measurement, target: a.target,
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
      $("#status").textContent = "Inference pending — examples not yet available.";
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
    $("#showBounds").onchange = () => $("#matrix").classList.toggle("show-bounds", $("#showBounds").checked);
    loadExample();
  } catch (e) {
    $("#status").textContent = "Could not load results: " + e.message;
    console.error(e);
  }
})();
