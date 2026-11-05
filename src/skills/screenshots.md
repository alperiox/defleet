# Taking screenshots for a task

Screenshots let the human judge a visual result in seconds. Take them of the real running thing, not of code.

## Capture
With Playwright (no setup beyond `npx`):

```
npx playwright screenshot --viewport-size=1280,800 --wait-for-timeout=800 http://localhost:3000/panel panel-desktop.png
npx playwright screenshot --viewport-size=400,800 http://localhost:3000/panel panel-phone.png
npx playwright screenshot --color-scheme=dark --viewport-size=1280,800 http://localhost:3000/panel panel-dark.png
```

Add `--full-page` when the page scrolls and the bottom matters. For states that need clicking or data, write a short Playwright script that gets the page into that state and calls `page.screenshot({ path })`.

## What to capture
- The main screen at desktop width and at phone width (400 px). Add dark mode if the interface supports it.
- Every state the task is about: empty, filled, error, the new feature in use.
- Look at each image before uploading. If it is blank, cut off, or shows an error page, fix that first.

## Name and upload
Name files for what they show (`booking-confirmed-phone.png`, not `shot1.png`). Upload each to the task:

```
bun helper.ts upload KAPI-3 booking-confirmed-phone.png --kind screenshot
```

Mention the file names in your outcome report. Never include secrets, tokens or personal data in a screenshot.
