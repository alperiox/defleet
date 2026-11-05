# Recording a short demo video

A demo video is for flows and interactions a screenshot cannot show: a booking being made, a live feed updating. Keep it short, under a minute, and focused on one story.

## Record
Drive the real app with a Playwright script and let it record:

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "demo", size: { width: 1280, height: 720 } } });
const page = await context.newPage();
await page.goto("http://localhost:3000/panel");
await page.waitForTimeout(1000);
// ...click, type, wait for the result, pausing about a second between steps so a person can follow
await context.close();      // the video is written when the context closes
await browser.close();
```

Pause between steps; a demo that races is unreadable. End on the finished result.

## Convert and check
Playwright writes `.webm`. Convert to mp4 so it plays on phones:

```
ffmpeg -i demo/<file>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart booking-demo.mp4
```

Check the length and that the video is not blank (`ffprobe booking-demo.mp4`). The hub accepts files up to 200 MB; stay far below that.

## Upload
```
bun helper.ts upload KAPI-3 booking-demo.mp4 --kind video
```

Reference it in your outcome report. If ffmpeg or a browser is not available on your machine, say so in the report and use screenshots instead.
