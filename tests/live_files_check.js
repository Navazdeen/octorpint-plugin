// Files view checks: tiles keep their own layout (big thumbnail, readable name) and no deck styling leaks in.
const { chromium } = require("playwright"); const fs = require("fs"); const R = [];
function ok(n, p, d) { R.push((p ? "PASS " : "FAIL ") + n + (d !== undefined ? " - " + JSON.stringify(d).slice(0, 200) : "")); }
(async () => { const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 2000, height: 1000 } });
  await ctx.addCookies(JSON.parse(fs.readFileSync(__dirname + "/.session.json", "utf8")).cookies);
  await ctx.addInitScript(() => { try { localStorage.setItem("kobra_ui.viewMode", "webcam"); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto("http://octoprint-kobra:5000/?kui=files", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("html.kui-on #kui .app", { timeout: 120000 }); await p.waitForTimeout(5000);
  const m = await p.evaluate(() => { const t = document.querySelector('#kui section[aria-labelledby="kui-h1-files"] .tiles > *');
    if (!t) return null; const img = t.querySelector("img, .shot, .folder"), name = t.querySelector(".name, .n, b, strong") || t;
    const r = t.getBoundingClientRect(), ir = img ? img.getBoundingClientRect() : { width: 0, height: 0 };
    return { cls: t.className, display: getComputedStyle(t).display, cols: getComputedStyle(t).gridTemplateColumns, w: Math.round(r.width), imgW: Math.round(ir.width), imgH: Math.round(ir.height), html: t.innerHTML.slice(0, 160) }; });
  ok("file tile thumbnail fills the tile width", m && m.imgW >= m.w * 0.8, m);
  ok("file tile isn't styled as a deck tile", m && m.cols.split(" ").length < 3, m);
  await p.screenshot({ path: "/home/navaz/kobra-printer/shots/files-check.png", clip: { x: 0, y: 0, width: 1200, height: 500 } });
  // clicking a file selects it (the deck must not replace the Files view's click handler)
  await p.click('#kui section[aria-labelledby="kui-h1-files"] .tiles > .tile:nth-child(2)'); await p.waitForTimeout(300);
  const sel = await p.evaluate(() => ko.dataFor(document.getElementById("kui")).selectedPath());
  ok("clicking a file tile selects it", !!sel, sel);
  // bed mesh: Map -> 3D -> Map keeps the map centred with its axis label beside it
  await p.evaluate(() => { history.pushState(null, "", "?kui=mesh"); dispatchEvent(new PopStateEvent("popstate")); }); await p.waitForTimeout(1500);
  const vm = "ko.dataFor(document.getElementById('kui'))";
  await p.evaluate(`${vm}.setMeshMode("3d")`); await p.waitForTimeout(1500); await p.evaluate(`${vm}.setMeshMode("map")`); await p.waitForTimeout(500);
  const mw = await p.evaluate(() => { const h = document.querySelector("#kui .heat"), w = h.parentNode, c = h.closest(".card");
    const hr = h.getBoundingClientRect(), cr = c.getBoundingClientRect(), lab = w.firstElementChild.getBoundingClientRect();
    return { display: getComputedStyle(w).display, gapL: Math.round(hr.left - cr.left), gapR: Math.round(cr.right - hr.right), labelBeside: Math.abs((lab.top + lab.bottom) / 2 - (hr.top + hr.bottom) / 2) < 30 }; });
  ok("mesh map stays centred after Map -> 3D -> Map", mw.display === "flex" && Math.abs(mw.gapL - mw.gapR) < 60 && mw.labelBeside, mw);
  console.log(R.join("\n")); await b.close(); })();
