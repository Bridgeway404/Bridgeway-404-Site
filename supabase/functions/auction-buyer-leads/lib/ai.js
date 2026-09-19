// Optional Claude helpers. The worker runs fully without them (deterministic
// parsing + public records); a saved Anthropic key only adds (a) OCR of the
// scanned Fulton levy lists and (b) business-contact lookups for purchasers.

export const ENRICH_SYSTEM = `You are a research assistant for Bridgeway 404, a metro Atlanta property cleanout company. You are given a person or company that recently bought property at a county tax sale / levy sale in Georgia. Find PUBLIC BUSINESS contact information only: a business phone number, business email, company website, a principal or acquisitions contact name, and a public business mailing address. Prefer the company's own website, the Georgia Secretary of State business search, business directories and listing sites. Do not report personal cell numbers, home addresses or anything sensitive; if the purchaser is a private individual with no business presence, say found=false. Never guess. Every detail must come from a page you actually opened; cite the URLs.`;

export const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    contact_name: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, website: { type: ['string', 'null'] },
    mailing_address: { type: ['string', 'null'] },
    buyer_type: { type: ['string', 'null'], enum: ['investor_company', 'investor_individual', 'landlord', 'flipper', 'builder', 'institutional_lender', 'servicer', 'government', 'nonprofit', 'individual', null] },
    portfolio_count: { type: ['integer', 'null'] },
    evidence: { type: ['string', 'null'] }, notes: { type: ['string', 'null'] },
    source_urls: { type: 'array', items: { type: 'string' } },
  },
  required: ['found', 'contact_name', 'phone', 'email', 'website', 'mailing_address', 'buyer_type', 'portfolio_count', 'evidence', 'notes', 'source_urls'],
};

export function enrichUserPrompt(buyer, props) {
  const lines = (props || []).slice(0, 6).map(p => `- ${p.address || 'parcel ' + p.parcel_id}, ${p.county} County, GA (${p.sale_type || 'tax sale'} ${p.sale_date || ''})`);
  return `Purchaser: ${buyer.buyer_name}${buyer.contact_name ? ' (principal: ' + buyer.contact_name + ')' : ''}${buyer.mailing_address ? '\nMailing address on the assessor roll: ' + buyer.mailing_address : ''}\nRecent auction acquisitions:\n${lines.join('\n') || '- (see county records)'}\n\nFind public business contact details for this purchaser in Georgia. Return JSON only.`;
}

export const OCR_SYSTEM = `You read scanned county sheriff levy (tax) sale lists from Fulton County, Georgia. Extract every parcel row exactly as printed. Return JSON only.`;
export const OCR_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    sale_date: { type: ['string', 'null'] },
    rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { parcel_id: { type: 'string' }, owner_name: { type: ['string', 'null'] }, address: { type: ['string', 'null'] }, sale_date: { type: ['string', 'null'] } }, required: ['parcel_id', 'owner_name', 'address', 'sale_date'] } },
  },
  required: ['sale_date', 'rows'],
};

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
