/* Bridgeway Admin — Meta/Instagram connections.zip import engine.
 *
 * Parses a Meta "connections" HTML export entirely in the browser (no
 * third-party libraries, no server upload of raw data) and produces
 * normalized person records with provenance-tagged relationship signals.
 *
 * Works in the browser (window.BWMeta) and in Node 18+ (module.exports)
 * so the parser has automated tests (tools/test-meta-import.mjs).
 *
 * Privacy: raw export bytes never leave the browser. Only the normalized,
 * minimal person records are sent to the admin-only database.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BWMeta = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------
  // Minimal ZIP reader: central-directory parse; supports method 0
  // (stored) and method 8 (deflate, via native DecompressionStream).
  // ---------------------------------------------------------------

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Returns [{ name, bytes }] for every file entry in the archive.
  async function readZip(arrayBuffer) {
    var b = new Uint8Array(arrayBuffer);
    if (b.length < 22) throw new Error('Not a ZIP file (too small).');

    // Find End Of Central Directory record (scan back over the comment).
    var eocd = -1;
    var min = Math.max(0, b.length - 22 - 65535);
    for (var i = b.length - 22; i >= min; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no central directory found).');

    var count = u16(b, eocd + 10);
    var cdOffset = u32(b, eocd + 16);
    var out = [];
    var p = cdOffset;
    var td = new TextDecoder('utf-8');

    for (var n = 0; n < count; n++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) {
        throw new Error('Corrupt ZIP: bad central directory entry.');
      }
      var method = u16(b, p + 10);
      var compSize = u32(b, p + 20);
      var nameLen = u16(b, p + 28);
      var extraLen = u16(b, p + 30);
      var commentLen = u16(b, p + 32);
      var localOffset = u32(b, p + 42);
      var name = td.decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue;                    // directory
      if (name.indexOf('__MACOSX') !== -1) continue;       // macOS cruft

      // Local header: name/extra lengths can differ from central directory.
      if (localOffset + 30 > b.length || u32(b, localOffset) !== 0x04034b50) {
        throw new Error('Corrupt ZIP: bad local header for ' + name);
      }
      var lNameLen = u16(b, localOffset + 26);
      var lExtraLen = u16(b, localOffset + 28);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var raw = b.subarray(dataStart, dataStart + compSize);

      var bytes;
      if (method === 0) bytes = raw;
      else if (method === 8) bytes = await inflateRaw(raw);
      else throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name);
      out.push({ name: name, bytes: bytes });
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Meta HTML parsers (regex-based; the export markup is machine-
  // generated and stable within a format generation).
  // ---------------------------------------------------------------

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); });
  }
  function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).trim(); }

  // followers_1.html / following.html / blocked etc.:
  // <div class="pam ..."><h2>username</h2>...<a href="https://www.instagram.com/...">...</a><div>date</div>
  function parseLinkList(html) {
    var out = [];
    var re = /<div class="pam[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var block = m[0];
      var a = /<a[^>]+href="(https:\/\/www\.instagram\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!a) continue;
      var url = decodeEntities(a[1]);
      var username = url.replace(/\/+$/, '').split('/').pop();
      var h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(block);
      var label = stripTags(h2 ? h2[1] : a[2]);
      if (/^https:\/\//.test(label)) label = username;
      var dt = /<div>([A-Z][a-z]{2} \d{1,2}, \d{4}[^<]*)<\/div>/.exec(block);
      out.push({
        username: username,
        url: 'https://www.instagram.com/' + username,
        label: label,
        timestamp: dt ? dt[1].trim() : null
      });
    }
    return out;
  }

  // pending/recent follow requests: <table><tr><td>Name</td><td>X</td></tr><tr><td>Username</td><td>y</td>...
  function parseNameTableList(html) {
    var out = [];
    var re = /<table[^>]*>([\s\S]*?)<\/table>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var fields = {};
      var rowRe = /<tr><td[^>]*>([^<]+)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g;
      var r;
      while ((r = rowRe.exec(m[1])) !== null) {
        fields[r[1].trim().toLowerCase()] = stripTags(r[2]);
      }
      if (fields.username) {
        out.push({
          username: fields.username,
          url: 'https://www.instagram.com/' + fields.username,
          label: fields.name || '',
          timestamp: null
        });
      }
    }
    return out;
  }

  // synced_contacts.html: <td ...>First Name<div><div>X</div></div></td> ...
  function parseContacts(html) {
    var out = [];
    var re = /<table[^>]*>([\s\S]*?)<\/table>/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var rec = {};
      var fRe = /class="_2pin _a6_q">([^<]+)<div><div>([\s\S]*?)<\/div><\/div>/g;
      var f;
      while ((f = fRe.exec(m[1])) !== null) {
        rec[f[1].trim()] = stripTags(f[2]);
      }
      if (Object.keys(rec).length) {
        out.push({
          first_name: (rec['First Name'] || '').trim(),
          last_name: (rec['Last Name'] || '').trim(),
          contact_info: (rec['Contact Information'] || '').trim()
        });
      }
    }
    return out;
  }

  // Map export paths -> logical dataset names.
  var FILE_MAP = [
    { match: /followers(_\d+)?\.html$/, key: 'followers', parser: parseLinkList },
    { match: /\/following\.html$/, key: 'following', parser: parseLinkList },
    { match: /blocked_profiles\.html$/, key: 'blocked', parser: parseLinkList },
    { match: /recently_unfollowed_profiles\.html$/, key: 'recently_unfollowed', parser: parseLinkList },
    { match: /pending_follow_requests\.html$/, key: 'pending_requests', parser: parseNameTableList },
    { match: /recent_follow_requests\.html$/, key: 'recent_requests', parser: parseNameTableList },
    { match: /follow_requests_you.*received\.html$/, key: 'requests_received', parser: parseNameTableList },
    { match: /synced_contacts\.html$/, key: 'contacts', parser: parseContacts }
  ];

  function parseExportFiles(files) {
    var data = { followers: [], following: [], blocked: [], recently_unfollowed: [],
                 pending_requests: [], recent_requests: [], requests_received: [], contacts: [] };
    var matched = 0;
    var td = new TextDecoder('utf-8');
    files.forEach(function (f) {
      for (var i = 0; i < FILE_MAP.length; i++) {
        if (FILE_MAP[i].match.test(f.name)) {
          var html = typeof f.bytes === 'string' ? f.bytes : td.decode(f.bytes);
          var rows = FILE_MAP[i].parser(html);
          // Meta varies list markup between generations; if the primary
          // parser finds nothing, try the alternate list format.
          if (!rows.length && FILE_MAP[i].parser !== parseContacts) {
            rows = (FILE_MAP[i].parser === parseLinkList ? parseNameTableList : parseLinkList)(html);
          }
          data[FILE_MAP[i].key] = data[FILE_MAP[i].key].concat(rows);
          matched++;
          break;
        }
      }
    });
    if (!matched) {
      throw new Error('No Meta connections files recognized in this ZIP. ' +
        'Expected followers/following/synced_contacts HTML exports.');
    }
    return data;
  }

  // ---------------------------------------------------------------
  // Normalization + conservative entity resolution.
  // ---------------------------------------------------------------

  function norm(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  var SIGNAL_STRENGTH = {
    mutual_follow: 3,
    follower_only: 2,
    following_only: 1,
    synced_contact: 2,       // high-confidence contact match / contact-only person
    synced_contact_weak: 1,  // medium-confidence username<->name match
    pending_request_sent: 1,
    recent_request_sent: 1,
    request_received: 0,
    recently_unfollowed: -1
  };

  // Conservative username <-> contact-name match.
  // 3 = username is exactly the full name; 2 = both name parts appear.
  function usernameNameMatchScore(username, first, last) {
    var uv = norm(username).replace(/\d+$/, '');
    var fn = norm(first), ln = norm(last);
    if (!fn) return 0;
    var full = fn + ln, rev = ln + fn;
    if (full.length >= 6 && (uv === full || uv === rev)) return 3;
    if (ln && fn.length >= 3 && ln.length >= 3 && uv.indexOf(fn) !== -1 && uv.indexOf(ln) !== -1) return 2;
    if (ln && full.length >= 8 && uv.indexOf(full) !== -1) return 2;
    return 0;
  }

  // Build normalized people with signals from a parsed export.
  function normalizePeople(data) {
    var people = {};  // person_key -> person

    function igPerson(username) {
      var key = 'ig:' + username;
      if (!people[key]) {
        people[key] = {
          person_key: key,
          ig_username: username,
          ig_url: 'https://www.instagram.com/' + username,
          display_name: null, first_name: null, last_name: null,
          phone: null, email: null,
          identity_confidence: 'confirmed',  // single-source identity, no merge inference
          signals: []
        };
      }
      return people[key];
    }
    function addSignal(p, source, type, evidence) {
      p.signals.push({
        source: source, signal_type: type,
        strength: SIGNAL_STRENGTH[type] || 0,
        evidence: evidence || null
      });
    }

    var followerSet = {};
    data.followers.forEach(function (r) { followerSet[r.username] = r; });
    var followingSet = {};
    data.following.forEach(function (r) { followingSet[r.username] = r; });

    Object.keys(followingSet).forEach(function (u) {
      var p = igPerson(u);
      if (followerSet[u]) {
        addSignal(p, 'instagram', 'mutual_follow',
          'Follows Michael and Michael follows back (' + (followingSet[u].timestamp || 'date unknown') + ')');
      } else {
        addSignal(p, 'instagram', 'following_only',
          'Michael follows them (' + (followingSet[u].timestamp || 'date unknown') + ')');
      }
    });
    Object.keys(followerSet).forEach(function (u) {
      if (followingSet[u]) return; // mutual already recorded
      var p = igPerson(u);
      addSignal(p, 'instagram', 'follower_only',
        'They follow Michael (' + (followerSet[u].timestamp || 'date unknown') + ')');
    });

    [['pending_requests', 'pending_request_sent', 'Michael sent a follow request (unanswered)'],
     ['recent_requests', 'recent_request_sent', 'Michael recently sent a follow request'],
     ['requests_received', 'request_received', 'They requested to follow Michael'],
     ['recently_unfollowed', 'recently_unfollowed', 'Michael recently unfollowed them']
    ].forEach(function (spec) {
      (data[spec[0]] || []).forEach(function (r) {
        var p = igPerson(r.username);
        if (r.label && !p.display_name && r.label !== r.username) p.display_name = r.label;
        addSignal(p, 'instagram', spec[1], spec[2]);
      });
    });

    // Dedupe contacts: same normalized name + same last-10 phone digits = one row.
    var contactsByName = {};  // normkey -> {first, last, phones:[], emails:[]}
    (data.contacts || []).forEach(function (c) {
      var fn = (c.first_name || '').trim(), ln = (c.last_name || '').trim();
      if (!fn && !ln) return;
      var nk = norm(fn) + ':' + norm(ln);
      var rec = contactsByName[nk] ||
        (contactsByName[nk] = { first: fn, last: ln, phones: [], emails: [] });
      var info = (c.contact_info || '').trim();
      if (!info) return;
      if (info.indexOf('@') !== -1) {
        if (rec.emails.indexOf(info) === -1) rec.emails.push(info);
      } else {
        var digits = info.replace(/\D/g, '');
        if (digits && rec.phones.indexOf(digits) === -1) rec.phones.push(digits);
      }
    });

    // Match IG people to contacts — conservative, username-evidence only.
    var claimed = {};
    Object.keys(people).forEach(function (key) {
      var p = people[key];
      var best = null;
      Object.keys(contactsByName).forEach(function (nk) {
        var c = contactsByName[nk];
        var score = usernameNameMatchScore(p.ig_username, c.first, c.last);
        if (score > 0 && (!best || score > best.score)) best = { score: score, nk: nk, c: c };
      });
      if (best) {
        p.first_name = best.c.first || null;
        p.last_name = best.c.last || null;
        p.phone = best.c.phones[0] || null;
        p.email = best.c.emails[0] || null;
        p.identity_confidence = best.score === 3 ? 'high' : 'medium';
        addSignal(p, 'contacts',
          best.score === 3 ? 'synced_contact' : 'synced_contact_weak',
          'Instagram username matches synced contact "' + (best.c.first + ' ' + best.c.last).trim() + '"');
        claimed[best.nk] = true;
      }
    });

    // Contact-only people.
    Object.keys(contactsByName).forEach(function (nk) {
      if (claimed[nk]) return;
      var c = contactsByName[nk];
      var key = 'ct:' + nk;
      var p = people[key] = {
        person_key: key,
        ig_username: null, ig_url: null,
        display_name: (c.first + ' ' + c.last).trim(),
        first_name: c.first || null, last_name: c.last || null,
        phone: c.phones[0] || null, email: c.emails[0] || null,
        identity_confidence: 'confirmed',
        signals: []
      };
      addSignal(p, 'contacts', 'synced_contact', 'In Michael\'s synced phone contacts');
    });

    var list = Object.keys(people).map(function (k) {
      var p = people[k];
      p.relationship_strength = p.signals.reduce(function (a, s) { return a + s.strength; }, 0);
      return p;
    });
    list.sort(function (a, b) { return b.relationship_strength - a.relationship_strength; });
    return list;
  }

  // Convenience: full pipeline from a ZIP ArrayBuffer.
  async function parseConnectionsZip(arrayBuffer) {
    var files = await readZip(arrayBuffer);
    var data = parseExportFiles(files);
    var people = normalizePeople(data);
    return {
      people: people,
      stats: {
        followers: data.followers.length,
        following: data.following.length,
        contacts_raw: data.contacts.length,
        pending_requests: data.pending_requests.length,
        recent_requests: data.recent_requests.length,
        requests_received: data.requests_received.length,
        recently_unfollowed: data.recently_unfollowed.length,
        people: people.length,
        mutual: people.filter(function (p) {
          return p.signals.some(function (s) { return s.signal_type === 'mutual_follow'; });
        }).length,
        matched_both: people.filter(function (p) {
          return p.ig_username && p.signals.some(function (s) { return s.source === 'contacts'; });
        }).length
      }
    };
  }

  return {
    readZip: readZip,
    parseLinkList: parseLinkList,
    parseNameTableList: parseNameTableList,
    parseContacts: parseContacts,
    parseExportFiles: parseExportFiles,
    normalizePeople: normalizePeople,
    parseConnectionsZip: parseConnectionsZip,
    usernameNameMatchScore: usernameNameMatchScore,
    norm: norm,
    SIGNAL_STRENGTH: SIGNAL_STRENGTH
  };
}));
