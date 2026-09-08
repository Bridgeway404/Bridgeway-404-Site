// Owner-of-record lookups from county GIS parcel services (ArcGIS REST).
// These are authoritative assessor feeds, free, and automation-friendly.
//   Fulton : gismaps.fultoncountyga.gov PropertyMapViewer layer 11 (Owner, OwnerAddr1/2)
//   DeKalb : dcgis.dekalbcountyga.gov hosted Parcels layer 0 (OWNERNME1/2, PSTLADDRESS…)
//   Henry  : arcgis.co.henry.ga.us Parcels layer 12 (no owner field — parcel id + qPublic link only)
//   Douglas: maps.douglascountyga.gov LandRecords layer 0 (fields discovered at runtime)
import { parseAddress, looksLikeEntity, cleanName } from '../normalize.js';

export const PARCEL_SERVICES = {
  Fulton: {
    url: 'https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/PropertyMapViewer/PropertyMapViewer/MapServer/11/query',
    fields: 'ParcelID,Address,AddrNumber,AddrStreet,AddrSuffix,AddrUnit,Owner,OwnerAddr1,OwnerAddr2,TaxDist,TotAssess',
    where: (a) => {
      const parts = [`AddrNumber='${esc(a.number)}'`];
      const streetWord = firstStreetWord(a.street);
      if (streetWord) parts.push(`UPPER(AddrStreet) LIKE '%${esc(streetWord)}%'`);
      return parts.join(' AND ');
    },
    parcelWhere: (p) => `ParcelID='${esc(p)}'`,
    map: (f) => ({ parcel_id: f.ParcelID, site_address: f.Address, owner_name: f.Owner, owner_mailing: [f.OwnerAddr1, f.OwnerAddr2].filter(Boolean).join(', '), tax_district: f.TaxDist, assessed: f.TotAssess }),
    sourceLabel: 'Fulton County GIS tax parcel layer',
    sourceUrl: 'https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/PropertyMapViewer/PropertyMapViewer/MapServer/11',
  },
  DeKalb: {
    url: 'https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0/query',
    fields: 'PARCELID,SITEADDRESS,ADDRESS_NUMBER,FULL_STREET_NAME,UNIT_NO,CITY,ZIP,OWNERNME1,OWNERNME2,PSTLADDRESS,PSTLCITY,PSTLSTATE,PSTLZIP5,USEDSCRP,CLASSDSCRP,RESYRBLT',
    where: (a) => {
      // ADDRESS_NUMBER is an integer field on this hosted layer.
      const num = parseInt(String(a.number).replace(/\D/g, ''), 10);
      if (!num) return null;
      const parts = [`ADDRESS_NUMBER=${num}`];
      const streetWord = firstStreetWord(a.street);
      if (streetWord) parts.push(`UPPER(FULL_STREET_NAME) LIKE '%${esc(streetWord)}%'`);
      return parts.join(' AND ');
    },
    parcelWhere: (p) => `PARCELID='${esc(p)}'`,
    map: (f) => ({ parcel_id: f.PARCELID, site_address: f.SITEADDRESS, owner_name: [f.OWNERNME1, f.OWNERNME2].filter(Boolean).join(' & '), owner_mailing: [f.PSTLADDRESS, [f.PSTLCITY, f.PSTLSTATE, f.PSTLZIP5].filter(Boolean).join(' ')].filter(Boolean).join(', '), use: f.USEDSCRP, property_class: f.CLASSDSCRP, year_built: f.RESYRBLT, city: f.CITY, zip: f.ZIP }),
    sourceLabel: 'DeKalb County GIS parcel layer',
    sourceUrl: 'https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0',
  },
  Henry: {
    url: 'https://arcgis.co.henry.ga.us/server/rest/services/Parcels/MapServer/12/query',
    fields: 'PARCEL_NO,HOUSE_NUMB,PRE_DIRECT,STREETNAME,POST_TYPE,POST_DIR,UNIT,JURISDICTI,ZONING,SUBDIVISIO,QPublic,ACREAGE_1',
    where: (a) => {
      const parts = [`HOUSE_NUMB='${esc(a.number)}'`];
      const streetWord = firstStreetWord(a.street);
      if (streetWord) parts.push(`UPPER(STREETNAME) LIKE '%${esc(streetWord)}%'`);
      return parts.join(' AND ');
    },
    parcelWhere: (p) => `PARCEL_NO='${esc(p)}'`,
    map: (f) => ({ parcel_id: f.PARCEL_NO, site_address: [f.HOUSE_NUMB, f.PRE_DIRECT, f.STREETNAME, f.POST_TYPE, f.POST_DIR].filter(Boolean).join(' '), owner_name: null, owner_mailing: null, zoning: f.ZONING, subdivision: f.SUBDIVISIO, qpublic_url: f.QPublic, jurisdiction: f.JURISDICTI }),
    sourceLabel: 'Henry County GIS parcel layer (owner name not published in GIS; qPublic link only)',
    sourceUrl: 'https://arcgis.co.henry.ga.us/server/rest/services/Parcels/MapServer/12',
  },
  Douglas: {
    url: 'https://maps.douglascountyga.gov/arcgis/rest/services/LandRecords/LandRecords/MapServer/0/query',
    fields: 'PIN,ADDRESS,HOUSENUM,PREDIR,NAME,SUFTYPE,SUFDIR,UNITNUM,OWNER,MAILADD1,MAILADD2,MAILADD3,CITY,STATE,ZIPCODE,LEGAL_DESC,SUBDIVISION,ZONING_CODE,DIGCLASS,HOME_EXEMPT,DEED_DATE',
    where: (a) => {
      const parts = [`HOUSENUM='${esc(a.number)}'`];
      const streetWord = firstStreetWord(a.street);
      if (streetWord) parts.push(`UPPER(NAME) LIKE '%${esc(streetWord)}%'`);
      return parts.join(' AND ');
    },
    parcelWhere: (p) => `PIN='${esc(p)}'`,
    map: (f) => ({ parcel_id: f.PIN, site_address: f.ADDRESS || [f.HOUSENUM, f.PREDIR, f.NAME, f.SUFTYPE, f.SUFDIR].filter(x => x && String(x).trim()).join(' '), owner_name: f.OWNER, owner_mailing: [f.MAILADD1, f.MAILADD2, f.MAILADD3].filter(x => x && String(x).trim()).join(', ') || null, legal_description: f.LEGAL_DESC, subdivision: f.SUBDIVISION, zoning: f.ZONING_CODE, property_class: f.DIGCLASS, homestead: f.HOME_EXEMPT, city: f.CITY, zip: f.ZIPCODE }),
    sourceLabel: 'Douglas County GIS land records layer',
    sourceUrl: 'https://maps.douglascountyga.gov/arcgis/rest/services/LandRecords/LandRecords/MapServer/0',
  },
};

function esc(s) { return String(s == null ? '' : s).replace(/'/g, "''").toUpperCase(); }
function firstStreetWord(street) {
  const toks = String(street || '').split(' ').filter(Boolean);
  // skip a leading direction
  const first = toks.length > 1 && /^(N|S|E|W|NE|NW|SE|SW)$/.test(toks[0]) ? toks[1] : toks[0];
  return first && first.length >= 3 ? first : null;
}

export function buildQueryUrl(county, { address, parcelId } = {}) {
  const svc = PARCEL_SERVICES[county];
  if (!svc) return null;
  let where = null;
  if (parcelId) where = svc.parcelWhere(parcelId);
  else if (address) {
    const a = parseAddress(address);
    if (!a || !a.number) return null;
    where = svc.where(a);
  }
  if (!where) return null;
  const params = new URLSearchParams({ where, outFields: svc.fields, returnGeometry: 'false', f: 'json', resultRecordCount: '10' });
  return `${svc.url}?${params.toString()}`;
}

/**
 * Pick the best feature for the address: exact street-suffix match preferred;
 * unit match when the address has a unit. Returns { record, confidence }.
 */
export function pickFeature(county, features, address) {
  const svc = PARCEL_SERVICES[county];
  const a = parseAddress(address);
  const recs = (features || []).map(f => svc.map(f.attributes || f));
  if (!recs.length) return { record: null, confidence: null };
  const target = a ? a.norm.replace(/\s#.*$/, '') : null;
  const scored = recs.map(r => {
    const p = parseAddress(r.site_address || '');
    let s = 0;
    if (p && target && p.norm.replace(/\s#.*$/, '') === target) s += 10;
    if (p && a && a.unit && p.unit && p.unit === a.unit) s += 5;
    if (p && a && !a.unit && !p.unit) s += 1;
    return { r, s };
  }).sort((x, y) => y.s - x.s);
  const best = scored[0];
  if (best.s >= 10) return { record: best.r, confidence: recs.length === 1 || scored[1]?.s < best.s ? 'high' : 'medium' };
  if (recs.length === 1) return { record: best.r, confidence: 'medium' };
  return { record: best.r, confidence: 'low' };
}

/** Classify the owner name and mailing address into what the pipeline needs. */
export function interpretOwner(record) {
  if (!record || !record.owner_name) return null;
  const name = cleanName(record.owner_name);
  const isEntity = looksLikeEntity(name);
  const mailing = record.owner_mailing || null;
  const outOfState = mailing ? !/\bGA\b|GEORGIA/i.test(mailing) : null;
  return { name, isEntity, mailing, outOfState };
}

/** Rough property type from assessor use/class descriptions. */
export function propertyTypeFrom(record, fallback = 'unknown') {
  const t = [record?.use, record?.property_class, record?.zoning, record?.subdivision].filter(Boolean).join(' ').toLowerCase();
  if (/apartment|multi|multifamily|multi-family|rm-|r-?m\b/.test(t)) return 'multifamily';
  if (/condo/.test(t)) return 'condo';
  if (/townho/.test(t)) return 'townhome';
  if (/commercial|office|retail|industrial|warehouse|c-?\d/.test(t)) return 'commercial';
  if (/vacant|land|acreage/.test(t)) return 'land';
  if (/residential|single|r-?\d|sfr|dwelling/.test(t)) return 'single_family';
  return fallback;
}
