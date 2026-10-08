export const APPROVAL_REVIEWER_ROLES = ['reviewer', 'admin'];

export const DEFAULT_APPROVAL_POLICY = Object.freeze({
  requiredApprovals: 1,
  requireComment: false,
  preventSelfApproval: true,
  allowedReviewerRoles: APPROVAL_REVIEWER_ROLES,
});

export function normalizeApprovalPolicy(policy) {
  const roles = Array.isArray(policy?.allowedReviewerRoles)
    ? [...new Set(policy.allowedReviewerRoles.filter(role => APPROVAL_REVIEWER_ROLES.includes(role)))]
    : [...DEFAULT_APPROVAL_POLICY.allowedReviewerRoles];
  return {
    requiredApprovals: policy?.requiredApprovals === 2 ? 2 : 1,
    requireComment: policy?.requireComment === true,
    preventSelfApproval: policy?.preventSelfApproval !== false,
    allowedReviewerRoles: roles.length ? roles : [...DEFAULT_APPROVAL_POLICY.allowedReviewerRoles],
  };
}

export function validateApprovalPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return '审核策略格式无效';
  if (![1, 2].includes(policy.requiredApprovals)) return '所需批准人数只能是 1 或 2';
  if (typeof policy.requireComment !== 'boolean') return '批准意见配置无效';
  if (typeof policy.preventSelfApproval !== 'boolean') return '禁止自审配置无效';
  if (!Array.isArray(policy.allowedReviewerRoles) || !policy.allowedReviewerRoles.length) return '至少选择一个允许审核的角色';
  if (policy.allowedReviewerRoles.some(role => !APPROVAL_REVIEWER_ROLES.includes(role))) return '允许审核的角色无效';
  return null;
}
