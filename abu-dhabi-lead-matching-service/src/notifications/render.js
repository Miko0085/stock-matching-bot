'use strict';

// Abu Dhabi's own notification rendering -- reuses dubai-lead-matching-
// service's buildNotificationMessages/formatMatchEntry etc. AS-IS, not
// just the generic header helpers like rf-lead-matching-service does:
// Dubai's formatMatchEntry already reads the raw stock row fields
// directly (match.building/project_community/area/bedrooms/
// transaction_type + transaction-semantics.js's priceFieldForStock), and
// Abu Dhabi's stock_inventory has the exact same column shape -- no
// Abu-Dhabi-specific formatting is needed, unlike Moscow's own
// district/complex/комнаты/RUB fields.
module.exports = require('../../../dubai-lead-matching-service/src/notifications/render');
