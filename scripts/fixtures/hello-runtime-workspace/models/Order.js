'use strict';

const fields = [
  {
    "name": "customerName",
    "type": "string",
    "required": false,
    "hasDefault": false,
    "defaultValue": null
  },
  {
    "name": "Required",
    "type": "string",
    "required": true,
    "hasDefault": false,
    "defaultValue": null
  }
];
const records = [];
let nextId = 1;

function validate(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, errors: ['A JSON object is required.'] };
  if (typeof payload["Required"] !== 'string' || payload["Required"].trim() === '') errors.push("Required is required.");
  return { valid: errors.length === 0, errors };
}

function applyDefaults(payload) {
  const value = { ...payload };
  for (const field of fields) if (value[field.name] === undefined && field.hasDefault) value[field.name] = field.defaultValue;

  return value;
}

function create(payload) {
  const value = applyDefaults(payload);
  value.id = String(nextId++);
    
  records.push(value);
  return { ...value };
}

function list() {
  return records.map((record) => ({ ...record }));
}

module.exports = { fields, validate, applyDefaults, create, list };
