// Radar source registry.
//
// `verified` records whether this layer URL and its field names were confirmed
// against the live service. Until a source is verified it stays disabled: the
// candidate field names below are educated defaults for Accela-style permit
// layers and MUST be checked with one live query before the source is enabled.
// `terms` records what was checked about permitted use.

const PERMIT_FIELDS = {
  permitNumber: ['PermitNumber', 'PERMIT_NUMBER', 'PermitNum', 'RECORD_ID', 'RecordNumber', 'CASE_NUMBER', 'Permit_No', 'APNO'],
  date: ['IssuedDate', 'ISSUE_DATE', 'IssueDate', 'DATE_ISSUED', 'AppliedDate', 'APPLIED_DATE', 'FILE_DATE', 'OpenedDate', 'StatusDate'],
  address: ['Address', 'ADDRESS', 'FullAddress', 'SITE_ADDRESS', 'OriginalAddress1', 'LOCATION', 'PROP_ADDRESS'],
  permitType: ['PermitType', 'PERMIT_TYPE', 'RecordType', 'RECORD_TYPE', 'PermitTypeDesc', 'TYPE'],
  workClass: ['WorkClass', 'WORK_CLASS', 'PermitClass', 'SubType', 'SUB_TYPE', 'PermitWorkType', 'WORK_TYPE'],
  description: ['Description', 'DESCRIPTION', 'WorkDescription', 'WORK_DESC', 'ProjectName', 'PROJECT_NAME', 'SCOPE'],
  valuation: ['Valuation', 'VALUATION', 'JobValue', 'JOB_VALUE', 'EstProjectCost', 'CONST_COST', 'TotalValuation'],
  contractor: ['ContractorCompanyName', 'CONTRACTOR', 'Contractor', 'CONTRACTOR_NAME', 'ContractorName', 'BUSINESS_NAME'],
  occupancy: ['Occupancy', 'OCCUPANCY', 'UseType', 'PROPERTY_USE', 'PermitClassMapped', 'LandUse'],
  status: ['Status', 'STATUS', 'StatusCurrent', 'PERMIT_STATUS'],
};

export const SOURCES = [
  {
    // Verified live on 2026-11-24 from the development database: 96,146 records, current to the same day.
    // The production adapter for this layer (its real field names and work-type scoring) lives with the
    // background worker in the private automation repository, not here.
    id: 'dekalb_permits', kind: 'arcgis_permits', county: 'DeKalb', enabled: false, verified: true,
    layerUrl: 'https://dcgis.dekalbcountyga.gov/mapping/rest/services/Building_Permit_Applications/MapServer/0',
    dateField: 'applicationDateTime',
    fields: { ...PERMIT_FIELDS, permitNumber: ['applicationNumber'], date: ['applicationDateTime'], address: ['locationLine1'],
      workClass: ['WorkTypeDescription'], permitType: ['applicationType_description'], description: ['comments', 'applicationName'],
      valuation: ['declaredValuation'], contractor: ['primaryContactName'], occupancy: ['OccupancyTypeDescription'], status: ['statusDescription'] },
    terms: 'County-run public ArcGIS map service, no login; layer metadata carries no copyright or use restriction; host serves no robots.txt.',
  },
  // REMOVED 2026-11-24: services5.arcgis.com/54falWtcpty3V47Z "BldgPermitIssued_CurrentYear" was listed here as
  // City of Atlanta. A live check showed it belongs to the City of Sacramento. City of Atlanta's planning GIS
  // (gis.atlantaga.gov/dpcd) exposes zoning and parcel layers but no permit layer.
  {
    id: 'sam_gov', kind: 'sam_gov', enabled: false, verified: false,
    terms: 'Official public API (api.sam.gov). Requires a free API key from a registered SAM.gov account.',
  },
];

export const enabledSources = (all = SOURCES) => all.filter((s) => s.enabled && s.verified);
