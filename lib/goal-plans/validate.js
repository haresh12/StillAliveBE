'use strict';
// ════════════════════════════════════════════════════════════════════════
// validate.js — hand-rolled JSON Schema validator for Plans v2.
//
// Implements the subset of JSON Schema we actually use in schemas.js:
//   • object: required[], properties
//   • array:  minItems, maxItems, items
//   • string: minLength, maxLength, enum
//   • integer/number: minimum, maximum, enum
//   • Strict mode: unknown keys on objects are stripped (not rejected).
//
// Throws `PlanSchemaError` on first violation. Single-pass, no deps.
// ════════════════════════════════════════════════════════════════════════

class PlanSchemaError extends Error {
  constructor(path, message) {
    super(`${path || '<root>'}: ${message}`);
    this.name = 'PlanSchemaError';
    this.path = path;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function _validate(value, schema, path) {
  if (!schema) return value;

  // type
  if (schema.type === 'object') {
    if (!isPlainObject(value)) throw new PlanSchemaError(path, 'expected object');
    const out = {};
    // required
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) throw new PlanSchemaError(path, `missing required key "${key}"`);
      }
    }
    // properties
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (value[key] === undefined) continue;
        out[key] = _validate(value[key], subSchema, path ? `${path}.${key}` : key);
      }
    }
    return out;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new PlanSchemaError(path, 'expected array');
    if (schema.minItems != null && value.length < schema.minItems) {
      throw new PlanSchemaError(path, `array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      throw new PlanSchemaError(path, `array length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      return value.map((item, i) => _validate(item, schema.items, `${path}[${i}]`));
    }
    return value.slice();
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new PlanSchemaError(path, 'expected string');
    if (schema.minLength != null && value.length < schema.minLength) {
      throw new PlanSchemaError(path, `string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      throw new PlanSchemaError(path, `string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new PlanSchemaError(path, `value "${value}" not in enum [${schema.enum.join(', ')}]`);
    }
    return value;
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PlanSchemaError(path, 'expected number');
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      throw new PlanSchemaError(path, 'expected integer');
    }
    if (schema.minimum != null && value < schema.minimum) {
      throw new PlanSchemaError(path, `value ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      throw new PlanSchemaError(path, `value ${value} > maximum ${schema.maximum}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new PlanSchemaError(path, `value ${value} not in enum [${schema.enum.join(', ')}]`);
    }
    return value;
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new PlanSchemaError(path, 'expected boolean');
    return value;
  }

  // Unrecognized schema type — pass through.
  return value;
}

function validate(value, schema) {
  return _validate(value, schema, '');
}

function tryValidate(value, schema) {
  try {
    return { ok: true, value: _validate(value, schema, ''), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e instanceof PlanSchemaError ? e : new PlanSchemaError('<root>', e.message) };
  }
}

module.exports = { validate, tryValidate, PlanSchemaError };
