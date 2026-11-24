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
    id: 'atl_permits_issued', kind: 'arcgis_permits', county: 'Fulton', enabled: false, verified: false,
    layerUrl: 'https://services5.arcgis.com/54falWtcpty3V47Z/ArcGIS/rest/services/BldgPermitIssued_CurrentYear/FeatureServer/0',
    dateField: 'IssuedDate', fields: PERMIT_FIELDS,
    terms: 'Public ArcGIS feature service found by web search; ownership by City of Atlanta NOT yet confirmed. Confirm owner, field names and terms before enabling.',
  },
  {
    id: 'dekalb_permit_applications', kind: 'arcgis_permits', county: 'DeKalb', enabled: false, verified: false,
    layerUrl: 'https://dcgis.dekalbcountyga.gov/mapping/rest/services/Building_Permit_Applications/MapServer/0',
    dateField: 'APPLIED_DATE', fields: PERMIT_FIELDS,
    terms: 'DeKalb County GIS public map service. Field names and terms not yet confirmed.',
  },
  {
    id: 'sam_gov', kind: 'sam_gov', enabled: false, verified: false,
    terms: 'Official public API (api.sam.gov). Requires a free API key from a registered SAM.gov account.',
  },
];

export const enabledSources = (all = SOURCES) => all.filter((s) => s.enabled && s.verified);
