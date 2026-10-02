export const DEFAULT_PACKAGE_NAME = 'common';

export const PACKAGE_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,2}$/;

export const PACKAGE_LABELS = {
  common: '通用',
  risk_control: '风控',
  credit_risk: '信贷风控',
  eligibility: '准入',
  pricing: '定价',
  uncategorized: '未分类',
};

const LEGACY_PACKAGE_NAMES = {
  通用: 'common',
  风控: 'risk_control',
  信贷风控: 'credit_risk',
  准入: 'eligibility',
  定价: 'pricing',
  未分类: 'uncategorized',
};

export function canonicalPackageName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  return LEGACY_PACKAGE_NAMES[value] || value;
}

export function packageLabel(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  return PACKAGE_LABELS[canonicalPackageName(value)] || value;
}
