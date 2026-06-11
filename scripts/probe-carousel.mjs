// One-off: inspect which carousel/tab controls exist on a page.
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://www.elmwoodcdjr.com/";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);

const report = await page.evaluate(() => {
  const probe = (sel) => {
    try {
      return [...document.querySelectorAll(sel)].map((el) => ({
        sel,
        cls: (el.className || "").toString().slice(0, 80),
        aria: el.getAttribute("aria-label"),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }));
    } catch { return []; }
  };
  return [
    ".slick-next", ".swiper-button-next", ".carousel-control-next",
    'button[aria-label*="next" i]', '[class*="slider" i] button',
    '[class*="carousel" i] button', '[role="tablist"] [role="tab"]',
    '[data-bs-slide="next"]', '[data-slide="next"]', ".owl-next",
    '[class*="next" i]',
  ].flatMap(probe).filter(r => r.visible).slice(0, 25);
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
