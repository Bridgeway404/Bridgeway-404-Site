// Prompts, JSON schemas and response handling for the Claude-assisted steps.
// Pure: the API call is injected by the runtime (index.ts) and faked in tests.
//
// Two uses:
//   1. discover — one web-research pass: find plaintiff-side eviction attorneys
//      for a set of counties, with evidence and source URLs, skipping known names
//   2. enrich   — for an attorney taken from court calendars: find the firm,
//      phone, email, website and any landlord / property-management marketing
//
// Nothing the model says is stored without a source URL. Phone numbers and
// emails must be copied from a cited page, never guessed.

const LEAD_FIELDS = {
  attorney_name: { type: ['string', 'null'], description: 'Full name of the individual attorney, without "Esq." or titles. Null only for a firm-level lead with no named attorney.' },
  firm_name: { type: ['string', 'null'] },
  phone: { type: ['string', 'null'], description: 'Business phone printed on a cited page. Never guess.' },
  email: { type: ['string', 'null'], description: 'Only if printed on a cited business page. Never infer from a naming pattern.' },
  website: { type: ['string', 'null'] },
  city: { type: ['string', 'null'] },
  county: { type: ['string', 'null'], description: 'Primary Georgia county served (Fulton, DeKalb, Gwinnett, Cobb, Clayton, Douglas, Henry, …)' },
  counties: { type: 'array', items: { type: 'string' } },
  practice_area: { type: ['string', 'null'], description: 'Short, e.g. "Landlord-tenant / dispossessory (plaintiff side)"' },
  clients_identified: { type: ['string', 'null'], description: 'Named property-management companies, apartment communities, landlords or owners this attorney/firm represents, semicolon separated. Null if none are named on the sources.' },
  evidence: { type: 'string', description: 'Two or three sentences quoting or closely paraphrasing what the cited pages say that shows landlord-side eviction / dispossessory work for property managers, apartment communities or owners.' },
  source_url: { type: 'string', description: 'The single best page supporting the evidence' },
  source_urls: { type: 'array', items: { type: 'string' } },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = the page explicitly says they represent landlords/property managers in evictions or dispossessories; medium = strong landlord-side signal but not explicit; low = plausible, needs a call to confirm' },
  referral_potential: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = firm-wide landlord/property-management eviction practice with institutional clients; medium = regular landlord evictions; low = occasional individual landlords' },
  landlord_side: { type: 'boolean', description: 'true only when the sources show plaintiff/landlord-side work (not tenant defense)' },
};
const LEAD_REQUIRED = Object.keys(LEAD_FIELDS);

export const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attorneys: { type: 'array', items: { type: 'object', additionalProperties: false, properties: LEAD_FIELDS, required: LEAD_REQUIRED } },
    notes: { type: 'string', description: 'One or two sentences on what was searched and what was skipped' },
  },
  required: ['attorneys', 'notes'],
};

export const DISCOVER_SYSTEM = `You are a business-development researcher for Bridgeway 404, a metro Atlanta junk removal, property cleanout and unit-turnover company. Bridgeway is building a call list of plaintiff-side attorneys and law firms that represent LANDLORDS, APARTMENT COMMUNITIES, PROPERTY MANAGEMENT COMPANIES and MULTIFAMILY / SINGLE-FAMILY RENTAL OWNERS in dispossessory (eviction) proceedings in Georgia. When those clients regain possession of a unit it often contains abandoned belongings that must be hauled out before the unit can be turned, so an attorney with property-management clients is a recurring referral source.

Find attorneys with AFFIRMATIVE evidence of landlord-side eviction work, for example:
- a firm page marketing eviction / dispossessory / landlord-tenant representation to property owners, landlords, apartment communities or management companies;
- an attorney biography describing representation of property management companies, multifamily owners or apartment communities in dispossessory actions;
- membership or "allied member" / vendor / legal-resource listings with the Atlanta Apartment Association, Georgia Apartment Association, NARPM (Atlanta chapter), IREM Georgia, or property-management industry directories;
- court calendars, dockets or news showing the attorney filing dispossessory cases for landlord entities.

Skip: tenant-defense and legal-aid attorneys; general real estate / closing attorneys with no eviction evidence; attorneys outside Georgia; anyone already on the known list you are given; and anything you cannot support with a URL you actually read. Quality over quantity: ten well-evidenced attorneys beat thirty guesses.

Rules: copy phone numbers and emails only from pages you cite; never infer an email from a naming pattern; use a firm's main line when no direct line is published and say so in the evidence; cite the URL for every claim; never include tenants, defendants or anything about occupants. Prefer firms whose clients are property-management companies and apartment communities (recurring referrals) over attorneys who occasionally help an individual landlord. Return only JSON matching the schema.`;

export function discoverUserPrompt({ counties, focus, known, maxResults }) {
  const lines = [];
  lines.push(`Counties to cover this pass: ${(counties || []).join(', ')} (Georgia; metro Atlanta).`);
  if (focus) lines.push(`Research angle for this pass: ${focus}`);
  lines.push(`Return up to ${maxResults} attorneys or firms that qualify. Include the firm's main phone number whenever a direct line is not published.`);
  if (known && known.length) {
    lines.push(`Already on the list — do NOT return these again (attorney — firm): ${known.slice(0, 400).join('; ')}`);
  }
  lines.push('Search the web, read the pages, then return the JSON described by the schema.');
  return lines.join('\n');
}

export const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', description: 'true when you located this attorney and are confident it is the same person practising in Georgia' },
    firm_name: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'], description: 'Direct or firm main line, copied from a cited page' },
    phone_is_firm_main_line: { type: 'boolean' },
    email: { type: ['string', 'null'], description: 'Only if printed on a cited page' },
    website: { type: ['string', 'null'] },
    city: { type: ['string', 'null'] },
    county: { type: ['string', 'null'] },
    practice_summary: { type: ['string', 'null'], description: 'One sentence on the practice as the sources describe it' },
    clients_identified: { type: ['string', 'null'], description: 'Property-management companies, apartment communities, landlords or owners the sources name as clients, semicolon separated' },
    evidence: { type: ['string', 'null'], description: 'What the cited pages say about landlord / property-management / eviction work (two sentences max). Null if the pages say nothing about it.' },
    source_url: { type: ['string', 'null'] },
    source_urls: { type: 'array', items: { type: 'string' } },
    landlord_side: { type: ['boolean', 'null'], description: 'true if the sources show landlord-side work; false if they show tenant defense; null if the sources do not say' },
    referral_potential: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
    notes: { type: ['string', 'null'], description: 'Anything Leslie should know before calling (e.g. firm handles hundreds of evictions a month; works mostly for one large operator)' },
  },
  required: ['found', 'firm_name', 'phone', 'phone_is_firm_main_line', 'email', 'website', 'city', 'county', 'practice_summary', 'clients_identified', 'evidence', 'source_url', 'source_urls', 'landlord_side', 'referral_potential', 'notes'],
};

export const ENRICH_SYSTEM = `You are a business-development researcher for Bridgeway 404, a metro Atlanta junk removal and property-turnover company. You are given the name of an attorney who appeared as plaintiff's counsel on Georgia magistrate-court dispossessory (eviction) calendars, along with the landlord / management-company plaintiffs they filed for. Using public web sources (law firm websites, attorney biographies, the State Bar of Georgia member directory, LinkedIn or other professional profiles, apartment-association directories, news), find:
- the law firm, its website, the office city and county;
- a business phone number (direct line if published, otherwise the firm's main line — say which) and a published business email;
- how the firm describes its landlord-tenant / eviction practice and any named property-management or apartment-community clients.
Rules: copy phone numbers and emails only from pages you cite; never infer an email; cite every URL you rely on; if you cannot confidently match the person, set found=false rather than guessing; never include anything about tenants or defendants. Return only JSON matching the schema.`;

export function enrichUserPrompt(lead) {
  const lines = [`Attorney: ${lead.attorney_name}`];
  if (lead.firm_name) lines.push(`Firm (if known): ${lead.firm_name}`);
  if (lead.counties && lead.counties.length) lines.push(`Filed dispossessory cases in: ${lead.counties.join(', ')} County, Georgia`);
  if (lead.filing_count) lines.push(`Cases on recent court calendars: ${lead.filing_count}`);
  if (lead.clients_identified) lines.push(`Plaintiffs they filed for: ${lead.clients_identified}`);
  lines.push('Find their firm, contact details and how the firm markets its landlord / eviction practice. Return the JSON described by the schema.');
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
