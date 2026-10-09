'use strict';

const aliasRows = [
  { type: 'area', alias: 'BB', canonical: 'Business Bay', parent_area: null, enabled: true },
  { type: 'area', alias: 'M.J.L', canonical: 'Madinat Jumeirah Living', parent_area: null, enabled: true },
  { type: 'area', alias: 'MJL', canonical: 'Madinat Jumeirah Living', parent_area: null, enabled: true },
  { type: 'building', alias: 'P4', canonical: 'Peninsula Four', parent_area: 'Business Bay', enabled: true },
  { type: 'property_type', alias: 'Flat', canonical: 'Apartment', parent_area: null, enabled: true },
  { type: 'property_type', alias: 'Apt', canonical: 'Apartment', parent_area: null, enabled: true },
];

module.exports = { aliasRows };
