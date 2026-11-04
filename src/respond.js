"use strict";

// A plain object return is sent by API Gateway as a 200, so errors need the explicit response shape.
function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

module.exports = { respond };
