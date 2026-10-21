// Webcam fallback: when the stream's response never arrives (like a security agent buffering it), switch to snapshots.
const { chromium } = require("playwright"); const fs = require("fs"); const R = [];
function ok(n, p, d) { R.push((p ? "PASS " : "FAIL ") + n + (d !== undefined ? " - " + JSON.stringify(d).slice(0, 220) : "")); }
async function page(b, hangStream) {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies(JSON.parse(fs.readFileSync(__dirname + "/.session.json", "utf8")).cookies);
  await ctx.addInitScript(() => { try { localStorage.setItem("kobra_ui.viewMode", "webcam"); localStorage.removeItem("kobra_ui.camMode"); } catch (e) {} });
  if (hangStream) await ctx.route(/\/plugin\/kobra_ui\/stream/, () => { /* never answer: the response is held back */ });
  const p = await ctx.newPage(); p._reqs = []; p.on("request", r => { const m = /plugin\/kobra_ui\/(stream|snapshot)/.exec(r.url()); if (m) p._reqs.push(m[1]); });
  await p.goto("http://octoprint-kobra:5000/?kui=printer", { waitUntil: "domcontentloaded" }); await p.waitForSelector("html.kui-on #kui .app", { timeout: 120000 });
  return p;
}
const st = p => p.evaluate(() => { const v = ko.dataFor(document.getElementById("kui")), img = document.getElementById("kui-webcam"); let mode = null; try { mode = localStorage.getItem("kobra_ui.camMode"); } catch (e) {} return { state: v.camState(), fps: v.camFps(), w: img.naturalWidth, mode: mode }; });
(async () => { const b = await chromium.launch();
  const a = await page(b, true); await a.waitForTimeout(12000);
  const s1 = await st(a), snaps = a._reqs.filter(x => x === "snapshot").length;
  ok("held-back stream -> snapshots, live", s1.state === "live" && s1.w === 640 && snaps >= 10, Object.assign(s1, { snapshots: snaps }));
  ok("the choice is remembered for this browser", s1.mode === "snapshot", s1.mode);
  ok("snapshot rate is real video, not a slideshow (>= 4 fps)", s1.fps >= 4, s1.fps);
  await a.context().close();
  const n = await page(b, false); await n.waitForTimeout(9000);
  const s2 = await st(n);
  ok("normal browser keeps the live stream", s2.state === "live" && s2.fps > 0 && !n._reqs.includes("snapshot"), Object.assign(s2, { reqs: [...new Set(n._reqs)] }));
  await n.context().close();
  console.log(R.join("\n")); await b.close(); })();
