// Record one demo segment: load HUD, hold Space (fake mic plays the wav), release, wait for reply.
// usage: node scripts/record-demo.js <wavPath> <outDir> <holdMs> <scrollAfterMs> <tailMs> [clickTranscript]
const { chromium } = require('playwright');

(async () => {
  const [wav, outDir, holdMs, scrollAfterMs, tailMs, clickTranscript] = process.argv.slice(2);
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1300,900',
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3107', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.keyboard.down('Space');
  await page.waitForTimeout(Number(holdMs));
  await page.keyboard.up('Space');
  await page.waitForTimeout(Number(scrollAfterMs));
  await page.evaluate(() => document.querySelector('.feed')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await page.waitForTimeout(Number(tailMs));
  if (clickTranscript === '1') {
    await page.getByText('Transcript', { exact: true }).click();
    await page.waitForTimeout(6000);
  }
  await ctx.close();
  await browser.close();
  console.log('done');
})();
