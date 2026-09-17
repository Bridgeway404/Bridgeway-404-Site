// Current owner-of-record lookups from county assessor / GIS parcel services
// (ArcGIS REST, free, automation-friendly). This is how the pipeline verifies
// that a property on a sale list actually changed hands: the assessor's
// current owner differs from the owner the sale list named.
//
//   Fulton : hosted Tax_Parcels FeatureServer (TaxYear 2026; Owner, OwnerAddr1/2, LUCode, ClassCode, LivUnits)
//   DeKalb : dcgis hosted Parcels layer 0 (OWNERNME1/2, PSTL*, USEDSCRP, CLASSDSCRP; updated weekly)
//   Cobb   : gis.cobbcounty.org taxassessorsdaily layer 0 (OWNER_NAM1/2, OWNER_ADDR…, CLASS; daily)
//   Douglas: maps.douglascountyga.gov TylerTech LandRecords layer 0 (OWNER, MAILADD1-3, DIGCLASS, DEED_DATE)
//            — a snapshot whose deed dates end in 2021, so it is flagged `stale`
//   Henry  : arcgis.co.henry.ga.us Parcels layer 12 publishes no owner field (qPublic is bot-blocked)
//
// Adding a county = adding an entry here (plus a sale-list source).
import { cleanWhitespace, parcelKey } from './normalize.js';

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

export const ASSESSORS = {
  Fulton: {
    id: 'fulton_tax_parcels',
    label: 'Fulton County hosted Tax_Parcels layer (assessor)',
    url: 'https://services1.arcgis.com/AQDHTHDrZzfsFsB5/arcgis/rest/services/Tax_Parcels/FeatureServer/0/query',
    fields: 'ParcelID,Owner,OwnerAddr1,OwnerAddr2,LUCode,ClassCode,LivUnits,Address,TaxYear',
    where: (parcel) => `ParcelID='${esc(parcel)}'`,
    // Fulton parcel ids are printed as "14 0077 0008 039-9" and stored as "14 007700080399".
    parcelVariants: (p) => {
      const k = parcelKey(p);
      const out = new Set([cleanWhitespace(p)]);
      if (k.length === 14) { out.add(`${k.slice(0, 2)} ${k.slice(2)}`); out.add(`${k.slice(0, 2)} ${k.slice(2, 6)} ${k.slice(6, 10)} ${k.slice(10, 13)}-${k.slice(13)}`); }
      return Array.from(out);
    },
    map: (f) => ({ parcel_id: f.ParcelID, owner_name: f.Owner, owner_mailing: [f.OwnerAddr1, f.OwnerAddr2].filter(x => x && String(x).trim()).join(', ') || null, use: [f.LUCode, f.ClassCode].filter(Boolean).join(' '), units: f.LivUnits, site_address: f.Address, tax_year: f.TaxYear }),
    stale: false,
  },
  DeKalb: {
    id: 'dekalb_parcels',
    label: 'DeKalb County GIS hosted Parcels layer (assessor)',
    url: 'https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0/query',
    fields: 'PARCELID,SITEADDRESS,CITY,ZIP,OWNERNME1,OWNERNME2,PSTLADDRESS,PSTLCITY,PSTLSTATE,PSTLZIP5,USEDSCRP,CLASSDSCRP,LASTUPDATE',
    where: (parcel) => `PARCELID='${esc(parcel)}'`,
    // DeKalb ids look like "15 123 01 001"; lists sometimes print "15-123-01-001".
    parcelVariants: (p) => {
      const k = parcelKey(p);
      const out = new Set([cleanWhitespace(p)]);
      if (k.length === 10) out.add(`${k.slice(0, 2)} ${k.slice(2, 5)} ${k.slice(5, 7)} ${k.slice(7)}`);
      return Array.from(out);
    },
    map: (f) => ({ parcel_id: f.PARCELID, owner_name: [f.OWNERNME1, f.OWNERNME2].filter(x => x && String(x).trim()).join(' & '), owner_mailing: [f.PSTLADDRESS, [f.PSTLCITY, f.PSTLSTATE, f.PSTLZIP5].filter(Boolean).join(' ')].filter(x => x && String(x).trim()).join(', ') || null, use: [f.USEDSCRP, f.CLASSDSCRP].filter(Boolean).join(' '), site_address: f.SITEADDRESS, city: f.CITY, zip: f.ZIP, updated: f.LASTUPDATE }),
    stale: false,
  },
  Cobb: {
    id: 'cobb_taxassessorsdaily',
    label: 'Cobb County GIS taxassessorsdaily parcel layer (assessor, daily)',
    url: 'https://gis.cobbcounty.org/gisserver/rest/services/tax/taxassessorsdaily/MapServer/0/query',
    fields: 'PIN,PARID,SITUS_ADDR,OWNER_NAM1,OWNER_NAM2,OWNER_ADDR,OWNER_CITY,OWNER_STAT,OWNER_ZIP,CLASS,FMV',
    where: (parcel) => `PARID='${esc(parcel)}' OR PIN='${esc(parcel)}'`,
    parcelVariants: (p) => [cleanWhitespace(p), parcelKey(p)],
    map: (f) => ({ parcel_id: f.PARID || f.PIN, owner_name: [f.OWNER_NAM1, f.OWNER_NAM2].filter(x => x && String(x).trim()).join(' & '), owner_mailing: [f.OWNER_ADDR, [f.OWNER_CITY, f.OWNER_STAT, f.OWNER_ZIP].filter(Boolean).join(' ')].filter(x => x && String(x).trim()).join(', ') || null, use: f.CLASS, site_address: f.SITUS_ADDR, value: f.FMV }),
    stale: false,
  },
  Douglas: {
    id: 'douglas_tyler_landrecords',
    label: 'Douglas County GIS TylerTech LandRecords layer (assessor snapshot)',
    url: 'https://maps.douglascountyga.gov/arcgis/rest/services/TylerTech/LandRecords/MapServer/0/query',
    fields: 'PIN,OWNER,MAILADD1,MAILADD2,MAILADD3,CITY,STATE,ZIPCODE,DEED_REASON,DEED_DATE,DIGCLASS,ADDRESS,HOME_EXEMPT',
    where: (parcel) => `PIN='${esc(parcel)}'`,
    parcelVariants: (p) => [cleanWhitespace(p), parcelKey(p)],
    map: (f) => ({ parcel_id: f.PIN, owner_name: f.OWNER, owner_mailing: [[f.MAILADD1, f.MAILADD2, f.MAILADD3].filter(x => x && String(x).trim()).join(' '), [f.CITY, f.STATE, f.ZIPCODE].filter(Boolean).join(' ')].filter(x => x && String(x).trim()).join(', ') || null, use: f.DIGCLASS, site_address: f.ADDRESS, deed_date: f.DEED_DATE, deed_reason: f.DEED_REASON }),
    // The published layer's newest deed date is Sep 2021: it can classify the
    // property and give the pre-sale owner, but it cannot show a 2025-26 purchaser.
    stale: true,
    staleNote: 'Douglas County publishes a 2021 snapshot of its land records in GIS; owner changes after a 2025-26 tax sale do not appear there.',
  },
  Henry: {
    id: 'henry_parcels',
    label: 'Henry County GIS Parcels layer (no owner field published)',
    url: 'https://arcgis.co.henry.ga.us/server/rest/services/Parcels/MapServer/12/query',
    fields: 'PARCEL_NO,HOUSE_NUMB,STREETNAME,POST_TYPE,JURISDICTI,ZONING,SUBDIVISIO',
    where: (parcel) => `PARCEL_NO='${esc(parcel)}'`,
    parcelVariants: (p) => [cleanWhitespace(p), parcelKey(p)],
    map: (f) => ({ parcel_id: f.PARCEL_NO, owner_name: null, owner_mailing: null, use: [f.ZONING, f.SUBDIVISIO].filter(Boolean).join(' '), site_address: [f.HOUSE_NUMB, f.STREETNAME, f.POST_TYPE].filter(Boolean).join(' ') }),
    stale: false,
    noOwner: true,
    noOwnerNote: 'Henry County does not publish owner names in its GIS parcel layer and its qPublic assessor site blocks automated access; purchasers must be confirmed by hand.',
  },
};

export function assessorFor(county) { return ASSESSORS[county] || null; }

export function buildOwnerQueryUrl(county, parcelId) {
  const a = ASSESSORS[county];
  if (!a || !parcelId) return null;
  const variants = a.parcelVariants(parcelId).filter(Boolean);
  const where = variants.map(v => a.where(v)).join(' OR ');
  const params = new URLSearchParams({ where, outFields: a.fields, returnGeometry: 'false', f: 'json', resultRecordCount: '5' });
  return `${a.url}?${params.toString()}`;
}

/** Turn an ArcGIS query response into the first matching owner record (or an error). */
export function readOwnerResponse(county, json) {
  const a = ASSESSORS[county];
  if (!a) return { record: null, error: 'no assessor adapter for ' + county };
  if (!json) return { record: null, error: 'empty response' };
  if (json.error) return { record: null, error: `assessor error ${json.error.code || ''}: ${json.error.message || ''}`.trim() };
  const feats = Array.isArray(json.features) ? json.features : [];
  if (!feats.length) return { record: null, error: null, notFound: true };
  const rec = a.map(feats[0].attributes || feats[0]);
  if (rec.owner_name != null) rec.owner_name = cleanWhitespace(rec.owner_name).replace(/\s*,\s*$/, '') || null;
  return { record: rec, error: null };
}

/**
 * Compare the assessor's current owner with the owner named on the sale list.
 * Returns { changed: boolean|null, reason }. `null` means "cannot tell".
 */
export function ownerChanged(listOwner, assessorOwner) {
  const a = ownerToken(listOwner), b = ownerToken(assessorOwner);
  if (!a || !b) return { changed: null, reason: 'owner name missing on one side' };
  if (UNKNOWN_OWNER.test(listOwner || '')) return { changed: null, reason: 'the county list did not name the pre-sale owner', unknownPrior: true };
  if (UNKNOWN_OWNER.test(assessorOwner || '')) return { changed: null, reason: 'the assessor roll has no owner name', unknownCurrent: true };
  if (a === b) return { changed: false, reason: 'same owner on the assessor roll' };
  // Same surname-first personal name printed in a different order / with initials still counts as the same person.
  const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
  const shared = [...wa].filter(w => w.length > 2 && wb.has(w));
  const smaller = Math.min(wa.size, wb.size);
  if (smaller > 0 && shared.length >= Math.max(1, Math.ceil(smaller * 0.6))) return { changed: false, reason: 'owner names match closely (' + shared.join(' ') + ')' };
  return { changed: true, reason: 'assessor now lists a different owner' };
}

export const UNKNOWN_OWNER = /UNKNOWN OWNER|NO DEED REF|OWNER UNKNOWN|UNRETURNED PROPERTY|^N\/?A$/i;

function ownerToken(name) {
  return cleanWhitespace(String(name || '').toUpperCase()
    .replace(/\b(LLC|L\.L\.C\.?|INC\.?|CORP\.?|CO\.?|LTD\.?|LP|L\.P\.?|LLP|LLLP|PLLC|THE|ET AL|ETAL|TRUSTEE|TR|AS TRUSTEE|MR|MRS|MS|JR|SR|II|III)\b/g, ' ')
    .replace(/&/g, ' ').replace(/[^A-Z0-9 ]/g, ' '));
}
