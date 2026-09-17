import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDouglasTaxSale, parseHenryTaxSale, looksScanned } from '../lib/parsers.js';

const DOUGLAS = `______________
<Publish before descriptions>
DELINQUENT PROPERTY TAX SALE <(Bold)
Under and by virtue of certain tax fi fa's issued by the Tax Commissioner of Douglas County,
Georgia, ... on the first Tuesday in June, 2026, the same
being June 2, 2026, and continuing on Wednesday, June 3, 2026, if necessary, between the legal hours of
sale, 10:00 AM and 4:00 PM.
_____________________________________________________________________________________
_
MAP AND PARCEL: 00300250045
CURRENT RECORD HOLDER: ABDUL-HAQQ NAJIB & AISHAH
DEFENDANT IN FI-FA: SAME AS CRH(S)
AMOUNT DUE: $3,488.66
TAX YEARS DUE: 2025
DEED BOOK: 1729/705
LEGAL DESCRIPTION: ALL THAT TRACT OF LAND BEING IN LAND LOT 30, 2ND DISTRICT,
5TH SECTION, IN DOUGLAS COUNTY, GEORGIA, BEING LOT 31, UNIT 1, OF SHALLOWFORD
HEIGHTS SUBDIVISION, AS SHOWN IN PLAT BOOK 7, PAGE 144. 5240 KINGS HWY
MAP AND PARCEL: 0049015A104

=====PAGE=====

CURRENT RECORD HOLDER: ABZ PROPERTIES LLC
DEFENDANT IN FI-FA: SAME AS CRH(S)
AMOUNT DUE: $1,657.02
TAX YEARS DUE: 2025
DEED BOOK: 4112/860
LEGAL DESCRIPTION: ALL THAT TRACT OF LAND BEING IN LAND LOT 49, 1ST DISTRICT,
5TH SECTION, DOUGLAS COUNTY, GEORGIA, BEING LOT 64, OF THE MEADOWS AND
STONEBRIDGE SUBDIVISION, AS SHOWN IN PLAT BOOK 17, PAGE 191. 9021 STONELEIGH
TRCE
MAP AND PARCEL: 01590250027
CURRENT RECORD HOLDER: ARBOR CONNECTION LLC
DEFENDANT IN FI-FA: SAME AS CRH(S)
AMOUNT DUE: $80,268.24
TAX YEARS DUE: 2025
DEED BOOK: 3009/531
LEGAL DESCRIPTION: ALL THAT TRACT OF LAND BEING IN LAND LOT 159, 2ND DISTRICT,
5TH SECTION, IN DOUGLAS COUNTY, GEORGIA. 7475 DOUGLAS BLVD
`;

test('Douglas tax sale legal: sale date, parcels, holders, amounts, addresses across page breaks', () => {
  const out = parseDouglasTaxSale(DOUGLAS);
  assert.equal(out.saleDate, '2026-06-02');
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items.map(i => i.parcel_id), ['00300250045', '0049015A104', '01590250027']);
  assert.equal(out.items[0].list_owner_name, 'ABDUL-HAQQ NAJIB & AISHAH');
  assert.equal(out.items[0].amount_due, 3488.66);
  assert.equal(out.items[0].address, '5240 KINGS HWY');
  assert.equal(out.items[1].list_owner_name, 'ABZ PROPERTIES LLC');
  assert.equal(out.items[1].address, '9021 STONELEIGH TRCE');
  assert.equal(out.items[2].address, '7475 DOUGLAS BLVD');
  assert.equal(out.items[2].amount_due, 80268.24);
  assert.equal(out.items[2].deed_book, '3009/531');
  assert.deepEqual(out.diagnostics, []);
});

test('Douglas parser reports a scanned / foreign document instead of throwing', () => {
  const out = parseDouglasTaxSale('just some text without blocks');
  assert.equal(out.items.length, 0);
  assert.ok(out.diagnostics.length);
  assert.ok(looksScanned('', 5));
  assert.ok(!looksScanned(DOUGLAS, 1));
});

const HENRY = `PROPERTIES FOR JUDICAL REM TAX SALE TUESDAY OCTOBER 6TH 2026
PAYMENT IS REQUIRED AT THE TIME OF SALE AND ALL SALES ARE FINAL.
Parcel Number Name Location Sale Date Amount Owed
M01502012000 FRESH MACHINE LLC 1110 WHISPER WIND DR MCD 10/06/2026 Click Here
146A03072000 SMITH-DAVIS CARLA 232 STONEWALL LN LG 10/06/2026 Click Here
006A07016000 PERRY JAMES W 165 DAVID RD HAMPTON 10/06/2026 Click Here
044-01016000 WINSTON DONNIE G 376 SCARBOROUGH RD ELLENWOOD 10/06/2026 Click Here
These are BUYER BEWARE sales!`;

test('Henry tax sale list: rows with parcel, owner, address and sale date', () => {
  const out = parseHenryTaxSale(HENRY);
  assert.equal(out.saleDate, '2026-10-06');
  assert.equal(out.items.length, 4);
  assert.equal(out.items[0].parcel_id, 'M01502012000');
  assert.equal(out.items[0].list_owner_name, 'FRESH MACHINE LLC');
  assert.equal(out.items[0].address, '1110 WHISPER WIND DR MCD');
  assert.equal(out.items[3].parcel_id, '044-01016000');
  assert.equal(out.items[3].list_owner_name, 'WINSTON DONNIE G');
  assert.equal(out.items[1].sale_date, '2026-10-06');
});

import { parseDekalbExcessFunds, parseDouglasExcessFunds, splitPurchaser, parseDekalbTaxSaleHtml } from '../lib/parsers.js';

test('DeKalb excess funds list: sold parcels with sale date, prior owner and situs address', () => {
  const txt = `EXCESS FUNDS
As of 9/3/2026
PARCEL ID EXCESS AMOUNT SALEDATE FIRST NAME MIDDLE LAST NAME SITUS ADDRESS CITY ZIP CODE
16 152 11 020 $16,223.28 10/7/2025 CALVIN CHAN 7163 SWIFT ST LITHONIA 30058
18 106 13 058 $166,919.03 11/4/2025 DAVID E. AND MARK H SCHMITT 1276 WEATHERSTONE DR NE ATLANTA 30324
16 009 03 023 $220.27 4/7/2026 LAKESIDE OF DEKALB INC 2766 SHELL BARK ROAD DECATUR 30035
18 046 03 067 $3,666.45 4/7/2026 UNKNOWN OWNER - UNRETURNED PROPERTY 3180 altacrest dr SCOTTDALE 30079
Page 4

=====PAGE=====

EXCESS FUNDS
15 178 05 037 $1,965.29 7/7/2026 MAYNARD TERRACE LOFT TOWNHOMES INC 241 MAYNARD TER 37 ATLANTA 30317`;
  const out = parseDekalbExcessFunds(txt);
  assert.equal(out.asOf, '2026-09-03');
  assert.equal(out.items.length, 5);
  assert.equal(out.items[0].parcel_id, '16 152 11 020');
  assert.equal(out.items[0].sale_date, '2025-10-07');
  assert.equal(out.items[0].list_owner_name, 'CALVIN CHAN');
  assert.equal(out.items[0].address, '7163 SWIFT ST');
  assert.equal(out.items[0].city, 'LITHONIA');
  assert.equal(out.items[1].list_owner_name, 'DAVID E. AND MARK H SCHMITT');
  assert.equal(out.items[1].address, '1276 WEATHERSTONE DR NE');
  assert.equal(out.items[2].address, '2766 SHELL BARK ROAD');
  assert.equal(out.items[3].list_owner_name, 'UNKNOWN OWNER - UNRETURNED PROPERTY');
  assert.equal(out.items[4].sale_date, '2026-07-07');
});

test('Douglas overage file: purchaser column is parsed and split into entity / principal', () => {
  const txt = `TAX SALES 2000 -FORWARD OVERAGE
SALE DATE DEL TAXPAYER NAME PARCEL# YEARS OPEN PURCHASER SALE PRICE OVERAGE CLAIMED
REAL ESTATE
12/5/2023 MASUD, MOHAMMAD 01310250010 2022-2023 JORGIE TAMAYO $142,025.00 $134,215.22 YES
12/3/2024 DONNA SUE WHITE CC000000023U 2024 DON HUDGINS $1,700.00 $1,188.69 YES
8/5/2025 CARLSEN, DAVID ALLEN & MEGAN KELSEY 03321820029 2022-2024 TRANQUIL STAYS, LLC / STEPHANIE MONIQUE ANGWENYI$2,300.00 $1,710.39 NO
8/5/2025 VARNER, DEBBIE M ESTATE AND ALL HEIRS KNOWN AND UNKNOWN 07320130011 2022-2024 MKIM RD LLC / MAXMILLIAN SUN KIM $89,000.00 $76,196.31 NO
8/5/2025 MEZICK LINDA ESTATE AND ALL HEIRS KNOWN AND UNKNOWN 08421820033 2022-2024 LARITA JONES & OMARI BENJAMIN $10,500.00 $8,357.85 NO
12/2/2003 FRANKLIN, MORAN & BOYLE 0017015B010 1999 & 2000 DONALD R STALLWORTH $40.00 NONE N/A`;
  const out = parseDouglasExcessFunds(txt);
  assert.equal(out.items.length, 6);
  const v = out.items.find(i => i.parcel_id === '07320130011');
  assert.equal(v.sale_date, '2025-08-05');
  assert.equal(v.purchaser, 'MKIM RD LLC / MAXMILLIAN SUN KIM');
  assert.equal(v.sale_price, 89000);
  assert.equal(v.tax_years, '2022-2024');
  assert.deepEqual(splitPurchaser(v.purchaser), { entity: 'MKIM RD LLC', person: 'MAXMILLIAN SUN KIM' });
  const t = out.items.find(i => i.parcel_id === '03321820029');
  assert.equal(t.purchaser, 'TRANQUIL STAYS, LLC / STEPHANIE MONIQUE ANGWENYI');
  assert.equal(t.sale_price, 2300);
  assert.deepEqual(splitPurchaser('LARITA JONES & OMARI BENJAMIN'), { entity: null, person: 'LARITA JONES & OMARI BENJAMIN' });
  assert.equal(out.items.find(i => i.parcel_id === '0017015B010').excess_amount, 0);
});

test('DeKalb tax sale HTML table', () => {
  const html = `<table><tr><th>Tax Sale Date</th></tr>
<tr><td>06-OCT-2026</td><td>15 004 03 090</td><td>15 004 03 090</td><td>26-R30266586-OCT</td><td>DYNAMIC EQUITIES LLC</td><td>3479 HICKORY WALK LN</td><td>DYNAMIC EQUITIES LLC</td><td>DYNAMIC EQUITIES LLC</td><td>DEK</td><td>2931</td><td>0538</td><td>14-AUG-26</td><td align="right">2011</td><td align="right">2025</td><td>$18,161.85</td></tr></table>`;
  const out = parseDekalbTaxSaleHtml(html);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].sale_date, '2026-10-06');
  assert.equal(out.items[0].parcel_id, '15 004 03 090');
  assert.equal(out.items[0].list_owner_name, 'DYNAMIC EQUITIES LLC');
  assert.equal(out.items[0].address, '3479 HICKORY WALK LN');
  assert.equal(out.items[0].amount_due, 18161.85);
});

import { parseHenryExcessFunds } from '../lib/parsers.js';
test('Henry excess funds list: sold parcels, redeemed flags and purchase amounts', () => {
  const txt = `PARCEL ID OWNER ADDRESS SALE DATE EXCESS FUNDS
S32-02005000 HAYGOOD ROBERT E & MILDRED OAKLAND BLVD 2/6/2024 5,436.96$
141I01005000 BUYSIDE CAPITAL ADVISORS LLC 209 CADES CT 6/4/2024 21,697.48$
146A03081000 MARTIN CHAROLTTE A & ROGER K 225 BOULDER LN 6/4/2024 24,029.25$ REDEEMED
066A01004000 CANTRELL RONNIE 1239/1241 FLAT ROCK RD 10/7/2025 101,873.74$
105E01085000 MOUNTIAN BROOKE LLC 710 DONNER CT, MCD 1/7/2025 NO PROCEEDS
PARCEL ID OWNER ADDRESS SALE DATE EXCESS FUNDS PURCHASE AMT
006A04002000 WOOZEVALT JEAN PIERRE LLC 350 ROBIN HOOD LN, HMPT 2/3/2026 REDEEMED $32,000.00
043A01137000 AKK INVESTMENTS LLC 101 WAVERLY BLVD, ELLENWOOD 2/3/2026 $23,602.57 $30,000.00
071-01034004 JDH PROPERTY HOLDINGS LLC HWY 42 N 6/2/2026 $2,668.77 $7,800.00`;
  const out = parseHenryExcessFunds(txt);
  assert.equal(out.items.length, 8);
  const a = out.items.find(i => i.parcel_id === '043A01137000');
  assert.equal(a.list_owner_name, 'AKK INVESTMENTS LLC');
  assert.equal(a.address, '101 WAVERLY BLVD, ELLENWOOD');
  assert.equal(a.sale_date, '2026-02-03');
  assert.equal(a.excess_amount, 23602.57);
  assert.equal(a.purchase_price, 30000);
  assert.equal(a.redeemed, false);
  assert.equal(out.items.find(i => i.parcel_id === '006A04002000').redeemed, true);
  assert.equal(out.items.find(i => i.parcel_id === '146A03081000').redeemed, true);
  assert.equal(out.items.find(i => i.parcel_id === '066A01004000').address, '1239/1241 FLAT ROCK RD');
  assert.equal(out.items.find(i => i.parcel_id === 'S32-02005000').list_owner_name, 'HAYGOOD ROBERT E & MILDRED');
  assert.equal(out.items.find(i => i.parcel_id === '105E01085000').no_proceeds, true);
});
