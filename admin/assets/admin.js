/* Bridgeway Admin — shared client. Requires supabase.js + config.js first. */
(function () {
  'use strict';

  window.BW = {};

  BW.sb = window.supabase.createClient(BW_CONFIG.supabaseUrl, BW_CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  BW.TYPE_LABELS = {
    property_management: 'Property Management Company',
    multifamily_operator: 'Multifamily / Apartment Operator',
    sfr_operator: 'Single-Family Rental Operator',
    vendor_network: 'Third-Party Maintenance / Vendor Network',
    reo_field_services: 'REO / Field Services'
  };

  // Vendor-partnership onboarding workflow. NULL/blank = ordinary outbound lead.
  BW.APP_STATUSES = ['Apply First', 'Application Needed', 'Application Started',
    'Application Submitted', 'Vendor Contact Needed', 'Follow-Up',
    'Approved Vendor', 'Not a Fit'];

  BW.OUTCOME_LABELS = {
    no_answer: 'No Answer',
    left_voicemail: 'Left Voicemail',
    spoke_connected: 'Spoke / Connected',
    done: 'Done',
    note: 'Note'
  };

  // How each outreach_log row reads in an activity history / list, where a
  // call outcome and a team note sit side by side.
  BW.ACTIVITY_LABELS = {
    no_answer: 'Call — No Answer',
    left_voicemail: 'Call — Left Voicemail',
    spoke_connected: 'Spoke / Connected',
    done: 'Done',
    note: 'Note'
  };

  BW.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  BW.telHref = function (phone) {
    return 'tel:' + String(phone).replace(/[^0-9+]/g, '');
  };

  BW.host = function (url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return url; }
  };

  BW.fmtDate = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  BW.fmtDateTime = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  BW.getSession = async function () {
    var res = await BW.sb.auth.getSession();
    return res.data.session || null;
  };

  // Gate for inner admin pages: must be signed in AND on the admin allowlist.
  // Redirects to the login page otherwise. Returns { session, me } or null.
  BW.requireAdmin = async function () {
    var session = await BW.getSession();
    if (!session) { location.replace('/admin/'); return null; }
    var res = await BW.sb.from('admin_users')
      .select('user_id, email, display_name')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (res.error || !res.data) { location.replace('/admin/?denied=1'); return null; }
    return { session: session, me: res.data };
  };

  BW.signOut = async function () {
    try { await BW.sb.auth.signOut(); } catch (e) { /* session may already be gone */ }
    location.replace('/admin/');
  };

  // Minimal RFC-4180 CSV parser: quoted fields, embedded commas/newlines, CRLF.
  BW.parseCSV = function (text) {
    var rows = [], row = [], field = '', inQuotes = false, i = 0;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    while (i < text.length) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    row.push(field);
    rows.push(row);
    // Drop trailing fully-empty rows
    while (rows.length && rows[rows.length - 1].every(function (f) { return f.trim() === ''; })) {
      rows.pop();
    }
    return rows;
  };
})();
