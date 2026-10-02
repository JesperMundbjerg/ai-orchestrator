// Purpose-made, fictional demo illustrations. No external images, fonts or product branding.
// Regenerate: node scripts/demo-assets/generate.mjs (requires the browser-test Playwright setup).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import { join } from "node:path";

export function illustration(title, panel = "", planner = false) {
  return `<!doctype html><html><meta charset="utf-8"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#eceee6;color:#283b34;font:20px system-ui}header{background:#23483d;color:white;padding:24px 38px;font-weight:650;display:flex;justify-content:space-between}header span{font-size:15px;color:#c3d8cc}.app{margin:42px;display:flex;gap:22px;height:560px}nav{width:210px;padding:28px;border-radius:18px;background:#dce4d9}nav p{font-size:17px;padding:14px 0;border-bottom:1px solid #becfc1}main{flex:1;background:#fffdf7;border-radius:18px;padding:36px}h1{font-size:34px;margin:0 0 12px}small{font-size:15px;color:#6c7d6c}.line{height:12px;border-radius:6px;background:#e8eadf;margin:22px 0;width:90%}.line.short{width:60%}.card{padding:24px;background:#f3f4e9;border:1px solid #d8decf;border-radius:12px;margin-top:24px}.card b{display:block;margin-bottom:14px}.tag{display:inline-block;background:#dce8ce;padding:8px 16px;border-radius:20px;font-size:15px;margin-right:10px}aside{width:260px;background:#23483d;color:#fff;padding:28px;border-radius:18px}aside p{background:#355a4c;border-radius:10px;padding:20px;font-size:17px}footer{margin:0 42px;font-size:14px;color:#6b7d6d}
</style><header>${planner ? "Pebble · daily planner" : "Lantern · notes"}<span>Fictional demo</span></header><div class="app"><nav><b>${planner ? "My week" : "Notebooks"}</b><p>${planner ? "Monday" : "Field notes"}</p><p>${planner ? "Tuesday" : "Ideas"}</p><p>${planner ? "Wednesday" : "Reading list"}</p></nav><main><small>${planner ? "THIS WEEK" : "FIELD NOTES / 3 NOTES"}</small><h1>${title}</h1><small>${planner ? "A little room for what matters" : "Saved just now · personal notebook"}</small><div class="card"><b>${planner ? "Plant herbs on the balcony" : "A walk by the river"}</b><div class="line"></div><div class="line short"></div><span class="tag">${planner ? "Home" : "Outdoors"}</span><span class="tag">${planner ? "Later" : "Ideas"}</span></div><div class="card"><b>${planner ? "Write a postcard" : "Sketch a new reading corner"}</b><div class="line short"></div></div></main>${panel ? `<aside><b>${panel}</b><p>river<br><small>2 notes found</small></p><p>A walk by the river</p><p>Weekend ideas</p></aside>` : ""}</div><footer>Purpose-made sample interface · not a real product screenshot</footer></html>`;
}

if (import.meta.main) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    for (const [file, title, panel, planner] of [
      ["search-closed.png", "Field notes", "", false],
      ["search-docked.png", "Field notes", "Search notes", false],
      ["planner-week.png", "A quiet week", "", true],
      ["planner-day.png", "Tuesday's plan", "", true],
      ["planner-tags.png", "Plans by category", "", true],
    ]) {
      await page.setContent(illustration(title, panel, planner));
      await page.screenshot({ path: join(import.meta.dirname, file) });
    }
  } finally { await browser.close(); }
}
