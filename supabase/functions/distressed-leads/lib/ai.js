// Prompts, JSON schemas and response handling for the Claude-assisted steps.
// Pure: the actual API call (`callModel`) is injected by the runtime.
//
// Three uses:
//   1. extractNotices   — turn a foreclosure notice (text or PDF) into structured fields
//   2. extractCalendar  — fallback for court calendars the deterministic parsers cannot read
//   3. researchCompany  — web research on a company: who they are, website, phone,
//                         business-side contacts, evidence URLs, confidence
//
// Every result carries source URLs. Nothing the model says is stored as a
// fact without a source; the pipeline stores its claims as evidence rows.

export const NOTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          notice_type: { type: 'string', enum: ['sale_under_power', 'foreclosure', 'tax_sale', 'cancellation', 'other'] },
          county: { type: ['string', 'null'] },
          property_address: { type: ['string', 'null'], description: 'Street address only, e.g. "1234 Main St NW"' },
          city: { type: ['string', 'null'] },
          zip: { type: ['string', 'null'] },
          parcel_id: { type: ['string', 'null'] },
          legal_description: { type: ['string', 'null'], description: 'Short: land lot / district / subdivision, max 300 chars' },
          sale_date: { type: ['string', 'null'], description: 'ISO date of the scheduled sale (first Tuesday rule if stated)' },
          borrower_names: { type: ['string', 'null'], description: 'Grantor(s) of the security deed, as printed' },
          lender: { type: ['string', 'null'], description: 'Original lender / grantee of the security deed' },
          secured_party: { type: ['string', 'null'], description: 'Current holder of the security deed if stated' },
          foreclosing_entity: { type: ['string', 'null'] },
          servicer: { type: ['string', 'null'], description: 'Entity with authority to negotiate / servicer' },
          law_firm: { type: ['string', 'null'] },
          foreclosure_identifier: { type: ['string', 'null'], description: 'Law firm file number or reference if printed' },
          borrower_looks_like_business: { type: 'boolean' },
          excerpt: { type: 'string', description: 'First 300 characters of the notice text' },
        },
        required: ['notice_type', 'county', 'property_address', 'city', 'zip', 'parcel_id', 'legal_description', 'sale_date', 'borrower_names', 'lender', 'secured_party', 'foreclosing_entity', 'servicer', 'law_firm', 'foreclosure_identifier', 'borrower_looks_like_business', 'excerpt'],
      },
    },
  },
  required: ['notices'],
};

export const NOTICE_SYSTEM = `You extract structured data from Georgia non-judicial foreclosure advertisements ("Notice of Sale Under Power") and related legal notices. Return every distinct notice in the document. Copy names exactly as printed. Never invent an address, parcel id or date; use null when a field is not printed. Georgia sales occur on the first Tuesday of the month; convert "first Tuesday in October, 2026" to that ISO date. Only include notices for Fulton, DeKalb, Douglas or Henry County, Georgia.`;

export function noticeUserPrompt(sourceLabel, publicationDate) {
  return `Source: ${sourceLabel}. Publication date: ${publicationDate || 'unknown'}. Extract all foreclosure notices as JSON matching the schema.`;
}

export const CALENDAR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hearing_date: { type: ['string', 'null'] },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          case_number: { type: 'string' },
          plaintiff_name: { type: 'string', description: 'Landlord / plaintiff entity exactly as printed, WITHOUT any tenant or defendant names' },
          community_name: { type: ['string', 'null'], description: 'Apartment community or d/b/a name if printed' },
          plaintiff_attorney: { type: ['string', 'null'] },
          hearing_time: { type: ['string', 'null'] },
          filed_date: { type: ['string', 'null'] },
          plaintiff_is_business: { type: 'boolean' },
        },
        required: ['case_number', 'plaintiff_name', 'community_name', 'plaintiff_attorney', 'hearing_time', 'filed_date', 'plaintiff_is_business'],
      },
    },
  },
  required: ['hearing_date', 'rows'],
};

export const CALENDAR_SYSTEM = `You extract the PLAINTIFF side of dispossessory (eviction) court calendars. Privacy rule: never output tenant or defendant names, phone numbers or any personal information about occupants; output only the case number, the plaintiff (landlord / management company / owner entity), its attorney, community name, and dates. If the plaintiff is an individual person, still output the name as printed and set plaintiff_is_business=false.`;

export const COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    canonical_name: { type: ['string', 'null'] },
    company_type: { type: 'string', enum: ['property_management', 'owner_entity', 'institutional_investor', 'reit', 'sfr_operator', 'multifamily_operator', 'lender', 'servicer', 'law_firm', 'reo', 'asset_manager', 'preservation', 'government', 'nonprofit', 'individual', 'other', 'unknown'] },
    is_individual: { type: 'boolean' },
    summary: { type: 'string', description: 'Two or three sentences: what the company is, what it operates in metro Atlanta, and why it may need turnover/cleanout services' },
    website: { type: ['string', 'null'] },
    main_phone: { type: ['string', 'null'] },
    main_email: { type: ['string', 'null'] },
    contact_page_url: { type: ['string', 'null'] },
    hq_address: { type: ['string', 'null'] },
    parent_company: { type: ['string', 'null'] },
    property_manager: { type: ['string', 'null'], description: 'If this entity is an ownership LLC, the management company that operates its properties (if found)' },
    property_address: { type: ['string', 'null'], description: 'Street address of the community/property if researched and found' },
    portfolio_notes: { type: ['string', 'null'], description: 'Portfolio size / other metro Atlanta properties if found' },
    sos_control_number: { type: ['string', 'null'] },
    registered_agent: { type: ['string', 'null'] },
    contacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          email: { type: ['string', 'null'], description: 'Only if published on a business page. Never guess or infer.' },
          phone: { type: ['string', 'null'], description: 'Business phone only' },
          phone_type: { type: ['string', 'null'], enum: ['office', 'corporate', 'property_office', 'mobile_business', null] },
          profile_url: { type: ['string', 'null'] },
          source_url: { type: ['string', 'null'] },
          evidence: { type: 'string', description: 'What on the source page ties this person to the company/property' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'title', 'email', 'phone', 'phone_type', 'profile_url', 'source_url', 'evidence', 'confidence'],
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string' }, title: { type: ['string', 'null'] }, note: { type: ['string', 'null'] } },
        required: ['url', 'title', 'note'],
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidence_reason: { type: 'string' },
  },
  required: ['found', 'canonical_name', 'company_type', 'is_individual', 'summary', 'website', 'main_phone', 'main_email', 'contact_page_url', 'hq_address', 'parent_company', 'property_manager', 'property_address', 'portfolio_notes', 'sos_control_number', 'registered_agent', 'contacts', 'sources', 'confidence', 'confidence_reason'],
};

export const COMPANY_SYSTEM = `You are a B2B research analyst for Bridgeway 404, a metro Atlanta junk removal, cleanout and property turnover company. Given a company name that appeared in a foreclosure notice or eviction court record, research public web sources and identify:
- what the organization is (property management company, ownership LLC, institutional investor, single-family rental operator, lender/servicer, law firm, etc.);
- its website, main business phone, main business email or contact page;
- the parent company or the management company that actually operates the property;
- the people most likely to buy turnover / cleanout / hauling services: on-site or regional property managers, directors of operations, maintenance or facilities managers, asset or REO managers, portfolio managers, owner representatives. Registered agents and attorneys are NOT operational contacts.
Rules: use only information published on business web pages (company sites, community sites, Georgia Secretary of State, press, public professional profiles). Never fabricate or infer email addresses; leave email null unless it is printed on a page you cite. Never collect personal phone numbers, home addresses or anything about tenants. Cite the URL for every contact and every claim. Assign confidence: high = the page directly ties the company/person to this property or its operations; medium = the company is clearly right but the person's responsibility for this property is uncertain; low = plausible, needs manual verification. If the name is an individual person (a homeowner or small landlord), set is_individual=true and do not research the person.`;

export function companyUserPrompt({ name, context }) {
  const lines = [`Company or entity name: "${name}"`];
  if (context.county) lines.push(`County: ${context.county}, Georgia`);
  if (context.role) lines.push(`Appeared as: ${context.role}`);
  if (context.communityName) lines.push(`Community / d/b/a name on record: ${context.communityName}`);
  if (context.propertyAddress) lines.push(`Property address: ${context.propertyAddress}`);
  if (context.careOf) lines.push(`Listed c/o: ${context.careOf}`);
  if (context.otherProperties) lines.push(`Also appears on ${context.otherProperties} other properties in our database`);
  lines.push('Research this organization and return the JSON described by the schema. Prefer the operational buyer (property management / operations / maintenance / asset management) over executives.');
  return lines.join('\n');
}

/** Parse a structured-output response, tolerating text wrappers. */
export function parseJsonResponse(message) {
  if (!message) return null;
  if (message.parsed_output) return message.parsed_output;
  const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function usageCost(usage, model) {
  if (!usage) return 0;
  const rates = model && /sonnet/.test(model) ? [2, 10] : model && /haiku/.test(model) ? [1, 5] : [5, 25];
  const inp = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (inp * rates[0] + (usage.output_tokens || 0) * rates[1]) / 1e6;
}
