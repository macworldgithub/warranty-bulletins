import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = here;
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('../../tools/workphotos-archive/node_modules/playwright')); }

const portal = 'https://portal.mmal.com.au/irj/portal?NavigationTarget=navurl%3A%2F%2F70f256b0389074c74c1a39c9fcdf9746&PrevNavTarget=navurl%3A%2F%2F70f256b0389074c74c1a39c9fcdf9746&NavMode=10&CurrentWindowId=WID1793222277027';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeName = value => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 170) || 'document.pdf';
const isPdf = bytes => bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
const manifestPath = path.join(output, 'manifest.json');
await mkdir(output, { recursive: true });
let records = [];
try { records = JSON.parse(await readFile(manifestPath, 'utf8')).bulletins || []; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const saveManifest = async extra => {
  await writeFile(`${manifestPath}.tmp`, JSON.stringify({ manufacturer: 'Mitsubishi', updatedAt: new Date().toISOString(), ...extra, bulletins: records }, null, 2));
  await rename(`${manifestPath}.tmp`, manifestPath);
};
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: null });
context.setDefaultTimeout(15000);
let page = await context.newPage();
const statusPath = path.join(output, 'status.json');
async function status(stage) {
  const pages = context.pages().filter(p => !p.isClosed());
  await writeFile(statusPath, JSON.stringify({ stage, time: new Date().toISOString(), pages: pages.map(p => ({ url: p.url(), frames: p.frames().map(f => f.url()) })) }, null, 2));
}
try {
  await page.goto(portal, { waitUntil: 'domcontentloaded', timeout: 90000 });
} catch (error) {
  console.log(`Initial navigation needs manual attention: ${error.message.split('\n')[0]}`);
  console.log('In the new Chrome window, open/reload the Mitsubishi portal and complete sign-in manually. The downloader will keep waiting.');
}
console.log(`\nSave location: ${output}\nSign in MANUALLY in the new Chrome window. The downloader will continue automatically.\nDo not close this browser until the download finishes. Passwords and sessions are not written to disk.\n`);

async function findFrame(selector, timeout = 900000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && context.pages().length) {
    for (const candidate of context.pages()) for (const frame of candidate.frames()) {
      try { if (await frame.locator(selector).count()) { page = candidate; return frame; } } catch {}
    }
    await wait(1200);
  }
  throw new Error(`Timed out waiting for portal screen (${selector}). Sign in and open TESS, then rerun.`);
}

async function openSearch() {
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline && context.pages().length) {
    await status('Waiting for signed-in TESS screen');
    for (const candidate of context.pages()) for (const frame of candidate.frames()) {
      try {
        if (await frame.locator('#bokList-listUl').count()) { page = candidate; return frame; }
        const tess = frame.getByText('TESS & Workshop Manuals', { exact: true });
        if (await tess.count() && await tess.first().isVisible()) {
          await tess.first().click();
          console.log('Opened TESS; waiting for document search.');
          return await findFrame('#bokList-listUl', 60000);
        }
      } catch (error) { console.log(`Portal detection retry: ${error.message.split('\n')[0]}`); }
    }
    await wait(1500);
  }
  throw new Error('No TESS screen found. Sign in and open TESS & Workshop Manuals.');
}

async function loadAll(frame) {
  let last = -1;
  for (let batch = 0; batch < 500; batch++) {
    const rows = frame.locator('#bokList-listUl tr.sapMListTblRow');
    const count = await rows.count();
    const more = frame.locator('#bokList-trigger');
    if (!(await more.count()) || !(await more.isVisible())) return;
    if (count === last) throw new Error('The More button did not add rows; stopping rather than claiming a complete export.');
    last = count;
    console.log(`Loading document list: ${count} rows…`);
    await more.click();
    await rows.nth(count).waitFor({ state: 'attached', timeout: 45000 }).catch(async () => {
      if (await more.isVisible()) throw new Error('Loading more results timed out.');
    });
    await wait(700);
  }
  throw new Error('Document pagination limit reached; export is incomplete.');
}

async function listEntries(frame) {
  // SAP renders its result rows after the search response and busy overlay clear.
  await wait(3000);
  await loadAll(frame);
  const result = [];
  for (const row of await frame.locator('#bokList-listUl tr.sapMListTblRow').all()) {
    const title = (await row.locator('.sapMObjectIdentifierTitle').first().innerText().catch(() => '')).trim();
    const sourcePath = (await row.locator('.sapMObjectIdentifierText').first().textContent().catch(() => '') || '').trim();
    const text = await row.innerText();
    if (title && sourcePath.startsWith('/documents/')) result.push({ title, sourcePath, listText: text });
  }
  return [...new Map(result.map(entry => [entry.sourcePath, entry])).values()];
}

async function downloadPdf(url, title) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['portal.mmal.com.au', 'mmaldp5.mmal.com.au'].includes(parsed.hostname)) throw new Error('Unexpected document host; review this link manually.');
  const file = safeName(decodeURIComponent(parsed.pathname.split('/').pop() || `${title}.pdf`));
  const destination = path.join(output, file);
  // Existing PDF files are reused only when this same URL was recorded previously.
  const previouslySaved = records.flatMap(r => r.files || []).find(f => f.url === url && f.file === file);
  if (previouslySaved) {
    try { const bytes = await readFile(destination); if (isPdf(bytes) && bytes.length === previouslySaved.bytes) return { ...previouslySaved, skipped: true }; } catch {}
  }
  let name = file;
  try {
    await access(destination);
    // Never overwrite unrelated files with the same filename.
    const { createHash } = await import('node:crypto');
    name = file.replace(/\.pdf$/i, '') + '-' + createHash('sha256').update(url).digest('hex').slice(0, 10) + '.pdf';
  } catch {}
  const response = await context.request.get(url, { timeout: 90000 });
  if (!response.ok()) throw new Error(`Document request returned HTTP ${response.status()}`);
  const bytes = await response.body();
  if (!isPdf(bytes)) throw new Error('Response is not a PDF (possibly a login page). No invalid file was saved.');
  await writeFile(path.join(output, `${name}.part`), bytes);
  await rename(path.join(output, `${name}.part`), path.join(output, name));
  console.log(`  Saved ${name} (${bytes.length} bytes)`);
  return { file: name, url, bytes: bytes.length, downloadedAt: new Date().toISOString() };
}

try {
  let frame = await openSearch();
  // Always run our own search: the user may have left a single-document filter active.
  await frame.getByRole('button', { name: 'Clear', exact: true }).click();
  await frame.getByRole('checkbox', { name: 'Free Text', exact: true }).check();
  await frame.locator('#BoxForBok0-inner').fill('warranty');
  await frame.locator('#BoxForBok0-inner').press('Tab');
  await frame.getByRole('button', { name: 'Search Knowledge Management', exact: true }).click();
  await wait(5000);
  await frame.locator('#bokList-listUl tr.sapMListTblRow').first().waitFor({ timeout: 60000 });
  let entries = await listEntries(frame);
  let searchScope = 'Published documents matching warranty (filters cleared by downloader)';
  if (!entries.length) {
    // Ask the portal for unfiltered published documents; no hidden endpoints are used.
    await frame.getByRole('button', { name: 'Clear', exact: true }).click();
    await frame.getByRole('button', { name: 'Search Knowledge Management', exact: true }).click();
    await frame.locator('#bokList-listUl tr.sapMListTblRow').first().waitFor({ timeout: 45000 }).catch(() => {});
    entries = await listEntries(frame);
    searchScope = 'Unfiltered published document search';
  }
  if (!entries.length) {
    console.log('Unfiltered search returned no results; searching for warranty bulletins.');
    const checkbox = frame.getByRole('checkbox', { name: 'Free Text', exact: true });
    await checkbox.check();
    await frame.locator('#BoxForBok0-inner').fill('warranty');
    await frame.locator('#BoxForBok0-inner').press('Tab');
    await frame.getByRole('button', { name: 'Search Knowledge Management', exact: true }).click();
    await frame.locator('#bokList-listUl tr.sapMListTblRow').first().waitFor({ timeout: 45000 });
    entries = await listEntries(frame);
    searchScope = 'Published documents matching warranty';
  }
  if (!entries.length) throw new Error('No documents returned. Run the desired search in TESS and restart.');
  console.log(`Found ${entries.length} documents. Downloading attachments from each detail page.`);
  await saveManifest({ searchScope, listedDocuments: entries.length, complete: false });
  let failures = 0;
  for (const [index, entry] of entries.entries()) {
    console.log(`[${index + 1}/${entries.length}] ${entry.title}`);
    const record = { ...entry, checkedAt: new Date().toISOString(), files: [] };
    try {
      frame = await findFrame('#bokList-listUl', 60000);
      let row = frame.locator('#bokList-listUl tr.sapMListTblRow').filter({ has: frame.locator('.sapMObjectIdentifierText').filter({ hasText: entry.sourcePath }) });
      if (!(await row.count())) { await loadAll(frame); }
      if (await row.count() !== 1) throw new Error('Cannot uniquely locate this document in results.');
      await row.click();
      await frame.getByRole('heading', { name: 'Search Detail', exact: true }).waitFor({ timeout: 45000 });
      record.detailText = await frame.getByRole('main').innerText();
      await frame.locator('a[href*=".pdf"]').first().waitFor({ state: 'attached', timeout: 45000 });
      const links = await frame.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, url: node.href })).filter(link => /\.pdf(?:$|[?#])/i.test(link.url)));
      if (!links.length) throw new Error('No PDF attachments found on this detail page.');
      for (const link of [...new Map(links.map(link => [link.url, link])).values()]) {
        try { record.files.push(await downloadPdf(link.url, link.text)); }
        catch (error) { record.files.push({ url: link.url, error: error.message }); failures++; }
        await wait(800);
      }
    } catch (error) { record.error = error.message; failures++; console.error(`  Failed: ${error.message}`); }
    const oldIndex = records.findIndex(r => r.sourcePath === entry.sourcePath);
    if (oldIndex >= 0) records[oldIndex] = record; else records.push(record);
    await saveManifest({ searchScope, listedDocuments: entries.length, complete: false });
    const back = frame.getByRole('button', { name: 'Back', exact: true });
    if (await back.count() && await back.first().isVisible()) {
      await back.first().click();
      await frame.locator('#bokList-listUl').waitFor({ timeout: 45000 });
    }
    await wait(900);
  }
  await saveManifest({ searchScope, listedDocuments: entries.length, complete: failures === 0, failures });
  console.log(`\nFinished: ${failures} failures. Files and manifest: ${output}\nNo documents were uploaded or published to the Warranty app.`);
} catch (error) {
  console.error(`\nStopped: ${error.message}\nDownloaded files are preserved. Rerun to resume.`);
  await saveManifest({ complete: false, error: error.message });
  process.exitCode = 1;
} finally {
  await browser.close();
}
