import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvictionText, classifyForeclosureStage, shouldAdvance, isTurnoverStage, STAGE_RANK } from '../lib/stages.js';
import { scoreOpportunity, priorityBand } from '../lib/scoring.js';
import { chooseTarget, chooseContact, roleFromTitle } from '../lib/target.js';

test('writ and execution classification is conservative', () => {
  assert.equal(classifyEvictionText('Writ of Possession issued 9/1/2026').stage, 'writ_issued');
  assert.equal(classifyEvictionText('Writ delivered to Marshal for execution').stage, 'writ_pending_execution');
  assert.equal(classifyEvictionText('Eviction scheduled 09/12/2026 9am').stage, 'eviction_scheduled');
  assert.equal(classifyEvictionText('Writ returned executed; set-out completed').stage, 'eviction_executed');
  assert.equal(classifyEvictionText('Possession returned to landlord').stage, 'possession_returned');
  assert.equal(classifyEvictionText('Default judgment for plaintiff').stage, 'judgment_entered');
  assert.equal(classifyEvictionText('Dispossessory affidavit filed').stage, 'dispossessory_filed');
  assert.equal(classifyEvictionText('Case dismissed').stage, 'dismissed');
  // A filing is never "evicted"
  assert.notEqual(classifyEvictionText('Dispossessory warrant filed against tenant').stage, 'eviction_executed');
  assert.equal(classifyEvictionText(''), null);
});

test('foreclosure stage from sale date', () => {
  assert.equal(classifyForeclosureStage('2026-10-06', '2026-09-08'), 'sale_scheduled');
  assert.equal(classifyForeclosureStage('2026-09-15', '2026-09-08'), 'sale_imminent');
  assert.equal(classifyForeclosureStage('2026-09-01', '2026-09-08'), 'sale_completed');
  assert.equal(classifyForeclosureStage(null, '2026-09-08'), 'notice_published');
});

test('stage progression never regresses automatically, manual can', () => {
  assert.equal(shouldAdvance('dispossessory_filed', 'writ_issued'), true);
  assert.equal(shouldAdvance('writ_issued', 'hearing_scheduled'), false);
  assert.equal(shouldAdvance('writ_issued', 'writ_issued'), false);
  assert.equal(shouldAdvance('hearing_scheduled', 'dismissed'), true);
  assert.equal(shouldAdvance('writ_issued', 'hearing_scheduled', 'manual'), true);
  assert.equal(shouldAdvance(null, 'hearing_scheduled'), true);
  assert.ok(STAGE_RANK.eviction_scheduled > STAGE_RANK.writ_issued && STAGE_RANK.writ_issued > STAGE_RANK.dispossessory_filed);
  assert.equal(isTurnoverStage('writ_issued'), true);
  assert.equal(isTurnoverStage('dispossessory_filed'), false);
});

test('opportunity score ranks turnover evidence above raw filings and penalizes homeowner-only leads', () => {
  const base = { today: '2026-09-08', eventDate: '2026-09-10' };
  const writ = scoreOpportunity({ ...base, stage: 'writ_issued', eventType: 'eviction', propertyType: 'multifamily', manager: { companyType: 'property_management' }, target: { companyType: 'property_management', activeProperties: 4, mainPhone: '404-555-1212' }, contact: { confidence: 'high', phone: '404-555-1212', email: 'ops@example.com' } });
  const filed = scoreOpportunity({ ...base, stage: 'dispossessory_filed', eventType: 'eviction', propertyType: 'multifamily', manager: { companyType: 'property_management' }, target: { companyType: 'property_management', activeProperties: 4, mainPhone: '404-555-1212' }, contact: { confidence: 'high', phone: '404-555-1212', email: 'ops@example.com' } });
  const executed = scoreOpportunity({ ...base, stage: 'eviction_executed', eventType: 'eviction', propertyType: 'multifamily', manager: { companyType: 'property_management' }, target: { companyType: 'property_management', activeProperties: 4, mainPhone: '404-555-1212' }, contact: { confidence: 'high', phone: '404-555-1212', email: 'ops@example.com' } });
  assert.ok(writ.score > filed.score, `writ ${writ.score} > filed ${filed.score}`);
  assert.ok(executed.score > filed.score);
  assert.ok(writ.score >= 70 && filed.score < 70);
  assert.equal(priorityBand(writ.score), 'high');
  assert.ok(writ.breakdown.some(b => b.factor === 'portfolio'));

  const homeowner = scoreOpportunity({ ...base, stage: 'sale_scheduled', eventType: 'foreclosure', eventDate: '2026-10-06', owner: { name: 'JANE DOE', isEntity: false }, target: null, contact: null });
  const corporate = scoreOpportunity({ ...base, stage: 'sale_scheduled', eventType: 'foreclosure', eventDate: '2026-10-06', owner: { name: 'ABC HOLDINGS LLC', isEntity: true, companyType: 'owner_entity' }, target: { companyType: 'owner_entity', activeProperties: 1, mainPhone: '770-555-0000' } });
  assert.ok(homeowner.score < corporate.score);
  assert.ok(homeowner.breakdown.some(b => b.factor === 'homeowner_only'));
  assert.ok(homeowner.score >= 0 && corporate.score <= 100);
});

test('target hierarchy prefers operators over owners, never law firms or individuals', () => {
  const pm = { id: 'pm', name: 'Acme Property Management', company_type: 'property_management', contacts: [{ name: 'A', title: 'Regional Manager', role_category: 'regional_manager', confidence: 'medium', phone: '1' }] };
  const owner = { id: 'own', name: 'Holdings LLC', company_type: 'owner_entity', contacts: [] };
  const firm = { id: 'lf', name: 'Law LLP', company_type: 'law_firm', contacts: [{ name: 'L', confidence: 'high', phone: '2' }] };
  const person = { id: 'p', name: 'John Smith', company_type: 'individual', is_individual: true, contacts: [] };
  const r = chooseTarget({ eventType: 'eviction', stage: 'writ_issued', companies: [
    { company: owner, relationship: 'owner', confidence: 'high' }, { company: pm, relationship: 'plaintiff', confidence: 'high' }, { company: firm, relationship: 'law_firm', confidence: 'high' } ] });
  assert.equal(r.company.id, 'pm');
  assert.equal(r.contact.name, 'A');
  const r2 = chooseTarget({ eventType: 'eviction', stage: 'writ_issued', companies: [{ company: firm, relationship: 'law_firm', confidence: 'high' }, { company: person, relationship: 'plaintiff', confidence: 'high' }] });
  assert.equal(r2.company, null);
  const post = chooseTarget({ eventType: 'foreclosure', stage: 'sale_completed', companies: [{ company: { id: 'sv', name: 'Servicer Inc', company_type: 'servicer', contacts: [] }, relationship: 'servicer', confidence: 'high' }, { company: owner, relationship: 'owner', confidence: 'high' }] });
  assert.equal(post.company.id, 'sv');
});

test('contact choice weighs role and confidence; titles map to roles', () => {
  const best = chooseContact([
    { name: 'CEO', role_category: 'executive', confidence: 'high', phone: '1', email: 'a' },
    { name: 'Regional', role_category: 'regional_manager', confidence: 'medium', phone: '1', email: 'b' },
    { name: 'Onsite', role_category: 'onsite_manager', confidence: 'low' },
  ]);
  assert.equal(best.name, 'Regional');
  assert.equal(roleFromTitle('Community Manager'), 'onsite_manager');
  assert.equal(roleFromTitle('VP of Operations'), 'director_operations');
  assert.equal(roleFromTitle('Registered Agent'), 'other');
});
