/* Bridgeway Admin — shared prospect editor modal.
   Requires admin.js first. Injects the modal markup once and exposes
   BW.editor.open(prospectRow | null) / BW.editor.close() / BW.editor.onChange(fn).
   Used by the Prospects and Follow-Ups pages so there is exactly one place a
   prospect's fields, team notes, and activity history are edited. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var editing = null; // prospect row being edited, or null for "add new"
  var changeHandler = null;

  var ED_FIELDS = ['company_name', 'prospect_type', 'priority', 'application_status', 'why_bridgeway', 'website',
    'primary_geography', 'metro_atlanta_relevance', 'portfolio_summary', 'contact_name',
    'contact_title', 'contact_phone', 'contact_email', 'vendor_registration_url',
    'general_contact_url', 'vendor_notes', 'last_verified_date'];

  var MODAL_HTML =
    '<div class="modal-back hidden" id="editor-back">' +
    '  <div class="modal">' +
    '    <div style="display:flex;align-items:center;margin-bottom:.6rem">' +
    '      <h2 id="ed-title" style="margin:0">Edit prospect</h2>' +
    '      <button class="btn-quiet" style="margin-left:auto" id="ed-close">Close</button>' +
    '    </div>' +
    '    <form id="ed-form">' +
    '      <div class="field"><label class="label" for="ed-company_name">Company name *</label><input id="ed-company_name" type="text" required></div>' +
    '      <div class="grid2">' +
    '        <div class="field">' +
    '          <label class="label" for="ed-prospect_type">Type *</label>' +
    '          <select id="ed-prospect_type" required>' +
    '            <option value="property_management">Property Management Company</option>' +
    '            <option value="multifamily_operator">Multifamily / Apartment Operator</option>' +
    '            <option value="sfr_operator">Single-Family Rental Operator</option>' +
    '            <option value="vendor_network">Third-Party Maintenance / Vendor Network</option>' +
    '            <option value="reo_field_services">REO / Field Services</option>' +
    '          </select>' +
    '        </div>' +
    '        <div class="field">' +
    '          <label class="label" for="ed-priority">Priority (1 best &ndash; 5)</label>' +
    '          <select id="ed-priority">' +
    '            <option value="0">0 &mdash; Apply First</option>' +
    '            <option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option>' +
    '          </select>' +
    '        </div>' +
    '      </div>' +
    '      <div class="field">' +
    '        <label class="label" for="ed-application_status">Vendor partnership status</label>' +
    '        <select id="ed-application_status">' +
    '          <option value="">Not a partnership target</option>' +
    '          <option>Apply First</option>' +
    '          <option>Application Needed</option>' +
    '          <option>Application Started</option>' +
    '          <option>Application Submitted</option>' +
    '          <option>Vendor Contact Needed</option>' +
    '          <option>Follow-Up</option>' +
    '          <option>Approved Vendor</option>' +
    '          <option>Not a Fit</option>' +
    '        </select>' +
    '      </div>' +
    '      <div class="field"><label class="label" for="ed-why_bridgeway">Why Bridgeway wants this account</label><textarea id="ed-why_bridgeway"></textarea></div>' +
    '      <div class="grid2">' +
    '        <div class="field"><label class="label" for="ed-website">Website</label><input id="ed-website" type="url"></div>' +
    '        <div class="field"><label class="label" for="ed-primary_geography">Primary geography</label><input id="ed-primary_geography" type="text"></div>' +
    '      </div>' +
    '      <div class="field"><label class="label" for="ed-metro_atlanta_relevance">Metro Atlanta relevance</label><input id="ed-metro_atlanta_relevance" type="text"></div>' +
    '      <div class="field"><label class="label" for="ed-portfolio_summary">Portfolio / footprint</label><input id="ed-portfolio_summary" type="text"></div>' +
    '      <div class="grid2">' +
    '        <div class="field"><label class="label" for="ed-contact_name">Contact name</label><input id="ed-contact_name" type="text"></div>' +
    '        <div class="field"><label class="label" for="ed-contact_title">Contact title</label><input id="ed-contact_title" type="text"></div>' +
    '      </div>' +
    '      <div class="grid2">' +
    '        <div class="field"><label class="label" for="ed-contact_phone">Phone</label><input id="ed-contact_phone" type="tel"></div>' +
    '        <div class="field"><label class="label" for="ed-contact_email">Email</label><input id="ed-contact_email" type="email"></div>' +
    '      </div>' +
    '      <div class="field"><label class="label" for="ed-vendor_registration_url">Vendor registration URL</label><input id="ed-vendor_registration_url" type="url"></div>' +
    '      <div class="field"><label class="label" for="ed-general_contact_url">General contact URL</label><input id="ed-general_contact_url" type="url"></div>' +
    '      <div class="field"><label class="label" for="ed-vendor_notes">Vendor / onboarding notes (research)</label><textarea id="ed-vendor_notes"></textarea>' +
    '        <p class="muted small" style="margin:.3rem 0 0">Reference information from research or CSV import. It does not count as activity &mdash; use Team notes below for anything you did or learned.</p></div>' +
    '      <div class="field"><label class="label" for="ed-last_verified_date">Last verified</label><input id="ed-last_verified_date" type="date"></div>' +
    '      <div id="ed-msg"></div>' +
    '      <div style="display:flex;gap:.5rem;flex-wrap:wrap">' +
    '        <button type="submit" class="btn-primary">Save</button>' +
    '        <button type="button" class="btn-done hidden" id="ed-done-btn">Mark Done</button>' +
    '        <button type="button" class="btn-secondary hidden" id="ed-reactivate-btn">Reactivate</button>' +
    '      </div>' +
    '    </form>' +
    '    <div id="ed-history-wrap" class="hidden" style="margin-top:1rem">' +
    '      <p class="label">Team notes &amp; activity</p>' +
    '      <div class="field" style="margin-bottom:.5rem">' +
    '        <textarea id="ed-new-note" placeholder="e.g. Called property manager. Receptionist gave me Ashley&#39;s direct number. Try again Monday."></textarea>' +
    '      </div>' +
    '      <div id="ed-note-msg"></div>' +
    '      <button type="button" class="btn-secondary" id="ed-note-save">Save note</button>' +
    '      <p class="muted small" style="margin:.4rem 0 0">Saved to the activity history with your name and the time, and counts as activity on the Follow-Ups list. A note does not change when the company comes back in the Blitz.</p>' +
    '      <div id="ed-history" style="margin-top:.6rem"></div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  function changed() {
    closeEditor();
    if (changeHandler) changeHandler();
  }

  function openEditor(p) {
    editing = p;
    $('ed-title').textContent = p ? 'Edit prospect' : 'Add prospect';
    $('ed-msg').innerHTML = '';
    ED_FIELDS.forEach(function (f) {
      $('ed-' + f).value = p && p[f] != null ? p[f] : (f === 'priority' ? '3' : '');
    });
    $('ed-done-btn').classList.toggle('hidden', !p || p.status !== 'active');
    $('ed-reactivate-btn').classList.toggle('hidden', !p || p.status !== 'done');
    $('ed-history-wrap').classList.toggle('hidden', !p);
    $('ed-history').innerHTML = '';
    $('ed-new-note').value = '';
    $('ed-note-msg').innerHTML = '';
    $('editor-back').classList.remove('hidden');
    if (p) loadHistory(p.id);
  }

  async function loadHistory(id) {
    var res = await BW.sb.from('outreach_history').select('*')
      .eq('prospect_id', id).order('created_at', { ascending: false }).limit(25);
    if (res.error || !res.data) return;
    if (!res.data.length) {
      $('ed-history').innerHTML = '<p class="muted small" style="margin:0">No activity yet.</p>';
      return;
    }
    $('ed-history').innerHTML = res.data.map(function (h) {
      return '<div class="history-item"><strong>' +
        BW.esc(BW.ACTIVITY_LABELS[h.outcome] || h.outcome) + '</strong> &middot; ' +
        BW.esc(h.display_name) + ' &middot; ' + BW.esc(BW.fmtDateTime(h.created_at)) +
        (h.note ? '<br><span class="muted">' + BW.esc(h.note) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  function closeEditor() { $('editor-back').classList.add('hidden'); editing = null; }

  function mount() {
    if ($('editor-back')) return;
    var holder = document.createElement('div');
    holder.innerHTML = MODAL_HTML;
    document.body.appendChild(holder.firstElementChild);

    $('ed-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var vals = {};
      ED_FIELDS.forEach(function (f) {
        var v = $('ed-' + f).value.trim();
        if (f === 'priority') vals[f] = parseInt(v || '3', 10);
        else vals[f] = v === '' ? null : v;
      });
      var res;
      if (editing) {
        res = await BW.sb.from('prospects').update(vals).eq('id', editing.id);
      } else {
        res = await BW.sb.from('prospects').insert(vals);
      }
      if (res.error) {
        var msg = /company_key/.test(res.error.message)
          ? 'A prospect with this company name already exists.' : res.error.message;
        $('ed-msg').innerHTML = '<div class="alert-error">' + BW.esc(msg) + '</div>';
        return;
      }
      changed();
    });

    $('ed-done-btn').addEventListener('click', async function () {
      if (!editing) return;
      var res = await BW.sb.rpc('log_outcome', { p_prospect_id: editing.id, p_outcome: 'done', p_note: null });
      if (res.error) {
        $('ed-msg').innerHTML = '<div class="alert-error">' + BW.esc(res.error.message) + '</div>';
        return;
      }
      changed();
    });

    $('ed-reactivate-btn').addEventListener('click', async function () {
      if (!editing) return;
      var res = await BW.sb.from('prospects')
        .update({ status: 'active', next_due_at: new Date().toISOString(), done_at: null, done_by: null })
        .eq('id', editing.id);
      if (res.error) {
        $('ed-msg').innerHTML = '<div class="alert-error">' + BW.esc(res.error.message) + '</div>';
        return;
      }
      changed();
    });

    // Team note: a dated, attributed activity record that is not a call outcome.
    $('ed-note-save').addEventListener('click', async function () {
      if (!editing) return;
      var btn = this;
      var text = $('ed-new-note').value.trim();
      $('ed-note-msg').innerHTML = '';
      if (!text) {
        $('ed-note-msg').innerHTML = '<div class="alert-error">Type a note first.</div>';
        return;
      }
      btn.disabled = true;
      var res = await BW.sb.rpc('add_prospect_note', { p_prospect_id: editing.id, p_note: text });
      btn.disabled = false;
      if (res.error) {
        $('ed-note-msg').innerHTML = '<div class="alert-error">' + BW.esc(res.error.message) + '</div>';
        return;
      }
      $('ed-new-note').value = '';
      $('ed-note-msg').innerHTML = '<div class="alert-ok">Note saved.</div>';
      await loadHistory(editing.id);
      if (changeHandler) changeHandler();
    });

    $('ed-close').addEventListener('click', closeEditor);
    $('editor-back').addEventListener('click', function (e) { if (e.target === this) closeEditor(); });
  }

  mount();

  BW.editor = {
    open: openEditor,
    close: closeEditor,
    onChange: function (fn) { changeHandler = fn; }
  };
})();
