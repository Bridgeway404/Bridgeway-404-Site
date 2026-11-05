#!/usr/bin/env node
/*
 * Browser checks for the public Bridgeway 404 site (optional; needs Playwright).
 *
 *   python3 -m http.server 8080          # from the repo root, in another terminal
 *   node tools/e2e-check.js http://127.0.0.1:8080
 *
 * Submits every Netlify form with test data (the POST is intercepted locally —
 * nothing is sent to Netlify), and checks navigation, tabs, the call modal,
 * the mobile menu, legacy #quote links, consent mirroring and console errors.
 */
const { chromium, devices } = require('playwright');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label); } else { fails.push(label); console.log('  FAIL ', label); } };

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());   // offline-safe
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED/.test(m.text() + (m.location().url || ''))) page.errors.push(m.text()); });
  page.posts = [];
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      page.posts.push({ url: req.url(), body: new URLSearchParams(req.postData() || '') });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>posted</h1>' });
    }
    return route.continue();
  });
  return page;
}

async function fillForm(page, formSel, values) {
  for (const [name, val] of Object.entries(values)) {
    const el = page.locator(`${formSel} [name="${name}"]`).first();
    const tag = await el.evaluate(e => e.tagName.toLowerCase() + ':' + (e.type || ''));
    if (tag.startsWith('select')) await el.selectOption(val);
    else if (tag.endsWith('checkbox')) await page.locator(`${formSel} [name="${name}"][value="${val}"]`).check();
    else await el.fill(val);
  }
}

(async () => {
  const browser = await chromium.launch();

  console.log('\n[pages]');
  const page = await newPage(browser, { viewport: { width: 1366, height: 900 } });
  for (const p of ['/', '/services/', '/commercial/', '/service-saturdays/', '/about/', '/quote/', '/thank-you.html',
                   '/commercial/thank-you.html', '/service-saturdays/thank-you.html', '/privacy-policy.html']) {
    page.errors = [];
    const res = await page.goto(BASE + p);
    ok(res.status() === 200, `${p} loads`);
    const ld = await page.$$eval('script[type="application/ld+json"]', s => s.map(x => { try { JSON.parse(x.textContent); return true; } catch { return false; } }));
    ok(ld.every(Boolean), `${p} JSON-LD parses (${ld.length})`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    ok(!overflow, `${p} has no horizontal scroll`);
    ok(page.errors.length === 0, `${p} no JS errors ${page.errors.join(' | ')}`);
  }

  console.log('\n[navigation + call modal]');
  await page.goto(BASE + '/');
  await page.click('.site-nav a[href="/commercial/"]');
  ok(page.url().endsWith('/commercial/'), 'header nav reaches Commercial Partners');
  ok(await page.getAttribute('.site-nav a[href="/commercial/"]', 'aria-current') === 'page', 'current page marked in nav');
  await page.click('.header-call');
  ok(await page.isVisible('#call-modal .modal-card'), 'desktop Call opens the call modal');
  await page.keyboard.press('Escape');
  ok(!(await page.isVisible('#call-modal .modal-card')), 'Escape closes the call modal');

  console.log('\n[legacy links]');
  await page.goto(BASE + '/#quote');
  await page.waitForURL(/\/quote\/$/);
  ok(page.url().endsWith('/quote/'), 'old /#quote link forwards to /quote/');

  console.log('\n[quote form]');
  await page.goto(BASE + '/quote/?service=garage-cleanout');
  ok(await page.inputValue('#qr-service') === 'garage-cleanout', '?service= preselects the service');
  await page.click('#panel-removal button[type=submit]');
  ok(page.posts.length === 0, 'empty quote form is blocked by required fields');
  await fillForm(page, 'form[name="quote-request"]', {
    service_type: 'junk-removal', timing: 'this-week', items_detail: 'TEST — couch and 6 boxes',
    pickup_address: 'Decatur, GA', customer_name: 'Test Customer', phone: '404-555-0100', preferred_contact: 'text',
  });
  await page.check('form[name="quote-request"] [name="restricted_confirm"]');
  await page.check('form[name="quote-request"] [name="privacy_consent"]');
  await Promise.all([page.waitForURL(/thank-you\.html/), page.click('#panel-removal button[type=submit]')]);
  let post = page.posts.pop();
  ok(post && post.body.get('form-name') === 'quote-request', 'quote-request posts with form-name');
  ok(post && post.body.get('privacy_consent_granted') === 'Yes', 'privacy_consent_granted mirrors the checkbox (Yes)');
  ok(post && post.body.get('items_detail') === 'TEST — couch and 6 boxes', 'items_detail submitted');
  ok(post && /^NEW QUOTE REQUEST/.test(post.body.get('subject') || ''), 'quote-request carries its notification subject');
  ok(post && post.url.endsWith('/thank-you.html'), 'quote form posts to /thank-you.html');

  await page.goto(BASE + '/quote/');
  await page.selectOption('#qr-contact', 'email');
  ok(await page.$eval('#qr-email', e => e.required), 'email becomes required when "Email" is the contact method');

  console.log('\n[assembly form]');
  await page.goto(BASE + '/quote/#assembly');
  ok(await page.isVisible('#panel-assembly') && !(await page.isVisible('#panel-removal')), '#assembly opens the assembly tab');
  await fillForm(page, 'form[name="furniture-assembly-request"]', {
    assembly_item_type: 'TEST dresser', num_items: '1', timing: '2026-12-01', still_in_box: 'yes', has_instructions: 'yes',
    special_pieces: 'no', assembly_location: 'house', service_area: 'Atlanta', customer_name: 'Test', phone: '404-555-0101',
  });
  await page.check('form[name="furniture-assembly-request"] [name="privacy_consent"]');
  await Promise.all([page.waitForURL(/thank-you\.html/), page.click('#panel-assembly button[type=submit]')]);
  post = page.posts.pop();
  ok(post && post.body.get('form-name') === 'furniture-assembly-request', 'furniture-assembly-request posts');

  console.log('\n[commercial form]');
  await page.goto(BASE + '/commercial/');
  await fillForm(page, 'form[name="commercial-partner-inquiry"]', {
    company_name: 'TEST Property Co', business_type: 'property-management', contact_name: 'Test Manager',
    phone: '404-555-0102', email: 'test@example.com', service_locations: 'DeKalb County',
    anticipated_volume: 'monthly', timeline: 'within-30-days',
  });
  await page.check('form[name="commercial-partner-inquiry"] [value="Rental turnover cleanouts"]');
  await page.check('form[name="commercial-partner-inquiry"] [value="Storage unit cleanouts"]');
  await page.check('form[name="commercial-partner-inquiry"] [name="privacy_consent"]');
  await Promise.all([page.waitForURL(/commercial\/thank-you/), page.click('form[name="commercial-partner-inquiry"] button[type=submit]')]);
  post = page.posts.pop();
  ok(post && post.body.get('form-name') === 'commercial-partner-inquiry', 'commercial-partner-inquiry posts');
  ok(post && post.body.getAll('service_needs[]').length === 2, 'multiple service needs submitted');
  ok(post && /^NEW COMMERCIAL PARTNER INQUIRY/.test(post.body.get('subject') || ''), 'commercial inquiry email subject is labeled');

  await page.goto(BASE + '/commercial/');
  await page.click('#attorneys a[data-type]');
  ok(await page.inputValue('#cp-type') === 'eviction-attorney', 'attorney panel CTA preselects business type');
  await page.goto(BASE + '/commercial/?type=storage-facility');
  ok(await page.inputValue('#cp-type') === 'storage-facility', '?type= preselects business type');
  ok(await page.$('form[name="commercial-partner-inquiry"] [name="referral_source"]') !== null, 'commercial form asks how they heard about us');

  console.log('\n[service saturdays forms]');
  await page.goto(BASE + '/service-saturdays/');
  await fillForm(page, 'form[name="service-saturdays-nomination"]', {
    nominator_name: 'Test Nominator', nominator_phone: '404-555-0103', relationship: 'family',
    senior_name: 'Test', senior_area: '30311', senior_aware: 'yes-agrees', situation: 'TEST — garage is full',
  });
  await page.check('form[name="service-saturdays-nomination"] [name="privacy_consent"]');
  await page.click('form[name="service-saturdays-nomination"] button[type=submit]');
  ok(page.posts.length === 0, 'nomination requires the "not an appointment" acknowledgement');
  ok(await page.isVisible('text=How we protect nominee privacy'), 'nominee privacy notice shown beside the form');
  ok(await page.$('form[name="service-saturdays-nomination"] [name*="address" i], form[name="service-saturdays-nomination"] [name*="dob" i], form[name="service-saturdays-nomination"] [name*="age" i]') === null, 'nomination form collects no street address, birth date or age');
  await page.check('form[name="service-saturdays-nomination"] [name="nomination_acknowledgement"]');
  await Promise.all([page.waitForURL(/service-saturdays\/thank-you/), page.click('form[name="service-saturdays-nomination"] button[type=submit]')]);
  post = page.posts.pop();
  ok(post && post.body.get('form-name') === 'service-saturdays-nomination', 'service-saturdays-nomination posts');

  await page.goto(BASE + '/service-saturdays/');
  await fillForm(page, 'form[name="service-saturdays-community"]', { organization_name: 'TEST Church', contact_name: 'Test', email: 'test@example.com' });
  await page.check('form[name="service-saturdays-community"] [value="Volunteer"]');
  await page.check('form[name="service-saturdays-community"] [name="privacy_consent"]');
  await Promise.all([page.waitForURL(/service-saturdays\/thank-you/), page.click('form[name="service-saturdays-community"] button[type=submit]')]);
  post = page.posts.pop();
  ok(post && post.body.get('form-name') === 'service-saturdays-community', 'service-saturdays-community posts');

  console.log('\n[mobile]');
  const m = await newPage(browser, { ...devices['iPhone 13'] });
  await m.goto(BASE + '/');
  ok(await m.isVisible('.action-bar'), 'sticky Call / Text / Quote bar visible on phones');
  ok(await m.getAttribute('.action-bar a:first-child', 'href') === 'tel:+14045654216', 'action bar dials 404-565-4216');
  const visibleBar = await m.$$eval('.action-bar a', as => as.filter(a => a.offsetParent).map(a => a.getAttribute('href')));
  ok(visibleBar.length === 3 && visibleBar[1].startsWith('mailto:info@bridgeway404.com'), 'action bar shows Call / Email photos / Quote while texting is unconfirmed');
  for (const p of ['/', '/services/', '/quote/', '/thank-you.html', '/commercial/', '/service-saturdays/', '/about/']) {
    await m.goto(BASE + p);
    const visibleSms = await m.$$eval('a[href^="sms:"]', as => as.filter(a => a.offsetParent).length);
    ok(visibleSms === 0, `${p}: no visible text-message links (SMS switch off)`);
  }
  await m.goto(BASE + '/');
  await m.click('.menu-toggle');
  const menuOpen = await m.locator('#mobile-panel a[href="/service-saturdays/"]').waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false);
  ok(menuOpen, 'mobile menu opens');
  ok(await m.evaluate(() => document.getElementById('mobile-panel').offsetHeight > 400), 'mobile menu fills the screen (not clipped by the header)');
  ok(await m.getAttribute('.menu-toggle', 'aria-expanded') === 'true', 'menu button reports aria-expanded');
  await m.goto(BASE + '/commercial/');
  ok(await m.getAttribute('.action-bar a.primary', 'href') === '#partner-form', 'commercial page: sticky bar CTA goes to the partner form');
  await m.goto(BASE + '/quote/');
  const small = await m.$$eval('input:not([type=hidden]):not([type=checkbox]), select, textarea',
    els => els.filter(e => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).length);
  ok(small === 0, 'form fields are ≥16px on phones (prevents iOS zoom)');

  await browser.close();
  console.log(`\n${pass}/${pass + fails.length} browser checks passed`);
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
