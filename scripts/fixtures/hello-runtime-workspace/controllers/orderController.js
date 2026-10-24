'use strict';

const schema = require("../models/Order.js");
const requestedFieldContract = [
  "customerName",
  "Required"
];

async function handleOrder(request) {
  try {
    const validation = schema.validate(request.body, requestedFieldContract);
    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };
    return { status: 201, body: { data: schema.create(request.body) } };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };
  }
}

async function listOrder() {
  try {
    return { status: 200, body: { data: schema.list() } };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };
  }
}

module.exports = { handleOrder, listOrder };
