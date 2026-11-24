"use strict";
const METHODS = ["qutcc", "im2im", "deepensemble", "mcdropout"],
  NAMES = { qutcc: "QUTCC", im2im: "Im2im", deepensemble: "Deep ensemble", mcdropout: "MC dropout" },
  COLORS = { qutcc: "#63dbce", im2im: "#f2b76a", deepensemble: "#a78bfa", mcdropout: "#f87171" };
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

// Smooth scalar values before coloring, with a 2-pixel Gaussian and replicated edges.
function smoothMap(values, sigma, width, height) {
  const radius = Math.max(1, Math.round(3 * sigma));
  const weights = Array.from({length: 2 * radius + 1}, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma ** 2)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = Math.max(0, Math.min(width - 1, x + dx));
        total += weights[dx + radius] * values[y * width + xx];
      }
      horizontal[y * width + x] = total / sum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.max(0, Math.min(height - 1, y + dy));
        total += weights[dy + radius] * horizontal[yy * width + x];
      }
      result[y * width + x] = total / sum;
    }
  }
  return result;
}

function rawMap(model, kind) {
  if (model[kind]) return model[kind];
  const {width, height, target} = example;
  const count = width * height;
  const values = new Float32Array(count);
  for (let i = 0; i < values.length; i++) {
    for (let c = 0; c < 3; c++) {
      const k = c * count + i;
      values[i] += (kind === "error" ? Math.abs(target[k] / 255 - model.prediction[k])
        : model.upper[k] - model.lower[k]) / 3;
    }
  }
  model[kind] = values;
  return values;
}

function displayMap(model, kind) {
  const raw = rawMap(model, kind);
  const sigma = Number($("#blur").value);
  if (!sigma) return raw;
  model.smoothed ??= {};
  model.smoothed[sigma] ??= {};
  return model.smoothed[sigma][kind] ??= smoothMap(raw, sigma, example.width, example.height);
}

function paint(canvas, kind, model) {
  const { width: w, height: h } = example, N = w * h;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(w, h);
  let arr;
  if (kind === "measurement" || kind === "target") arr = example[kind];
  else if (kind === "error" || kind === "width") {
    arr = displayMap(example.models[model], kind);
  }
  else arr = example.models[model][kind];
  for (let i = 0; i < N; i++) {
    let rgb;
    if (kind === "error" || kind === "width") {
      rgb = heat(arr[i]);
    } else {
      rgb = [0, 1, 2].map((c) => Math.max(0, Math.min(255,
        arr[c * N + i] * (arr instanceof Uint8Array ? 1 : 255))));
    }
    for (let c = 0; c < 3; c++) img.data[4 * i + c] = rgb[c];
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (kind !== "measurement" && $("#pixelInspector").open) HeatmapPixels.drawCanvas(canvas, point.x + 0.5, point.y + 0.5);
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
  $("#pixelSpread").textContent = "MC dropout SD across 50 passes (RGB mean): " + example.models.mcdropout.spread[p].toFixed(6);
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
    ["prediction", "Reconstruction"], ["error", "Absolute error"], ["width", "Uncertainty"],
    ["lower", "Lower bound (LB)"], ["upper", "Upper bound (UB)"],
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
    const figures = cols.map(([kind, label]) => {
      const dropoutBound = method === "mcdropout" && isBound(kind);
      const caption = dropoutBound
        ? `<a href="bounds/${encodeURIComponent(example.id.replace(/\.png$/, ""))}/${kind}.png" download>${label} · PNG</a>`
        : label;
      return `<figure class="${isBound(kind) ? "bound-image" : ""}"><figcaption class="panel-title${dropoutBound ? " dropout-bound" : ""}">${caption}</figcaption><canvas class="image" aria-label="${NAMES[method]} ${label}" data-kind="${kind}" data-method="${method}"></canvas></figure>`;
    }).join("");
    html += `<div class="method-row">${nameDiv}${figures}</div>`;
  }
  $("#matrix").innerHTML = html;
  drawImages();
  $("#status").textContent = `${index + 1} / ${data.scenes.length} · ${example.id} · Im2im SSIM ${data.scenes[index].ssim.toFixed(3)}`;
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
        unpack(`${assets.base}/${m}/example_${String(index).padStart(2, "0")}.bin.gz${m === "mcdropout" ? "?v=gaussian50" : ""}`)));
      for (let i = 1; i < loaded.length; i++)
        if (String(loaded[i].id) !== String(loaded[0].id) || loaded[i].prediction.length !== loaded[0].target.length)
          throw Error("Example pairing mismatch");
      if (loaded[0].id !== data.scenes[index].id) throw Error("Scene ID differs from label");
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
    const params = new URLSearchParams(location.search);
    index = Math.max(0, Math.min(data.scenes.length - 1, Math.trunc(Number(params.get("example"))) || 0));
    $("#example").innerHTML = Array.from({ length: data.scenes.length }, (_, i) =>
      `<option value="${i}">${data.scenes[i].objects}</option>`).join("");
    $("#example").value = index;
    $("#example").onchange = () => { index = Number($("#example").value); loadExample(); };
    $("#next").onclick = () => { index = (index + 1) % data.scenes.length; $("#example").value = index; loadExample(); };
    $("#previous").onclick = () => { index = (index + data.scenes.length - 1) % data.scenes.length; $("#example").value = index; loadExample(); };
    $("#random").onclick = () => { index = Math.floor(Math.random() * data.scenes.length); $("#example").value = index; loadExample(); };
    $("#channel").onchange = renderPixel;
    $("#pixelInspector").ontoggle = drawImages;
    $("#blur").onchange = () => {
      if (example)
        for (const canvas of document.querySelectorAll('[data-kind="width"], [data-kind="error"]'))
          paint(canvas, canvas.dataset.kind, canvas.dataset.method);
    };
    $("#showBounds").onclick = () => { const on = $("#matrix").classList.toggle("show-bounds"); $("#showBounds").setAttribute("aria-expanded", on); $("#showBounds").textContent = on ? "Hide bounds" : "Show bounds"; };
    loadExample();
  } catch (e) {
    $("#status").textContent = "Could not load results: " + e.message;
    console.error(e);
  }
})();
