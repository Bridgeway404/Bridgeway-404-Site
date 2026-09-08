// Douglas County Magistrate Court. The county's civil records search
// (courts.dcga.us/WebSearchMagistrate) refuses connections from cloud
// servers and publishes no calendar PDFs, so there is nothing to retrieve
// automatically. The adapter reports itself as unavailable so the run
// record and Admin tab show it honestly; Douglas eviction cases enter the
// system through the Admin "Add case" / upload path.
export const douglasMagistrate = {
  id: 'douglas_magistrate',
  county: 'Douglas',
  label: 'Douglas Magistrate Court — civil records search',
  kind: 'eviction',
  enabledByDefault: true,
  unavailable: true,
  notes: 'courts.dcga.us/WebSearchMagistrate blocks server access and no calendars are published; add Douglas cases manually or by upload.',
  async discover() {
    return { records: [], unavailable: true, reason: 'No server-accessible public source (courts.dcga.us resets connections from cloud IPs; no published calendars).', cursor: {}, diagnostics: {} };
  },
};
