import { inputFields } from '../shared/bom.js';

export function createFactParser({ getCurrentBom }) {
  return function parseFacts(raw, bom = getCurrentBom()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const inputs = inputFields(bom);
    if (Object.keys(raw).some(key => !inputs.some(f => f.key === key))) return null;
    const facts = {};
    for (const field of inputs) {
      const value = raw[field.key];
      if (value === undefined || value === '' || value === null) {
        if (field.required === true) return null;
        continue;
      }
      if (field.type === 'Integer') {
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) return null;
        if (field.min != null && value < field.min) return null;
        if (field.max != null && value > field.max) return null;
      } else if (field.type === 'Double') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        if (field.min != null && value < field.min) return null;
        if (field.max != null && value > field.max) return null;
      } else if (field.type === 'Boolean') {
        if (typeof value !== 'boolean') return null;
      } else if (field.type === 'String') {
        if (typeof value !== 'string' || value.length > 200) return null;
        if (field.enum && !field.enum.includes(value)) return null;
      }
      facts[field.key] = value;
    }
    return facts;
  };
}
