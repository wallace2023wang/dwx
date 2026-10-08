ALTER TABLE projects
ADD COLUMN IF NOT EXISTS approval_policy jsonb NOT NULL DEFAULT '{"requiredApprovals":1,"requireComment":false,"preventSelfApproval":true,"allowedReviewerRoles":["reviewer","admin"]}'::jsonb;
